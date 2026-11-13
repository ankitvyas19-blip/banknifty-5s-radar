import { EventEmitter } from 'node:events';
import {
  aggregateCandles,
  computeRadarSnapshot,
  enrichWithProbabilityLine,
  runBacktestOn5sCandles,
} from '../shared/radarMath.js';
import type {
  BacktestSummary,
  Candle,
  DataSourceMode,
  DhanStatus,
  ForecastRecord,
  InstrumentConfig,
  RadarBroadcast,
  RadarSettings,
  RadarSnapshot,
  StreamKey,
  StreamPayload,
} from '../shared/types.js';
import { DhanClient, type DhanTickEvent } from './dhanClient.js';
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
  private prevCloses: Record<StreamKey, number> = {
    BANKNIFTY_SPOT: 61300,
    NIFTY_SPOT: 25620,
    CE_OPTION: 230,
    PE_OPTION: 185,
  };
  private snapshots: Record<StreamKey, RadarSnapshot> = {} as Record<StreamKey, RadarSnapshot>;
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

    // Seed initial simulator data cleanly
    this.seedSimulatorHistory(this.settings.simScenario);

    this.snapshots = {
      BANKNIFTY_SPOT: this.computeSnapshotFor('BANKNIFTY_SPOT', this.lastClockMs),
      NIFTY_SPOT: this.computeSnapshotFor('NIFTY_SPOT', this.lastClockMs),
      CE_OPTION: this.computeSnapshotFor('CE_OPTION', this.lastClockMs),
      PE_OPTION: this.computeSnapshotFor('PE_OPTION', this.lastClockMs),
    };

    // Wire DhanHQ live events
    this.dhan.on('tick', (tick: DhanTickEvent) => this.handleDhanTick(tick));
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
      void this.connectDhanLive();
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

  public seedSimulatorHistory(scenario = this.settings.simScenario): void {
    this.store.clearSimulatorCandles();
    const seeded = this.sim.seedHistory(
      scenario,
      this.settings.ceStrike,
      this.settings.peStrike,
      25
    );

    this.lastClockMs = seeded.lastSimMs;
    this.prevCloses = seeded.prevClose;

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

    const tol = Math.max(0.5, candles[candles.length - 1]?.close * 0.0005 || 1);
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
  }

  private handleDhanTick(tick: DhanTickEvent): void {
    if (this.mode !== 'DHAN_LIVE') return;
    const tickMs = (tick.lttSec > 1000000000 ? tick.lttSec * 1000 : Date.now());
    this.lastClockMs = Date.now();

    for (const key of ALL_KEYS) {
      if (this.configs[key].securityId === tick.securityId) {
        this.ingestTick(key, tick.ltp, tick.volume ?? 0, tickMs);
      }
    }
    this.recomputeAllSnapshots();
    this.emit('broadcast', this.getFullBroadcast('TICK_UPDATE'));
  }

  public async updateSettings(partial: Partial<RadarSettings>): Promise<RadarBroadcast> {
    const prevScenario = this.settings.simScenario;
    const prevCeStrike = this.settings.ceStrike;
    const prevPeStrike = this.settings.peStrike;
    const prevSpeed = this.settings.simSpeed;

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

    this.mode = 'DHAN_LIVE';
    this.stopSimulatorLoop();

    // Reset live buffers & load any previously recorded DHAN_LIVE bars from SQLite
    for (const key of ALL_KEYS) {
      this.candles5s[key] = [];
    }

    await this.resolveAndSubscribeLiveOptions();

    for (const key of ALL_KEYS) {
      const saved = this.store.getRecentCandles5s(
        key,
        this.configs[key].symbol,
        'DHAN_LIVE',
        MAX_MEMORY_5S_BARS
      );
      if (saved.length > 0) {
        this.candles5s[key] = enrichWithProbabilityLine(
          saved,
          this.settings.windowMinutes,
          this.configs[key].tickSize
        );
      }
    }

    const subList = ALL_KEYS.filter((k) => !this.configs[k].securityId.startsWith('SIM_')).map(
      (k) => ({
        ExchangeSegment: this.configs[k].exchangeSegment,
        SecurityId: this.configs[k].securityId,
      })
    );

    this.dhan.connect(subList);
    this.recomputeAllSnapshots();
    this.emit('broadcast', this.getFullBroadcast('FULL_STATE'));
    return this.getDhanStatus();
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

    if (this.dhan.wsConnected) {
      const subList = ALL_KEYS.filter((k) => !this.configs[k].securityId.startsWith('SIM_')).map(
        (k) => ({
          ExchangeSegment: this.configs[k].exchangeSegment,
          SecurityId: this.configs[k].securityId,
        })
      );
      this.dhan.updateSubscriptions(subList);
    }
  }

  public switchToSimulator(): DhanStatus {
    this.dhan.disconnect(true);
    this.mode = 'SIMULATOR';
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
      lastTickAt: this.dhan.lastTickAt,
      lastError: this.dhan.lastError,
      scripCountLoaded: this.dhan.getScripCount(),
      persistenceMode: process.env.GOOGLE_CLOUD_PROJECT ? 'SQLITE_CLOUD_READY' : 'SQLITE_LOCAL',
    };
  }

  public getFullBroadcast(type: 'FULL_STATE' | 'TICK_UPDATE' = 'FULL_STATE'): RadarBroadcast {
    const streams = {} as Record<StreamKey, StreamPayload>;
    for (const key of ALL_KEYS) {
      const displayCandles = aggregateCandles(this.candles5s[key], this.settings.timeframe).slice(
        -180
      );
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
      streams,
    };
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
}
