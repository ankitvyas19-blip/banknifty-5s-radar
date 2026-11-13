import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

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

const SEGMENT_ENUM_TO_NAME: Record<number, DhanTickEvent['exchangeSegment']> = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
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

export class DhanClient extends EventEmitter {
  private credentials: DhanCredentials | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isIntentionalClose = false;
  private subscribedInstruments: Array<{
    ExchangeSegment: 'IDX_I' | 'NSE_FNO';
    SecurityId: string;
  }> = [];

  private optionContracts: OptionContractInfo[] = [];
  private scripLoadedAt = 0;

  public wsConnected = false;
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

  /**
   * Loads BANKNIFTY OPTIDX contracts from Dhan's NSE_FNO instrument CSV
   * so any strike (e.g. 61300 CE / 61300 PE) resolves reliably to SecurityId.
   */
  public async ensureScripMasterLoaded(force = false): Promise<OptionContractInfo[]> {
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    if (!force && this.optionContracts.length > 0 && Date.now() - this.scripLoadedAt < twelveHoursMs) {
      return this.optionContracts;
    }

    const urls = [
      'https://api.dhan.co/v2/instrument/NSE_FNO',
      'https://images.dhan.co/api-data/api-scrip-master-detailed.csv',
    ];

    let csvText = '';
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
        csvText = await res.text();
        if (csvText.length > 1000) break;
      } catch (err) {
        lastFetchErr = err instanceof Error ? err.message : String(err);
      }
    }

    if (!csvText) {
      if (lastFetchErr) this.lastError = `Scrip master fetch failed: ${lastFetchErr}`;
      return this.optionContracts;
    }

    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) return this.optionContracts;

    const header = parseCsvRow(lines[0]).map((h) => h.toUpperCase());
    const colIdx = (names: string[]): number => {
      for (const n of names) {
        const idx = header.indexOf(n);
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const idxSecId = colIdx(['SECURITY_ID', 'SEM_SMST_SECURITY_ID']);
    const idxUnderlying = colIdx(['UNDERLYING_SYMBOL', 'SYMBOL_NAME', 'SM_SYMBOL_NAME']);
    const idxInst = colIdx(['INSTRUMENT', 'SEM_INSTRUMENT_NAME', 'INSTRUMENT_TYPE']);
    const idxExpiry = colIdx(['SM_EXPIRY_DATE', 'EXPIRY_DATE']);
    const idxStrike = colIdx(['STRIKE_PRICE', 'SEM_STRIKE_PRICE']);
    const idxOptType = colIdx(['OPTION_TYPE', 'SEM_OPTION_TYPE']);
    const idxLot = colIdx(['LOT_SIZE', 'SEM_LOT_UNITS']);
    const idxTradingSym = colIdx(['SEM_TRADING_SYMBOL', 'TRADING_SYMBOL', 'SYMBOL_NAME']);
    const idxDisplay = colIdx(['DISPLAY_NAME', 'SEM_CUSTOM_SYMBOL']);

    if (idxSecId < 0 || idxStrike < 0 || idxOptType < 0 || idxExpiry < 0) {
      this.lastError = 'Unexpected Dhan Scrip Master CSV header format';
      return this.optionContracts;
    }

    const parsed: OptionContractInfo[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.includes('BANKNIFTY') || !line.includes('OPTIDX')) continue;
      const cols = parseCsvRow(line);
      const inst = (cols[idxInst] ?? '').toUpperCase();
      if (inst !== 'OPTIDX') continue;

      const underlying = (idxUnderlying >= 0 ? cols[idxUnderlying] : '').toUpperCase();
      const disp = (idxDisplay >= 0 ? cols[idxDisplay] : '').toUpperCase();
      if (!underlying.includes('BANKNIFTY') && !disp.startsWith('BANKNIFTY')) continue;

      const optType = (cols[idxOptType] ?? '').toUpperCase();
      if (optType !== 'CE' && optType !== 'PE') continue;

      const strikePrice = Number(cols[idxStrike]);
      const securityId = cols[idxSecId];
      const expiry = (cols[idxExpiry] ?? '').slice(0, 10);
      if (!securityId || !Number.isFinite(strikePrice) || !expiry) continue;

      parsed.push({
        securityId,
        tradingSymbol: idxTradingSym >= 0 ? cols[idxTradingSym] : `BANKNIFTY ${strikePrice} ${optType}`,
        displayName: idxDisplay >= 0 ? cols[idxDisplay] : `BANKNIFTY ${expiry} ${strikePrice} ${optType}`,
        expiry,
        strikePrice,
        optionType: optType,
        lotSize: idxLot >= 0 ? Number(cols[idxLot]) || 30 : 30,
      });
    }

    if (parsed.length > 0) {
      this.optionContracts = parsed;
      this.scripLoadedAt = Date.now();
    }
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

  public connect(
    instruments: Array<{ ExchangeSegment: 'IDX_I' | 'NSE_FNO'; SecurityId: string }>
  ): void {
    if (!this.credentials) {
      this.lastError = 'Dhan credentials missing';
      return;
    }

    this.subscribedInstruments = instruments;
    this.isIntentionalClose = false;
    this.disconnect(false);

    const url =
      `wss://api-feed.dhan.co?version=2` +
      `&token=${encodeURIComponent(this.credentials.accessToken)}` +
      `&clientId=${encodeURIComponent(this.credentials.clientId)}` +
      `&authType=2`;

    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.wsConnected = true;
      this.lastError = null;
      this.sendSubscribe(this.subscribedInstruments);
      this.emit('status');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      this.parseBinaryPacket(buf);
    });

    ws.on('error', (err) => {
      this.lastError = err.message;
      this.emit('status');
    });

    ws.on('close', (code, reason) => {
      this.wsConnected = false;
      this.emit('status');
      if (!this.isIntentionalClose) {
        if (!this.lastError) {
          this.lastError = `Dhan WebSocket closed (${code}${reason ? `: ${reason.toString()}` : ''})`;
        }
        this.reconnectTimer = setTimeout(() => {
          this.connect(this.subscribedInstruments);
        }, 3000);
      }
    });
  }

  public updateSubscriptions(
    instruments: Array<{ ExchangeSegment: 'IDX_I' | 'NSE_FNO'; SecurityId: string }>
  ): void {
    this.subscribedInstruments = instruments;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribe(instruments);
    }
  }

  private sendSubscribe(
    instruments: Array<{ ExchangeSegment: 'IDX_I' | 'NSE_FNO'; SecurityId: string }>
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || instruments.length === 0) return;

    // RequestCode 17 = Subscribe Quote Packet (includes LTP, LTQ, LTT, ATP, Volume, Day OHLC)
    for (let i = 0; i < instruments.length; i += 100) {
      const batch = instruments.slice(i, i + 100);
      this.ws.send(
        JSON.stringify({
          RequestCode: 17,
          InstrumentCount: batch.length,
          InstrumentList: batch,
        })
      );
    }
  }

  public disconnect(intentional = true): void {
    this.isIntentionalClose = intentional;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ RequestCode: 12 }));
        }
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
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
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const responseCode = buf.readUInt8(offset);
      const messageLength = buf.readInt16LE(offset + 1);
      const segByte = buf.readUInt8(offset + 3);
      const securityId = String(buf.readInt32LE(offset + 4));
      const packetEnd =
        messageLength >= 8 && offset + messageLength <= buf.length
          ? offset + messageLength
          : buf.length;

      const exchangeSegment = SEGMENT_ENUM_TO_NAME[segByte] ?? 'OTHER';
      const nowSec = Math.floor(Date.now() / 1000);

      if (responseCode === 2 && packetEnd >= offset + 16) {
        // Ticker packet
        const ltp = buf.readFloatLE(offset + 8);
        const lttSec = buf.readInt32LE(offset + 12) || nowSec;
        this.lastTickAt = Date.now();
        this.emit('tick', {
          exchangeSegmentByte: segByte,
          exchangeSegment,
          securityId,
          ltp,
          lttSec,
        } satisfies DhanTickEvent);
      } else if ((responseCode === 4 || responseCode === 8) && packetEnd >= offset + 26) {
        // Quote (4) or Full (8) packet
        const ltp = buf.readFloatLE(offset + 8);
        const lttSec = buf.readInt32LE(offset + 14) || nowSec;
        const volume = buf.readInt32LE(offset + 22);
        const oi = responseCode === 8 && packetEnd >= offset + 38 ? buf.readInt32LE(offset + 34) : undefined;
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
      } else if (responseCode === 6 && packetEnd >= offset + 16) {
        // PrevClose packet
        const prevClose = buf.readFloatLE(offset + 8);
        this.emit('prevClose', {
          exchangeSegment,
          securityId,
          prevClose,
        });
      } else if (responseCode === 50 && packetEnd >= offset + 10) {
        const disconnectCode = buf.readInt16LE(offset + 8);
        this.lastError =
          DISCONNECT_REASONS[disconnectCode] ?? `Dhan Feed Disconnected (${disconnectCode})`;
        this.emit('status');
      }

      if (messageLength < 8) break;
      offset = packetEnd;
    }
  }
}
