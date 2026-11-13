import { EventEmitter } from 'node:events';
import {
  aggregateCandles,
  computeConfluenceSignal,
  computeRadarSnapshot,
  enrichWithProbabilityLine,
  runBacktestOn5sCandles,
  runStrategyBacktest,
} from '../shared/radarMath.js';
import type {
  BacktestSummary,
  Candle,
  ConfluenceSignal,
  DataSourceMode,
  DhanStatus,
  ForecastRecord,
  InstrumentConfig,
  RadarBroadcast,
  RadarSettings,
  RadarSnapshot,
  StrategyBacktestParams,
  StrategyBacktestSummary,
  StreamKey,
  StreamPayload,
} from '../shared/types.js';
import { DhanClient, type DhanTickEvent, type SubscribedInstrument } from './dhanClient.js';
import { MarketSimulator } from './simulator.js';
import { RadarStore } from './store.js';

const ALL_KEYS: StreamKey[] = ['BANKNIFTY_SPOT', 'NIFTY_SPOT', 'CE_OPTION', 'PE_OPTION'];
const MAX_MEMORY_5S_BARS = 720; // 60 minutes of 5-second candles in hot memory

function defaultExpiryString(): string {
  // Compute nearest upcoming Wednesday/Thursday placeholder date in YYYY-MM-DD
  const d = new Date();
  const day = d.getDay();
  const daysToWed = (3 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + daysToWed);
  return d.toISOString().slice(0, 10);
}

export class EngineManager extends EventEmitter {
  private store: RadarStore;
  private dhan: DhanClient;
  private sim: MarketSimulator;

  private mode: DataSourceMode = 'SIMULATOR';
  private settings: RadarSettings;
  private configs: Record<StreamKey, InstrumentConfig>;
  private candles5s: Record<StreamKey, Candle[]> = {
    BANKNIFTY_SPOT: [],
    NIFTY_SPOT: [],
    CE_OPTION: [],
    PE_OPTION: [],
  };
  private bootstrap1m: Record<StreamKey, Candle[]> = {
    BANKNIFTY_SPOT: [],
    NIFTY_SPOT: [],
    CE_OPTION: [],
    PE_OPTION: [],
  };
  private prevCloses: Record<StreamKey, number> = {
    BANKNIFTY_SPOT: 61300,
    NIFTY_SPOT: 25620,
    CE_OPTION: 230,
    PE_OPTION: 185,
  };
  private lastSeenCumVolume: Partial<Record<StreamKey, number>> = {};
  private snapshots: Record<StreamKey, RadarSnapshot> = {} as Record<StreamKey, RadarSnapshot>;
  private confluence!: ConfluenceSignal;
  private lastPersisted5sTime: Record<StreamKey, number> = {
    BANKNIFTY_SPOT: 0,
    NIFTY_SPOT: 0,
    CE_OPTION: 0,
    PE_OPTION: 0,
  };
  private lastEvaluated1mSec: Record<StreamKey, number> = {
    BANKNIFTY_SPOT: 0,
    NIFTY_SPOT: 0,
    CE_OPTION: 0,
    PE_OPTION: 0,
  };

  private simTimer: NodeJS.Timeout | null = null;
  private lastClockMs: number = Date.now();
  private connectPromise: Promise<DhanStatus> | null = null;

  constructor(store: RadarStore) {
    super();
    this.store = store;
    this.dhan = new DhanClient();

    const saved = this.store.loadSettings();
    this.settings = {
      timeframe: saved?.timeframe ?? '5s',
      windowMinutes: saved?.windowMinutes ?? 3,
      stdDevMultiplier: saved?.stdDevMultiplier ?? 1.0,
      earlyTriggerSecond: saved?.earlyTriggerSecond ?? 55,
      ceStrike: saved?.ceStrike ?? 61300,
      peStrike: saved?.peStrike ?? 61300,
      expiry: saved?.expiry ?? defaultExpiryString(),
      ceEntryPrice: saved?.ceEntryPrice ?? null,
      peEntryPrice: saved?.peEntryPrice ?? null,
      ceLots: saved?.ceLots ?? 1,
      peLots: saved?.peLots ?? 1,
      simScenario: saved?.simScenario ?? 'USER_BULLISH_61360',
      simSpeed: saved?.simSpeed ?? 1,
      simPaused: false,
    };

    this.configs = this.buildInstrumentConfigs();
    this.sim = new MarketSimulator(
      this.settings.ceStrike,
      this.settings.peStrike,
      this.settings.simScenario
    );

    // Seed initial simulator data cleanly so snapshots and confluence exist immediately
    this.seedSimulatorHistory(this.settings.simScenario);

    this.snapshots = {
      BANKNIFTY_SPOT: this.computeSnapshotFor('BANKNIFTY_SPOT', this.lastClockMs),
      NIFTY_SPOT: this.computeSnapshotFor('NIFTY_SPOT', this.lastClockMs),
      CE_OPTION: this.computeSnapshotFor('CE_OPTION', this.lastClockMs),
      PE_OPTION: this.computeSnapshotFor('PE_OPTION', this.lastClockMs),
    };
    this.confluence = computeConfluenceSignal({
      snapshots: this.snapshots,
      configs: this.configs,
    });

    // Wire DhanHQ live events (both individual binary WS ticks and batched REST ticks)
    this.dhan.on('tick', (tick: DhanTickEvent) => this.handleDhanTickBatch([tick]));
    this.dhan.on('ticks', (ticks: DhanTickEvent[]) => this.handleDhanTickBatch(ticks));
    this.dhan.on('prevClose', (ev: { securityId: string; prevClose: number }) => {
      for (const key of ALL_KEYS) {
        if (this.configs[key].securityId === ev.securityId && ev.prevClose > 0) {
          this.prevCloses[key] = ev.prevClose;
        }
      }
    });
    this.dhan.on('status', () => {
      this.emit('broadcast', this.getFullBroadcast('TICK_UPDATE'));
    });

    // If DHAN env vars are provided & DHAN_AUTO_CONNECT=true, auto-connect
    if (this.dhan.hasCredentials() && process.env.DHAN_AUTO_CONNECT === 'true') {
      this.connectPromise = this.connectDhanLive()
        .catch((err) => {
          console.error('[BankNifty 5s Radar] Initial Dhan auto-connect error:', err);
          return this.getDhanStatus();
        })
        .finally(() => {
          this.connectPromise = null;
        });
    } else {
      this.startSimulatorLoop();
    }
  }

  private buildInstrumentConfigs(): Record<StreamKey, InstrumentConfig> {
    return {
      BANKNIFTY_SPOT: {
        key: 'BANKNIFTY_SPOT',
        label: 'Bank Nifty Spot',
        symbol: 'BANKNIFTY',
        exchangeSegment: 'IDX_I',
        securityId: '25',
        tickSize: 0.05,
      },
      NIFTY_SPOT: {
        key: 'NIFTY_SPOT',
        label: 'Nifty 50 Spot',
        symbol: 'NIFTY',
        exchangeSegment: 'IDX_I',
        securityId: '13',
        tickSize: 0.05,
      },
      CE_OPTION: {
        key: 'CE_OPTION',
        label: `Bank Nifty ${this.settings.ceStrike} CE`,
        symbol: `BANKNIFTY ${this.settings.ceStrike} CE`,
        exchangeSegment: 'NSE_FNO',
        securityId: `SIM_CE_${this.settings.ceStrike}`,
        strikePrice: this.settings.ceStrike,
        optionType: 'CE',
        expiry: this.settings.expiry,
        entryPrice: this.settings.ceEntryPrice,
        lots: this.settings.ceLots,
        lotSize: 30,
        tickSize: 0.05,
      },
      PE_OPTION: {
        key: 'PE_OPTION',
        label: `Bank Nifty ${this.settings.peStrike} PE`,
        symbol: `BANKNIFTY ${this.settings.peStrike} PE`,
        exchangeSegment: 'NSE_FNO',
        securityId: `SIM_PE_${this.settings.peStrike}`,
        strikePrice: this.settings.peStrike,
        optionType: 'PE',
        expiry: this.settings.expiry,
        entryPrice: this.settings.peEntryPrice,
        lots: this.settings.peLots,
        lotSize: 30,
        tickSize: 0.05,
      },
    };
  }

  private getActiveSubscriptions(): SubscribedInstrument[] {
    return ALL_KEYS.filter((k) => !this.configs[k].securityId.startsWith('SIM_')).map((k) => ({
      ExchangeSegment: this.configs[k].exchangeSegment,
      SecurityId: this.configs[k].securityId,
    }));
  }

  public seedSimulatorHistory(scenario = this.settings.simScenario): void {
    this.store.clearSimulatorCandles();
    const seeded = this.sim.seedHistory(
      scenario,
      this.settings.ceStrike,
      this.settings.peStrike,
      35
    );

    this.lastClockMs = seeded.lastSimMs;
    this.prevCloses = seeded.prevClose;
    for (const key of ALL_KEYS) {
      this.bootstrap1m[key] = [];
    }

    for (const key of ALL_KEYS) {
      const enriched = enrichWithProbabilityLine(
        seeded.candlesByStream[key],
        this.settings.windowMinutes,
        this.configs[key].tickSize
      );
      this.candles5s[key] = enriched.slice(-MAX_MEMORY_5S_BARS);
      this.store.upsertCandles5s(key, this.configs[key].symbol, enriched, 'SIMULATOR');
      this.lastPersisted5sTime[key] = enriched[enriched.length - 1]?.time ?? 0;

      // Also populate historical forecast records from the last 10 minutes so the forecast ledger is rich immediately
      this.seedHistoricalForecasts(key, enriched);
    }

    this.recomputeAllSnapshots();
  }

  private seedHistoricalForecasts(key: StreamKey, candles: Candle[]): void {
    const bt = runBacktestOn5sCandles({
      streamKey: key,
      symbol: this.configs[key].symbol,
      candles5s: candles,
      windowMinutes: this.settings.windowMinutes,
      stdDevMultiplier: this.settings.stdDevMultiplier,
      triggerSecond: this.settings.earlyTriggerSecond,
      tickSize: this.configs[key].tickSize,
    });

    const tol = Math.max(0.5, (candles[candles.length - 1]?.close ?? 100) * 0.0005 || 1);
    for (const row of bt.rows.slice(0, 12)) {
      const rec: ForecastRecord = {
        streamKey: key,
        symbol: this.configs[key].symbol,
        targetMinuteSec: row.targetMinuteSec,
        capturedAtSec: row.targetMinuteSec - (60 - this.settings.earlyTriggerSecond),
        triggerSecond: this.settings.earlyTriggerSecond,
        baseLow: row.baseLow,
        baseHigh: row.baseHigh,
        baseClose: row.baseLow + (row.baseHigh - row.baseLow) * 0.5,
        lowDev1m: row.lowDev1m,
        stdDevLow: row.stdDev,
        atr: row.stdDev,
        bullishPct: row.bullishPct,
        bearishPct: row.bearishPct,
        predictedSupport: row.predictedSupport,
        predictedResistance: row.predictedResistance,
      };
      this.store.saveForecast(rec, 'SIMULATOR');
      this.store.evaluateCompletedMinuteForecasts({
        streamKey: key,
        symbol: this.configs[key].symbol,
        minuteSec: row.targetMinuteSec,
        actualOpen: (row.actualLow + row.actualHigh) / 2,
        actualHigh: row.actualHigh,
        actualLow: row.actualLow,
        actualClose: row.actualClose,
        tolerance: tol,
        source: 'SIMULATOR',
      });
    }
  }

  private startSimulatorLoop(): void {
    this.stopSimulatorLoop();
    const intervalMs = Math.max(180, Math.round(1000 / this.settings.simSpeed));
    this.simTimer = setInterval(() => {
      if (this.mode !== 'SIMULATOR' || this.settings.simPaused) return;
      const batch = this.sim.nextTick();
      this.lastClockMs = batch.timestampMs;
      for (const key of ALL_KEYS) {
        this.ingestTick(key, batch.prices[key], batch.volumes[key], batch.timestampMs);
      }
      this.recomputeAllSnapshots();
      this.emit('broadcast', this.getFullBroadcast('TICK_UPDATE'));
    }, intervalMs);
  }

  private stopSimulatorLoop(): void {
    if (this.simTimer) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
  }

  private ingestTick(key: StreamKey, price: number, volumeDelta: number, timestampMs: number): void {
    const sec = Math.floor(timestampMs / 1000);
    const bar5sTime = Math.floor(sec / 5) * 5;
    const arr = this.candles5s[key];
    const last = arr[arr.length - 1];

    if (!last || last.time < bar5sTime) {
      // Persist newly closed previous bar & check if 1-minute bar just closed
      if (last) {
        const prevMin = Math.floor(last.time / 60) * 60;
        const newMin = Math.floor(bar5sTime / 60) * 60;
        if (newMin > prevMin && prevMin > this.lastEvaluated1mSec[key]) {
          this.evaluateClosedMinute(key, prevMin);
          this.lastEvaluated1mSec[key] = prevMin;
        }
        if (last.time > this.lastPersisted5sTime[key]) {
          this.store.upsertCandles5s(key, this.configs[key].symbol, [last], this.mode);
          this.lastPersisted5sTime[key] = last.time;
        }
      }

      arr.push({
        time: bar5sTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volumeDelta,
      });

      if (arr.length > MAX_MEMORY_5S_BARS) {
        arr.splice(0, arr.length - MAX_MEMORY_5S_BARS);
      }
    } else if (last.time === bar5sTime) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += volumeDelta;
    }

    // Re-enrich tail smoothly so Dynamic Probability Line updates in real time
    const enrichedTail = enrichWithProbabilityLine(
      arr.slice(-120),
      this.settings.windowMinutes,
      this.configs[key].tickSize
    );
    const startReplace = Math.max(0, arr.length - enrichedTail.length);
    for (let i = 0; i < enrichedTail.length; i++) {
      arr[startReplace + i] = enrichedTail[i];
    }
  }

  private evaluateClosedMinute(key: StreamKey, minuteSec: number): void {
    const minuteBars = this.candles5s[key].filter(
      (c) => Math.floor(c.time / 60) * 60 === minuteSec
    );
    if (minuteBars.length === 0) return;

    const actualOpen = minuteBars[0].open;
    const actualHigh = Math.max(...minuteBars.map((b) => b.high));
    const actualLow = Math.min(...minuteBars.map((b) => b.low));
    const actualClose = minuteBars[minuteBars.length - 1].close;
    const atr = Math.max(0.5, this.snapshots[key]?.atr5s ?? 1);

    this.store.evaluateCompletedMinuteForecasts({
      streamKey: key,
      symbol: this.configs[key].symbol,
      minuteSec,
      actualOpen,
      actualHigh,
      actualLow,
      actualClose,
      tolerance: atr * 0.4,
      source: this.mode,
    });
  }

  private computeSnapshotFor(key: StreamKey, nowMs: number): RadarSnapshot {
    const prevSnap = this.snapshots?.[key];
    return computeRadarSnapshot({
      key,
      candles5s: this.candles5s[key],
      prevDayClose: this.prevCloses[key],
      nowMs,
      windowMinutes: this.settings.windowMinutes,
      stdDevMultiplier: this.settings.stdDevMultiplier,
      tickSize: this.configs[key].tickSize,
      prevLocked50s: prevSnap?.locked50s ?? null,
      prevLocked55s: prevSnap?.locked55s ?? null,
      bootstrap1m: this.mode === 'DHAN_LIVE' ? this.bootstrap1m[key] : undefined,
    });
  }

  private recomputeAllSnapshots(): void {
    for (const key of ALL_KEYS) {
      const prev = this.snapshots?.[key];
      const next = this.computeSnapshotFor(key, this.lastClockMs);
      this.snapshots[key] = next;

      // Persist newly captured :50s or :55s forecast snapshots to SQLite
      const targetMin = Math.floor(this.lastClockMs / 60000) * 60 + 60;
      if (next.locked50s && (!prev?.locked50s || prev.locked50s.minuteStartSec !== next.locked50s.minuteStartSec)) {
        this.store.saveForecast(
          {
            streamKey: key,
            symbol: this.configs[key].symbol,
            targetMinuteSec: targetMin,
            capturedAtSec: next.locked50s.capturedAtSec,
            triggerSecond: 50,
            baseLow: next.forming1mLow,
            baseHigh: next.forming1mHigh,
            baseClose: next.forming1mClose,
            lowDev1m: next.lowDev1m,
            stdDevLow: next.stdDevLow1m,
            atr: next.atr1m,
            bullishPct: next.locked50s.bullishPct,
            bearishPct: next.locked50s.bearishPct,
            predictedSupport: next.locked50s.predictedSupport,
            predictedResistance: next.locked50s.predictedResistance,
          },
          this.mode
        );
      }

      if (next.locked55s && (!prev?.locked55s || prev.locked55s.minuteStartSec !== next.locked55s.minuteStartSec)) {
        this.store.saveForecast(
          {
            streamKey: key,
            symbol: this.configs[key].symbol,
            targetMinuteSec: targetMin,
            capturedAtSec: next.locked55s.capturedAtSec,
            triggerSecond: 55,
            baseLow: next.forming1mLow,
            baseHigh: next.forming1mHigh,
            baseClose: next.forming1mClose,
            lowDev1m: next.lowDev1m,
            stdDevLow: next.stdDevLow1m,
            atr: next.atr1m,
            bullishPct: next.locked55s.bullishPct,
            bearishPct: next.locked55s.bearishPct,
            predictedSupport: next.locked55s.predictedSupport,
            predictedResistance: next.locked55s.predictedResistance,
          },
          this.mode
        );
      }
    }

    this.confluence = computeConfluenceSignal({
      snapshots: this.snapshots,
      configs: this.configs,
    });
  }

  private applyLiveTickToBuffers(tick: DhanTickEvent, nowMs: number): void {
    const nowSec = Math.floor(nowMs / 1000);
    // Keep chart bars synchronized to real-time 5s grid even if illiquid option LTT lags slightly
    const effectiveSec =
      tick.lttSec > 1_000_000_000 && Math.abs(nowSec - tick.lttSec) <= 3
        ? tick.lttSec
        : nowSec;
    const tickMs = effectiveSec * 1000;

    for (const key of ALL_KEYS) {
      if (
        this.configs[key].exchangeSegment !== tick.exchangeSegment ||
        this.configs[key].securityId !== tick.securityId
      ) {
        continue;
      }

      if (tick.prevClose != null && tick.prevClose > 0) {
        this.prevCloses[key] = tick.prevClose;
      }

      let volDelta = 0;
      if (tick.volume != null && tick.volume >= 0) {
        const prevVol = this.lastSeenCumVolume[key];
        if (prevVol != null && tick.volume >= prevVol) {
          volDelta = tick.volume - prevVol;
        }
        this.lastSeenCumVolume[key] = tick.volume;
      }

      this.ingestTick(key, tick.ltp, volDelta, tickMs);
    }
  }

  private handleDhanTickBatch(ticks: DhanTickEvent[]): void {
    if (this.mode !== 'DHAN_LIVE' || ticks.length === 0) return;
    const nowMs = Date.now();
    this.lastClockMs = nowMs;

    for (const tick of ticks) {
      this.applyLiveTickToBuffers(tick, nowMs);
    }

    this.recomputeAllSnapshots();
    this.emit('broadcast', this.getFullBroadcast('TICK_UPDATE'));
  }

  private async warmStreamHistoryFromDhan(keys: StreamKey[] = ALL_KEYS): Promise<void> {
    if (this.mode !== 'DHAN_LIVE') return;

    const currentMinuteSec = Math.floor(Date.now() / 60000) * 60;
    for (const key of keys) {
      const cfg = this.configs[key];
      if (cfg.securityId.startsWith('SIM_')) continue;

      // Restore any recorded live 5s bars from SQLite first
      const saved = this.store.getRecentCandles5s(key, cfg.symbol, 'DHAN_LIVE', MAX_MEMORY_5S_BARS);
      if (saved.length > 0) {
        this.candles5s[key] = enrichWithProbabilityLine(
          saved,
          this.settings.windowMinutes,
          cfg.tickSize
        );
        this.lastPersisted5sTime[key] = saved[saved.length - 1]?.time ?? 0;
      } else {
        this.candles5s[key] = [];
        this.lastPersisted5sTime[key] = 0;
      }

      // Fetch today's completed NSE 1m bars for prev1mLow, EMA9/21, 15m structure, Session VWAP & full-day backtest
      const bars1m = await this.dhan.fetchRecent1mCandles({
        exchangeSegment: cfg.exchangeSegment,
        securityId: cfg.securityId,
        instrument: cfg.exchangeSegment === 'IDX_I' ? 'INDEX' : 'OPTIDX',
        limit: 400,
      });
      this.bootstrap1m[key] = bars1m.filter((b) => b.time < currentMinuteSec);
    }

    const subs = keys
      .filter((k) => !this.configs[k].securityId.startsWith('SIM_'))
      .map((k) => ({
        ExchangeSegment: this.configs[k].exchangeSegment,
        SecurityId: this.configs[k].securityId,
      }));
    if (subs.length > 0) {
      const initialQuotes = await this.dhan.fetchMarketQuotesOnce(subs);
      if (initialQuotes.ok && initialQuotes.ticks.length > 0) {
        const nowMs = Date.now();
        this.lastClockMs = nowMs;
        for (const t of initialQuotes.ticks) {
          this.applyLiveTickToBuffers(t, nowMs);
        }
      }
    }
  }

  public async updateSettings(partial: Partial<RadarSettings>): Promise<RadarBroadcast> {
    const prevScenario = this.settings.simScenario;
    const prevCeStrike = this.settings.ceStrike;
    const prevPeStrike = this.settings.peStrike;
    const prevExpiry = this.settings.expiry;
    const prevSpeed = this.settings.simSpeed;
    const prevCeSecId = this.configs.CE_OPTION.securityId;
    const prevPeSecId = this.configs.PE_OPTION.securityId;

    this.settings = { ...this.settings, ...partial };
    this.store.saveSettings(this.settings);
    this.configs = this.buildInstrumentConfigs();

    if (this.mode === 'SIMULATOR') {
      if (partial.simScenario && partial.simScenario !== prevScenario) {
        this.seedSimulatorHistory(this.settings.simScenario);
      } else if (
        this.settings.ceStrike !== prevCeStrike ||
        this.settings.peStrike !== prevPeStrike
      ) {
        // Re-seed CE/PE curves smoothly for the newly selected strike price
        const prices = this.sim.setStrikes(this.settings.ceStrike, this.settings.peStrike);
        if (this.settings.ceStrike !== prevCeStrike) {
          this.realignOptionSeed('CE_OPTION', prices.cePrice);
        }
        if (this.settings.peStrike !== prevPeStrike) {
          this.realignOptionSeed('PE_OPTION', prices.pePrice);
        }
      }
      if (partial.simSpeed && partial.simSpeed !== prevSpeed) {
        this.startSimulatorLoop();
      }
    } else if (this.mode === 'DHAN_LIVE') {
      await this.resolveAndSubscribeLiveOptions();
      const changedKeys: StreamKey[] = [];
      if (
        this.configs.CE_OPTION.securityId !== prevCeSecId ||
        this.settings.ceStrike !== prevCeStrike ||
        this.settings.expiry !== prevExpiry
      ) {
        this.lastSeenCumVolume.CE_OPTION = undefined;
        this.lastEvaluated1mSec.CE_OPTION = 0;
        changedKeys.push('CE_OPTION');
      }
      if (
        this.configs.PE_OPTION.securityId !== prevPeSecId ||
        this.settings.peStrike !== prevPeStrike ||
        this.settings.expiry !== prevExpiry
      ) {
        this.lastSeenCumVolume.PE_OPTION = undefined;
        this.lastEvaluated1mSec.PE_OPTION = 0;
        changedKeys.push('PE_OPTION');
      }
      if (changedKeys.length > 0) {
        await this.warmStreamHistoryFromDhan(changedKeys);
      }
    }

    this.recomputeAllSnapshots();
    const state = this.getFullBroadcast('FULL_STATE');
    this.emit('broadcast', state);
    return state;
  }

  private realignOptionSeed(key: 'CE_OPTION' | 'PE_OPTION', newAnchorPrice: number): void {
    const bars = this.candles5s[key];
    if (bars.length === 0) return;
    const oldAnchor = bars[bars.length - 1].close || 1;
    const ratio = newAnchorPrice / oldAnchor;
    const scaled = bars.map((b) => ({
      ...b,
      open: Math.max(0.5, Math.round(b.open * ratio * 20) / 20),
      high: Math.max(0.5, Math.round(b.high * ratio * 20) / 20),
      low: Math.max(0.5, Math.round(b.low * ratio * 20) / 20),
      close: Math.max(0.5, Math.round(b.close * ratio * 20) / 20),
    }));
    const enriched = enrichWithProbabilityLine(scaled, this.settings.windowMinutes, 0.05);
    this.candles5s[key] = enriched;
    this.prevCloses[key] = Math.round(newAnchorPrice * 0.95 * 20) / 20;
    this.store.upsertCandles5s(key, this.configs[key].symbol, enriched, 'SIMULATOR');
  }

  public async connectDhanLive(clientId?: string, accessToken?: string): Promise<DhanStatus> {
    if (clientId && accessToken) {
      this.dhan.setCredentials(clientId, accessToken);
    }
    if (!this.dhan.hasCredentials()) {
      throw new Error('Please provide both Dhan Client ID and Access Token.');
    }

    const runConnect = async (): Promise<DhanStatus> => {
      this.mode = 'DHAN_LIVE';
      this.stopSimulatorLoop();
      this.lastSeenCumVolume = {};

      for (const key of ALL_KEYS) {
        this.candles5s[key] = [];
        this.bootstrap1m[key] = [];
        this.lastPersisted5sTime[key] = 0;
        this.lastEvaluated1mSec[key] = 0;
      }

      await this.resolveAndSubscribeLiveOptions();
      await this.warmStreamHistoryFromDhan(ALL_KEYS);

      const subList = this.getActiveSubscriptions();
      this.dhan.connect(subList);
      this.recomputeAllSnapshots();
      this.emit('broadcast', this.getFullBroadcast('FULL_STATE'));
      return this.getDhanStatus();
    };

    const p = runConnect().finally(() => {
      if (this.connectPromise === p) this.connectPromise = null;
    });
    this.connectPromise = p;
    return p;
  }

  private async resolveAndSubscribeLiveOptions(): Promise<void> {
    const [ceInfo, peInfo] = await Promise.all([
      this.dhan.resolveBankNiftyOption({
        strikePrice: this.settings.ceStrike,
        optionType: 'CE',
        expiry: this.settings.expiry,
      }),
      this.dhan.resolveBankNiftyOption({
        strikePrice: this.settings.peStrike,
        optionType: 'PE',
        expiry: this.settings.expiry,
      }),
    ]);

    if (ceInfo) {
      this.configs.CE_OPTION.securityId = ceInfo.securityId;
      this.configs.CE_OPTION.symbol = ceInfo.displayName;
      this.configs.CE_OPTION.expiry = ceInfo.expiry;
      this.configs.CE_OPTION.lotSize = ceInfo.lotSize;
    }
    if (peInfo) {
      this.configs.PE_OPTION.securityId = peInfo.securityId;
      this.configs.PE_OPTION.symbol = peInfo.displayName;
      this.configs.PE_OPTION.expiry = peInfo.expiry;
      this.configs.PE_OPTION.lotSize = peInfo.lotSize;
    }

    // Keep settings.expiry aligned to active resolved contract expiry if placeholder didn't match
    const resolvedExpiry = ceInfo?.expiry ?? peInfo?.expiry;
    if (resolvedExpiry && resolvedExpiry !== this.settings.expiry) {
      this.settings.expiry = resolvedExpiry;
      this.store.saveSettings(this.settings);
    }

    if (this.dhan.wsConnected || this.dhan.transportMode !== 'IDLE') {
      this.dhan.updateSubscriptions(this.getActiveSubscriptions());
    }
  }

  public switchToSimulator(): DhanStatus {
    this.dhan.disconnect(true);
    this.mode = 'SIMULATOR';
    this.lastSeenCumVolume = {};
    this.configs = this.buildInstrumentConfigs();
    this.seedSimulatorHistory(this.settings.simScenario);
    this.startSimulatorLoop();
    this.emit('broadcast', this.getFullBroadcast('FULL_STATE'));
    return this.getDhanStatus();
  }

  public async getExpiries(): Promise<string[]> {
    const list = await this.dhan.fetchBankNiftyExpiries();
    if (list.length > 0) return list;
    return [defaultExpiryString()];
  }

  public getDhanStatus(): DhanStatus {
    return {
      mode: this.mode,
      hasCredentials: this.dhan.hasCredentials(),
      clientIdMasked: this.dhan.getClientIdMasked(),
      wsConnected: this.dhan.wsConnected,
      feedTransport: this.dhan.transportMode,
      lastTickAt: this.dhan.lastTickAt,
      lastError: this.dhan.lastError,
      scripCountLoaded: this.dhan.getScripCount(),
      persistenceMode: process.env.GOOGLE_CLOUD_PROJECT ? 'SQLITE_CLOUD_READY' : 'SQLITE_LOCAL',
    };
  }

  public getFullBroadcast(type: 'FULL_STATE' | 'TICK_UPDATE' = 'FULL_STATE'): RadarBroadcast {
    const streams = {} as Record<StreamKey, StreamPayload>;
    for (const key of ALL_KEYS) {
      let displayCandles = aggregateCandles(this.candles5s[key], this.settings.timeframe);
      if (
        this.mode === 'DHAN_LIVE' &&
        this.settings.timeframe === '1m' &&
        this.bootstrap1m[key].length > 0
      ) {
        const firstLiveTime = displayCandles[0]?.time ?? Infinity;
        const prefix = enrichWithProbabilityLine(
          this.bootstrap1m[key].filter((b) => b.time < firstLiveTime),
          this.settings.windowMinutes,
          this.configs[key].tickSize
        );
        displayCandles = [...prefix, ...displayCandles];
      }
      displayCandles = displayCandles.slice(-180);

      streams[key] = {
        config: this.configs[key],
        candles: displayCandles,
        snapshot: this.snapshots[key],
        recentForecasts: this.store.getRecentForecasts(key, this.mode, 12),
      };
    }

    return {
      type,
      serverTimeMs: this.lastClockMs,
      dhanStatus: this.getDhanStatus(),
      settings: this.settings,
      confluence: this.confluence,
      streams,
    };
  }

  public async snapToAtmStrikes(): Promise<{ atmStrike: number; state: RadarBroadcast }> {
    if (this.connectPromise) {
      await this.connectPromise;
    }

    if (this.mode === 'DHAN_LIVE' && this.candles5s.BANKNIFTY_SPOT.length === 0) {
      const freshSpot = await this.dhan.fetchMarketQuotesOnce([
        { ExchangeSegment: 'IDX_I', SecurityId: '25' },
      ]);
      if (freshSpot.ok && freshSpot.ticks.length > 0) {
        const nowMs = Date.now();
        this.lastClockMs = nowMs;
        for (const t of freshSpot.ticks) {
          this.applyLiveTickToBuffers(t, nowMs);
        }
        this.recomputeAllSnapshots();
      }
    }

    const bnLtp = this.snapshots.BANKNIFTY_SPOT?.ltp || 61000;
    const atmStrike = Math.round(bnLtp / 100) * 100;
    const state = await this.updateSettings({
      ceStrike: atmStrike,
      peStrike: atmStrike,
    });
    return { atmStrike, state };
  }

  public runBacktest(params: {
    streamKey: StreamKey;
    windowMinutes: number;
    stdDevMultiplier: number;
    triggerSecond: 45 | 50 | 55;
  }): BacktestSummary {
    const stored = this.store.getStreamCandlesForBacktest(params.streamKey, this.mode, 5000);
    const candles =
      stored.candles.length >= 36 ? stored.candles : this.candles5s[params.streamKey];
    const symbol = stored.candles.length >= 36 ? stored.symbol : this.configs[params.streamKey].symbol;

    return runBacktestOn5sCandles({
      streamKey: params.streamKey,
      symbol,
      candles5s: candles,
      windowMinutes: params.windowMinutes,
      stdDevMultiplier: params.stdDevMultiplier,
      triggerSecond: params.triggerSecond,
      tickSize: this.configs[params.streamKey].tickSize,
    });
  }

  private async buildSession1mBars(key: StreamKey, prefer5sOnly: boolean): Promise<Candle[]> {
    const cfg = this.configs[key];
    const stored5s = this.store.getRecentCandles5s(key, cfg.symbol, this.mode, 10000);
    const merged5sMap = new Map<number, Candle>();
    for (const c of stored5s) merged5sMap.set(c.time, c);
    for (const c of this.candles5s[key]) merged5sMap.set(c.time, c);

    const merged5s = Array.from(merged5sMap.values()).sort((a, b) => a.time - b.time);
    const live1m = aggregateCandles(merged5s, '1m');

    if (prefer5sOnly || this.mode !== 'DHAN_LIVE') {
      return live1m;
    }

    if (this.bootstrap1m[key].length === 0 && !cfg.securityId.startsWith('SIM_')) {
      const currentMinuteSec = Math.floor(Date.now() / 60000) * 60;
      const fetched = await this.dhan.fetchRecent1mCandles({
        exchangeSegment: cfg.exchangeSegment,
        securityId: cfg.securityId,
        instrument: cfg.exchangeSegment === 'IDX_I' ? 'INDEX' : 'OPTIDX',
        limit: 400,
      });
      this.bootstrap1m[key] = fetched.filter((b) => b.time < currentMinuteSec);
    }

    const barMap = new Map<number, Candle>();
    for (const b of this.bootstrap1m[key]) {
      barMap.set(b.time, b);
    }
    for (const b of live1m) {
      barMap.set(b.time, b);
    }
    return Array.from(barMap.values()).sort((a, b) => a.time - b.time);
  }

  public async runStrategyBacktest(params: StrategyBacktestParams): Promise<StrategyBacktestSummary> {
    const prefer5sOnly = params.source === '5S_TICKS';
    const [bnBars1m, nfBars1m, optBars1m] = await Promise.all([
      this.buildSession1mBars('BANKNIFTY_SPOT', prefer5sOnly),
      this.buildSession1mBars('NIFTY_SPOT', prefer5sOnly),
      this.buildSession1mBars(params.optionKey, prefer5sOnly),
    ]);

    const optCfg = this.configs[params.optionKey];
    const dataSourceLabel =
      this.mode === 'SIMULATOR'
        ? 'Simulator Synthetic Session (5s→1m, Zero Look-Ahead)'
        : !prefer5sOnly && this.bootstrap1m[params.optionKey].length > 0
          ? 'Dhan NSE Intraday 1m Session + Live 5s (Zero Look-Ahead)'
          : 'Recorded Live 5s→1m Ticks (Zero Look-Ahead)';

    return runStrategyBacktest({
      params,
      symbol: optCfg.symbol,
      lotSize: optCfg.lotSize ?? 30,
      tickSize: optCfg.tickSize,
      dataSourceLabel,
      bnBars1m,
      nfBars1m,
      optBars1m,
    });
  }
}
