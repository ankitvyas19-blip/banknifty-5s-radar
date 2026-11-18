import { EventEmitter } from 'node:events';
import https from 'node:https';
import WebSocket from 'ws';
import type { Candle, FeedTransportMode } from '../shared/types.js';

export interface DhanTickEvent {
  exchangeSegmentByte: number;
  exchangeSegment: 'IDX_I' | 'NSE_FNO' | 'NSE_EQ' | 'OTHER';
  securityId: string;
  ltp: number;
  lttSec: number;
  volume?: number;
  prevClose?: number;
  oi?: number;
}

export interface OptionContractInfo {
  securityId: string;
  tradingSymbol: string;
  displayName: string;
  expiry: string;
  strikePrice: number;
  optionType: 'CE' | 'PE';
  lotSize: number;
}

export interface DhanCredentials {
  clientId: string;
  accessToken: string;
}

export interface SubscribedInstrument {
  ExchangeSegment: 'IDX_I' | 'NSE_FNO';
  SecurityId: string;
}

const SEGMENT_ENUM_TO_NAME: Record<number, DhanTickEvent['exchangeSegment']> = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
};

const SEGMENT_NAME_TO_ENUM: Record<DhanTickEvent['exchangeSegment'], number> = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  OTHER: 255,
};

const DISCONNECT_REASONS: Record<number, string> = {
  800: 'Internal Server Error (800)',
  804: 'Requested instruments exceed limit (804)',
  805: 'Too many WebSocket connections (805)',
  806: 'Data APIs not subscribed on Dhan account (806)',
  807: 'Dhan Access Token expired (807)',
  808: 'Authentication failed: invalid Client ID or Access Token (808)',
  809: 'Access Token invalid (809)',
  810: 'Client ID invalid (810)',
  813: 'Invalid SecurityId subscribed (813)',
};

/**
 * Parses CSV line safely handling quoted commas.
 */
function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parses Dhan IST `DD/MM/YYYY HH:mm:ss` strings or Unix timestamps into Unix epoch seconds.
 */
export function parseDhanLttToUnixSec(
  ltt: unknown,
  nowSec = Math.floor(Date.now() / 1000)
): number {
  if (typeof ltt === 'number' && Number.isFinite(ltt) && ltt > 1_000_000_000) {
    return Math.floor(ltt);
  }
  if (typeof ltt === 'string') {
    const trimmed = ltt.trim();
    const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
    if (match) {
      const [, dd, mm, yyyy, hh, mi, ss] = match;
      const parsedMs = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:30`);
      if (Number.isFinite(parsedMs) && parsedMs > 1_000_000_000_000) {
        return Math.floor(parsedMs / 1000);
      }
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
      return Math.floor(numeric);
    }
  }
  return nowSec;
}

/**
 * Normalizes a `/v2/marketfeed/quote` JSON payload into strongly typed ticks + previous closes.
 */
export function normalizeMarketQuoteResponse(
  json: unknown,
  nowSec = Math.floor(Date.now() / 1000)
): {
  ticks: DhanTickEvent[];
  prevCloses: Array<{
    exchangeSegment: 'IDX_I' | 'NSE_FNO';
    securityId: string;
    prevClose: number;
  }>;
} {
  const ticks: DhanTickEvent[] = [];
  const prevCloses: Array<{
    exchangeSegment: 'IDX_I' | 'NSE_FNO';
    securityId: string;
    prevClose: number;
  }> = [];

  if (!json || typeof json !== 'object') {
    return { ticks, prevCloses };
  }

  const root = json as { data?: Record<string, Record<string, Record<string, unknown>>> };
  const data = root.data;
  if (!data || typeof data !== 'object') {
    return { ticks, prevCloses };
  }

  for (const segment of ['IDX_I', 'NSE_FNO'] as const) {
    const bucket = data[segment];
    if (!bucket || typeof bucket !== 'object') continue;

    for (const [securityId, rawQuote] of Object.entries(bucket)) {
      if (!rawQuote || typeof rawQuote !== 'object') continue;
      const ltp = Number(rawQuote.last_price);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;

      const lttSec = parseDhanLttToUnixSec(rawQuote.last_trade_time, nowSec);
      const rawVol = Number(rawQuote.volume);
      const rawOi = Number(rawQuote.oi);
      const ohlc = rawQuote.ohlc as { close?: unknown } | undefined;
      const rawPrevClose = Number(ohlc?.close);
      const prevClose = Number.isFinite(rawPrevClose) && rawPrevClose > 0 ? rawPrevClose : undefined;

      if (prevClose != null) {
        prevCloses.push({ exchangeSegment: segment, securityId, prevClose });
      }

      ticks.push({
        exchangeSegmentByte: SEGMENT_NAME_TO_ENUM[segment],
        exchangeSegment: segment,
        securityId,
        ltp,
        lttSec,
        volume: Number.isFinite(rawVol) && rawVol >= 0 ? rawVol : undefined,
        oi: Number.isFinite(rawOi) && rawOi >= 0 ? rawOi : undefined,
        prevClose,
      });
    }
  }

  return { ticks, prevCloses };
}

export class DhanClient extends EventEmitter {
  private credentials: DhanCredentials | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private restPollTimer: NodeJS.Timeout | null = null;
  private restPollInFlight = false;
  private isIntentionalClose = false;
  private wsFailureCount = 0;
  private subscribedInstruments: SubscribedInstrument[] = [];
  private prevCloseCache = new Map<string, number>();

  private optionContracts: OptionContractInfo[] = [];
  private scripLoadedAt = 0;
  private scripLoadPromise: Promise<OptionContractInfo[]> | null = null;

  public wsConnected = false;
  public transportMode: FeedTransportMode = 'IDLE';
  public lastTickAt: number | null = null;
  public lastError: string | null = null;

  constructor() {
    super();
    const envClient = process.env.DHAN_CLIENT_ID?.trim();
    const envToken = process.env.DHAN_ACCESS_TOKEN?.trim();
    if (envClient && envToken) {
      this.credentials = { clientId: envClient, accessToken: envToken };
    }
  }

  public hasCredentials(): boolean {
    return Boolean(this.credentials?.clientId && this.credentials?.accessToken);
  }

  public getClientIdMasked(): string {
    if (!this.credentials?.clientId) return 'Not configured';
    const id = this.credentials.clientId;
    if (id.length <= 4) return '****';
    return `${id.slice(0, 3)}***${id.slice(-3)}`;
  }

  public getScripCount(): number {
    return this.optionContracts.length;
  }

  public setCredentials(clientId: string, accessToken: string): void {
    this.credentials = {
      clientId: clientId.trim(),
      accessToken: accessToken.trim(),
    };
    this.lastError = null;
  }

  public getCredentialsForPersistence(): DhanCredentials | null {
    return this.credentials ? { ...this.credentials } : null;
  }

  /**
   * Loads BANKNIFTY OPTIDX contracts from Dhan's NSE_FNO instrument CSV using a streaming reader
   * so the 16MB CSV is never retained in V8 heap memory.
   */
  public async ensureScripMasterLoaded(force = false): Promise<OptionContractInfo[]> {
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    if (!force && this.optionContracts.length > 0 && Date.now() - this.scripLoadedAt < twelveHoursMs) {
      return this.optionContracts;
    }
    if (!force && this.scripLoadPromise) {
      return this.scripLoadPromise;
    }

    const loadTask = this.loadScripMasterStreaming().finally(() => {
      if (this.scripLoadPromise === loadTask) {
        this.scripLoadPromise = null;
      }
    });
    this.scripLoadPromise = loadTask;
    return loadTask;
  }

  private async loadScripMasterStreaming(): Promise<OptionContractInfo[]> {
    const urls = [
      'https://api.dhan.co/v2/instrument/NSE_FNO',
      'https://images.dhan.co/api-data/api-scrip-master-detailed.csv',
    ];

    let lastFetchErr: string | null = null;

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: this.credentials
            ? {
                'access-token': this.credentials.accessToken,
                'client-id': this.credentials.clientId,
              }
            : undefined,
        });
        if (!res.ok) {
          lastFetchErr = `HTTP ${res.status} from ${url}`;
          continue;
        }
        if (!res.body) {
          lastFetchErr = `Empty body from ${url}`;
          continue;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let carry = '';
        let headerParsed = false;
        let idxSecId = -1;
        let idxUnderlying = -1;
        let idxInst = -1;
        let idxExpiry = -1;
        let idxStrike = -1;
        let idxOptType = -1;
        let idxLot = -1;
        let idxTradingSym = -1;
        let idxDisplay = -1;
        const parsed: OptionContractInfo[] = [];

        const processLine = (rawLine: string): boolean => {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (!headerParsed) {
            if (!line) return true;
            const header = parseCsvRow(line).map((h) => h.toUpperCase());
            const colIdx = (names: string[]): number => {
              for (const n of names) {
                const idx = header.indexOf(n);
                if (idx >= 0) return idx;
              }
              return -1;
            };
            idxSecId = colIdx(['SECURITY_ID', 'SEM_SMST_SECURITY_ID']);
            idxUnderlying = colIdx(['UNDERLYING_SYMBOL', 'SYMBOL_NAME', 'SM_SYMBOL_NAME']);
            idxInst = colIdx(['INSTRUMENT', 'SEM_INSTRUMENT_NAME', 'INSTRUMENT_TYPE']);
            idxExpiry = colIdx(['SM_EXPIRY_DATE', 'EXPIRY_DATE']);
            idxStrike = colIdx(['STRIKE_PRICE', 'SEM_STRIKE_PRICE']);
            idxOptType = colIdx(['OPTION_TYPE', 'SEM_OPTION_TYPE']);
            idxLot = colIdx(['LOT_SIZE', 'SEM_LOT_UNITS']);
            idxTradingSym = colIdx(['SEM_TRADING_SYMBOL', 'TRADING_SYMBOL', 'SYMBOL_NAME']);
            idxDisplay = colIdx(['DISPLAY_NAME', 'SEM_CUSTOM_SYMBOL']);
            headerParsed = true;
            if (idxSecId < 0 || idxStrike < 0 || idxOptType < 0 || idxExpiry < 0) {
              lastFetchErr = 'Unexpected Dhan Scrip Master CSV header format';
              return false;
            }
            return true;
          }

          if (!line || !line.includes('BANKNIFTY') || !line.includes('OPTIDX')) return true;
          const cols = parseCsvRow(line);
          const inst = (cols[idxInst] ?? '').toUpperCase();
          if (inst !== 'OPTIDX') return true;

          const underlying = (idxUnderlying >= 0 ? cols[idxUnderlying] : '').toUpperCase();
          const disp = (idxDisplay >= 0 ? cols[idxDisplay] : '').toUpperCase();
          if (!underlying.includes('BANKNIFTY') && !disp.startsWith('BANKNIFTY')) return true;

          const optType = (cols[idxOptType] ?? '').toUpperCase();
          if (optType !== 'CE' && optType !== 'PE') return true;

          const strikePrice = Number(cols[idxStrike]);
          const securityId = cols[idxSecId];
          const expiry = (cols[idxExpiry] ?? '').slice(0, 10);
          if (!securityId || !Number.isFinite(strikePrice) || !expiry) return true;

          parsed.push({
            securityId,
            tradingSymbol: idxTradingSym >= 0 ? cols[idxTradingSym] : `BANKNIFTY ${strikePrice} ${optType}`,
            displayName: idxDisplay >= 0 ? cols[idxDisplay] : `BANKNIFTY ${expiry} ${strikePrice} ${optType}`,
            expiry,
            strikePrice,
            optionType: optType,
            lotSize: idxLot >= 0 ? Number(cols[idxLot]) || 30 : 30,
          });
          return true;
        };

        let headerBad = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          carry += decoder.decode(value, { stream: true });
          let start = 0;
          let nl = carry.indexOf('\n', start);
          while (nl !== -1) {
            if (!processLine(carry.slice(start, nl))) {
              headerBad = true;
              break;
            }
            start = nl + 1;
            nl = carry.indexOf('\n', start);
          }
          if (headerBad) {
            await reader.cancel().catch(() => {});
            break;
          }
          carry = start > 0 ? carry.slice(start) : carry;
        }

        if (!headerBad) {
          carry += decoder.decode();
          if (carry.length > 0) {
            processLine(carry);
          }
        }

        if (parsed.length > 0) {
          this.optionContracts = parsed;
          this.scripLoadedAt = Date.now();
          return this.optionContracts;
        }
      } catch (err) {
        lastFetchErr = err instanceof Error ? err.message : String(err);
      }
    }

    if (lastFetchErr) this.lastError = `Scrip master fetch failed: ${lastFetchErr}`;
    return this.optionContracts;
  }

  public async fetchBankNiftyExpiries(): Promise<string[]> {
    // Try official Option Chain Expiry List first if credentials exist
    if (this.credentials) {
      try {
        const res = await fetch('https://api.dhan.co/v2/optionchain/expirylist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'access-token': this.credentials.accessToken,
            'client-id': this.credentials.clientId,
          },
          body: JSON.stringify({
            UnderlyingScrip: 25,
            UnderlyingSeg: 'IDX_I',
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as { status?: string; data?: string[] };
          if (Array.isArray(json.data) && json.data.length > 0) {
            return json.data;
          }
        }
      } catch {
        // Fallback to scrip master below
      }
    }

    await this.ensureScripMasterLoaded();
    const today = new Date().toISOString().slice(0, 10);
    const set = new Set<string>();
    for (const c of this.optionContracts) {
      if (c.expiry >= today) set.add(c.expiry);
    }
    return Array.from(set).sort();
  }

  public async resolveBankNiftyOption(params: {
    strikePrice: number;
    optionType: 'CE' | 'PE';
    expiry?: string;
  }): Promise<OptionContractInfo | null> {
    await this.ensureScripMasterLoaded();
    if (this.optionContracts.length === 0) return null;

    const today = new Date().toISOString().slice(0, 10);
    const candidates = this.optionContracts.filter(
      (c) =>
        c.optionType === params.optionType &&
        Math.abs(c.strikePrice - params.strikePrice) < 0.01 &&
        c.expiry >= today
    );

    if (candidates.length === 0) return null;
    if (params.expiry) {
      const exact = candidates.find((c) => c.expiry === params.expiry);
      if (exact) return exact;
    }

    candidates.sort((a, b) => a.expiry.localeCompare(b.expiry));
    return candidates[0];
  }

  /**
   * Fetches today's recent 1-minute NSE intraday candles via Dhan REST API
   * so `prev1mLow` & `atr1m` are accurate immediately on live startup.
   */
  public async fetchRecent1mCandles(params: {
    exchangeSegment: 'IDX_I' | 'NSE_FNO';
    securityId: string;
    instrument: 'INDEX' | 'OPTIDX';
    limit?: number;
  }): Promise<Candle[]> {
    if (!this.credentials || params.securityId.startsWith('SIM_')) return [];

    const todayIst = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
    const fromDate = `${todayIst} 09:15:00`;
    const toDate = `${todayIst} 15:30:00`;

    try {
      let json: {
        timestamp?: number[];
        open?: number[];
        high?: number[];
        low?: number[];
        close?: number[];
        volume?: number[];
      } | null = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch('https://api.dhan.co/v2/charts/intraday', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'access-token': this.credentials.accessToken,
            'client-id': this.credentials.clientId,
          },
          body: JSON.stringify({
            securityId: params.securityId,
            exchangeSegment: params.exchangeSegment,
            instrument: params.instrument,
            interval: '1',
            oi: false,
            fromDate,
            toDate,
          }),
        });
        if (res.status === 429 && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
          continue;
        }
        if (!res.ok) return [];
        json = (await res.json()) as {
          timestamp?: number[];
          open?: number[];
          high?: number[];
          low?: number[];
          close?: number[];
          volume?: number[];
        };
        break;
      }

      if (!json) return [];

      const ts = json.timestamp;
      if (!Array.isArray(ts) || ts.length === 0) return [];

      const out: Candle[] = [];
      for (let i = 0; i < ts.length; i++) {
        const time = Number(ts[i]);
        const open = Number(json.open?.[i]);
        const high = Number(json.high?.[i]);
        const low = Number(json.low?.[i]);
        const close = Number(json.close?.[i]);
        const volume = Number(json.volume?.[i] ?? 0);
        if (
          !Number.isFinite(time) ||
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close)
        ) {
          continue;
        }
        out.push({
          time: Math.floor(time / 60) * 60,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? volume : 0,
        });
      }

      const limit = params.limit ?? 15;
      return out.slice(-limit);
    } catch {
      return [];
    }
  }

  /**
   * Fetches one live Market Quote batch via Dhan REST v2 (`POST /v2/marketfeed/quote`),
   * emitting any changed previous closes cleanly.
   */
  public async fetchMarketQuotesOnce(
    instruments: SubscribedInstrument[] = this.subscribedInstruments
  ): Promise<{
    ok: boolean;
    ticks: DhanTickEvent[];
    statusCode?: number;
    errorMessage?: string;
  }> {
    if (!this.credentials) {
      return { ok: false, ticks: [], errorMessage: 'Dhan credentials missing' };
    }
    if (instruments.length === 0) {
      return { ok: true, ticks: [] };
    }

    const body: Record<string, number[]> = {};
    for (const inst of instruments) {
      const idNum = Number(inst.SecurityId);
      if (!Number.isFinite(idNum) || idNum <= 0) continue;
      if (!body[inst.ExchangeSegment]) body[inst.ExchangeSegment] = [];
      if (!body[inst.ExchangeSegment].includes(idNum)) {
        body[inst.ExchangeSegment].push(idNum);
      }
    }

    if (Object.keys(body).length === 0) {
      return { ok: true, ticks: [] };
    }

    try {
      const res = await fetch('https://api.dhan.co/v2/marketfeed/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'access-token': this.credentials.accessToken,
          'client-id': this.credentials.clientId,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          ticks: [],
          statusCode: res.status,
          errorMessage: `Dhan Market Quote HTTP ${res.status}${text ? `: ${text.slice(0, 140)}` : ''}`,
        };
      }

      const json = (await res.json()) as unknown;
      const { ticks, prevCloses } = normalizeMarketQuoteResponse(json);

      for (const pc of prevCloses) {
        const cacheKey = `${pc.exchangeSegment}:${pc.securityId}`;
        if (this.prevCloseCache.get(cacheKey) !== pc.prevClose) {
          this.prevCloseCache.set(cacheKey, pc.prevClose);
          this.emit('prevClose', pc);
        }
      }

      return { ok: true, ticks, statusCode: res.status };
    } catch (err) {
      return {
        ok: false,
        ticks: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public connect(instruments: SubscribedInstrument[], transport?: 'AUTO' | 'REST'): void {
    if (!this.credentials) {
      this.lastError = 'Dhan credentials missing';
      return;
    }

    this.disconnect(false);
    this.subscribedInstruments = instruments;
    this.isIntentionalClose = false;
    this.wsFailureCount = 0;
    this.prevCloseCache.clear();

    const useRest =
      transport === 'REST' ||
      (transport !== 'AUTO' && process.env.DHAN_TRANSPORT?.toUpperCase() === 'REST');
    if (useRest) {
      this.startRestQuotePolling();
      return;
    }

    this.connectWebSocket();
  }

  private cleanupSocketOnly(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      try {
        oldWs.removeAllListeners();
        oldWs.on('error', () => {
          // Ignore close/terminate errors emitted while aborting an unestablished handshake
        });
        if (oldWs.readyState === WebSocket.OPEN) {
          oldWs.send(JSON.stringify({ RequestCode: 12 }));
          oldWs.close();
        } else if (oldWs.readyState === WebSocket.CONNECTING) {
          oldWs.terminate();
        }
      } catch {
        // ignore close errors
      }
    }
  }

  private connectWebSocket(): void {
    if (!this.credentials || this.isIntentionalClose) return;

    this.cleanupSocketOnly();

    const url =
      `wss://api-feed.dhan.co?version=2` +
      `&token=${encodeURIComponent(this.credentials.accessToken)}` +
      `&clientId=${encodeURIComponent(this.credentials.clientId)}` +
      `&authType=2`;

    const hasProxy = Boolean(
      process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy
    );

    const ws = hasProxy
      ? new WebSocket(url, { agent: https.globalAgent, perMessageDeflate: false })
      : new WebSocket(url, { perMessageDeflate: false });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.wsFailureCount = 0;
      this.transportMode = 'WEBSOCKET';
      this.wsConnected = true;
      this.lastError = null;
      this.sendSubscribe(this.subscribedInstruments);
      this.emit('status');
    });

    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      if (this.ws !== ws) return;
      const status = res.statusCode ?? 0;
      this.cleanupSocketOnly();
      if (status === 401) {
        this.wsConnected = false;
        this.transportMode = 'IDLE';
        this.lastError = 'DhanHQ HTTP 401: Invalid or expired Access Token.';
        this.emit('status');
        return;
      }
      // Proxy/firewall blocking WS upgrades (e.g. HTTP 403): switch cleanly to REST 1s Quote polling
      this.startRestQuotePolling();
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      try {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        if (!isBinary) {
          const text = buf.toString('utf8').trim();
          if (text) {
            this.lastError = `Dhan WS text: ${text.slice(0, 140)}`;
            this.emit('status');
          }
          return;
        }
        this.parseBinaryPacket(buf);
      } catch (err) {
        this.lastError = `WS packet decode warning: ${err instanceof Error ? err.message : String(err)}`;
      }
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.wsFailureCount += 1;
      this.lastError = err.message;
      if (this.wsFailureCount >= 2 && !this.isIntentionalClose) {
        this.startRestQuotePolling();
        return;
      }
      this.emit('status');
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.isIntentionalClose || this.transportMode === 'REST_QUOTE') {
        return;
      }

      this.wsConnected = false;
      this.wsFailureCount += 1;
      if (!this.lastError) {
        this.lastError = `Dhan WebSocket closed (${code}${reason ? `: ${reason.toString()}` : ''})`;
      }

      if (this.wsFailureCount >= 2) {
        this.startRestQuotePolling();
        return;
      }

      this.emit('status');
      this.reconnectTimer = setTimeout(() => {
        this.connectWebSocket();
      }, 1500);
    });
  }

  private startRestQuotePolling(): void {
    if (this.isIntentionalClose) return;
    this.cleanupSocketOnly();
    this.stopRestPollOnly();

    this.transportMode = 'REST_QUOTE';
    this.emit('status');

    void this.runRestPollCycle();
    this.restPollTimer = setInterval(() => {
      void this.runRestPollCycle();
    }, 1000);
  }

  private stopRestPollOnly(): void {
    if (this.restPollTimer) {
      clearInterval(this.restPollTimer);
      this.restPollTimer = null;
    }
    this.restPollInFlight = false;
  }

  private async runRestPollCycle(): Promise<void> {
    if (this.isIntentionalClose || this.transportMode !== 'REST_QUOTE' || this.restPollInFlight) {
      return;
    }

    this.restPollInFlight = true;
    try {
      const res = await this.fetchMarketQuotesOnce(this.subscribedInstruments);
      if (this.isIntentionalClose || this.transportMode !== 'REST_QUOTE') return;

      if (res.ok) {
        const stateChanged = !this.wsConnected || this.lastError !== null;
        this.wsConnected = true;
        this.lastError = null;
        if (res.ticks.length > 0) {
          this.lastTickAt = Date.now();
          this.emit('ticks', res.ticks);
        }
        if (stateChanged) {
          this.emit('status');
        }
      } else if (res.statusCode !== 429) {
        // Keep trying on transient rate limits, but surface real auth/network failures
        this.wsConnected = false;
        this.lastError = res.errorMessage ?? 'Dhan REST Market Quote polling failed';
        this.emit('status');
      }
    } finally {
      this.restPollInFlight = false;
    }
  }

  public updateSubscriptions(instruments: SubscribedInstrument[]): void {
    this.subscribedInstruments = instruments;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(instruments);
    } else if (this.transportMode === 'REST_QUOTE') {
      void this.runRestPollCycle();
    }
  }

  private sendSubscribe(instruments: SubscribedInstrument[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || instruments.length === 0) return;

    // RequestCode 17 = Subscribe Quote Packet (includes LTP, LTQ, LTT, ATP, Volume, Day OHLC)
    for (let i = 0; i < instruments.length; i += 100) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const batch = instruments.slice(i, i + 100);
      try {
        this.ws.send(
          JSON.stringify({
            RequestCode: 17,
            InstrumentCount: batch.length,
            InstrumentList: batch,
          })
        );
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  public disconnect(intentional = true): void {
    this.isIntentionalClose = intentional;
    this.stopRestPollOnly();
    this.cleanupSocketOnly();
    this.transportMode = 'IDLE';
    this.wsConnected = false;
    this.emit('status');
  }

  /**
   * Parses DhanHQ v2 Binary Little-Endian packets:
   * Header (8 bytes):
   *   [0]     uint8   Feed Response Code (2=Ticker, 4=Quote, 5=OI, 6=PrevClose, 8=Full, 50=Disconnect)
   *   [1..2]  int16LE Message Length
   *   [3]     uint8   Exchange Segment (0=IDX_I, 1=NSE_EQ, 2=NSE_FNO)
   *   [4..7]  int32LE Security ID
   */
  private parseBinaryPacket(buf: Buffer): void {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return;
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const responseCode = buf.readUInt8(offset);
      const messageLength = buf.readInt16LE(offset + 1);
      if (messageLength < 8) break;

      const segByte = buf.readUInt8(offset + 3);
      const securityId = String(buf.readInt32LE(offset + 4));
      const packetEnd = offset + messageLength <= buf.length ? offset + messageLength : buf.length;

      const exchangeSegment = SEGMENT_ENUM_TO_NAME[segByte] ?? 'OTHER';
      const nowSec = Math.floor(Date.now() / 1000);

      if (responseCode === 2 && packetEnd >= offset + 16) {
        // Ticker packet
        const ltp = buf.readFloatLE(offset + 8);
        const rawLtt = buf.readInt32LE(offset + 12);
        const lttSec = rawLtt > 1_000_000_000 ? rawLtt : nowSec;
        if (Number.isFinite(ltp) && ltp > 0 && ltp < 10_000_000) {
          this.lastTickAt = Date.now();
          this.emit('tick', {
            exchangeSegmentByte: segByte,
            exchangeSegment,
            securityId,
            ltp,
            lttSec,
          } satisfies DhanTickEvent);
        }
      } else if ((responseCode === 4 || responseCode === 8) && packetEnd >= offset + 26) {
        // Quote (4) or Full (8) packet
        const ltp = buf.readFloatLE(offset + 8);
        const rawLtt = buf.readInt32LE(offset + 14);
        const lttSec = rawLtt > 1_000_000_000 ? rawLtt : nowSec;
        const rawVol = buf.readInt32LE(offset + 22);
        const volume = Number.isFinite(rawVol) && rawVol >= 0 ? rawVol : undefined;
        const rawOi =
          responseCode === 8 && packetEnd >= offset + 38 ? buf.readInt32LE(offset + 34) : undefined;
        const oi = rawOi != null && Number.isFinite(rawOi) && rawOi >= 0 ? rawOi : undefined;
        if (Number.isFinite(ltp) && ltp > 0 && ltp < 10_000_000) {
          this.lastTickAt = Date.now();
          this.emit('tick', {
            exchangeSegmentByte: segByte,
            exchangeSegment,
            securityId,
            ltp,
            lttSec,
            volume,
            oi,
          } satisfies DhanTickEvent);
        }
      } else if (responseCode === 6 && packetEnd >= offset + 16) {
        // PrevClose packet
        const prevClose = buf.readFloatLE(offset + 8);
        if (Number.isFinite(prevClose) && prevClose > 0 && prevClose < 10_000_000) {
          const cacheKey = `${exchangeSegment}:${securityId}`;
          if (this.prevCloseCache.get(cacheKey) !== prevClose) {
            this.prevCloseCache.set(cacheKey, prevClose);
            this.emit('prevClose', {
              exchangeSegment,
              securityId,
              prevClose,
            });
          }
        }
      } else if (responseCode === 50 && packetEnd >= offset + 10) {
        const disconnectCode = buf.readInt16LE(offset + 8);
        this.lastError =
          DISCONNECT_REASONS[disconnectCode] ?? `Dhan Feed Disconnected (${disconnectCode})`;
        this.emit('status');
      }

      offset = packetEnd;
    }
  }
}
