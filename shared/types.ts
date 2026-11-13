export type StreamKey = 'BANKNIFTY_SPOT' | 'NIFTY_SPOT' | 'CE_OPTION' | 'PE_OPTION';

export type Timeframe = '5s' | '10s' | '1m';

export type DataSourceMode = 'SIMULATOR' | 'DHAN_LIVE';

export type SimScenario =
  | 'USER_BULLISH_61360'
  | 'BEARISH_BREAKDOWN'
  | 'CHOPPY_RANGE'
  | 'VOLATILITY_SPIKE';

export interface Candle {
  time: number; // Unix seconds (aligned to bar boundary)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  probLine?: number;
  bullishPct?: number;
}

export interface InstrumentConfig {
  key: StreamKey;
  label: string;
  symbol: string;
  exchangeSegment: 'IDX_I' | 'NSE_FNO';
  securityId: string;
  strikePrice?: number;
  optionType?: 'CE' | 'PE';
  expiry?: string;
  entryPrice?: number | null;
  lots?: number;
  lotSize?: number;
  tickSize: number;
}

export type EarlyPhase = 'BUILDING' | 'EARLY_50S' | 'FINAL_55S';

export interface RadarSnapshot {
  key: StreamKey;
  timestampMs: number;
  istTimeStr: string;
  secondInMinute: number;
  secondsRemainingInMinute: number;
  phase: EarlyPhase;
  ltp: number;
  prevClose: number;
  change: number;
  changePct: number;
  // Rolling 3-minute (or configured window) metrics from 5s bars
  windowMinutes: number;
  sampleCount5s: number;
  avgStepLow5s: number;
  stdDevLow5s: number;
  avgStepHigh5s: number;
  stdDevHigh5s: number;
  atr5s: number;
  atr1m: number;
  // 1-minute candle comparison (user's 61360.45 -> 61368 example)
  forming1mOpen: number;
  forming1mHigh: number;
  forming1mLow: number;
  forming1mClose: number;
  prev1mHigh: number;
  prev1mLow: number;
  prev1mClose: number;
  lowDev1m: number; // forming1mLow - prev1mLow (or last closed - prev closed)
  highDev1m: number;
  avgLowDev1m: number;
  stdDevLow1m: number;
  // Dynamic probability line & combined %
  probLine: number;
  bullishPct: number;
  bearishPct: number;
  regime: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  // Next-minute prediction (locked / updated at :50s and :55s)
  predictedNextSupport: number;
  predictedNextResistance: number;
  supportDelta: number;
  resistanceDelta: number;
  locked50s?: {
    minuteStartSec: number;
    capturedAtSec: number;
    predictedSupport: number;
    predictedResistance: number;
    bullishPct: number;
    bearishPct: number;
    lowDev1m: number;
  } | null;
  locked55s?: {
    minuteStartSec: number;
    capturedAtSec: number;
    predictedSupport: number;
    predictedResistance: number;
    bullishPct: number;
    bearishPct: number;
    lowDev1m: number;
  } | null;
}

export interface ForecastRecord {
  id?: number;
  streamKey: StreamKey;
  symbol: string;
  targetMinuteSec: number; // The upcoming 1m candle being predicted
  capturedAtSec: number; // e.g., targetMinuteSec - 5 (:55s) or - 10 (:50s)
  triggerSecond: number; // 50 or 55
  baseLow: number;
  baseHigh: number;
  baseClose: number;
  lowDev1m: number;
  stdDevLow: number;
  atr: number;
  bullishPct: number;
  bearishPct: number;
  predictedSupport: number;
  predictedResistance: number;
  // Filled once targetMinuteSec 1m candle completes:
  actualOpen?: number | null;
  actualHigh?: number | null;
  actualLow?: number | null;
  actualClose?: number | null;
  supportErrorPts?: number | null;
  resistanceErrorPts?: number | null;
  supportHeld?: boolean | null; // actualLow >= predictedSupport - tolerance
  resistanceRespected?: boolean | null; // actualHigh <= predictedResistance + tolerance
  directionMatched?: boolean | null;
  evaluatedAt?: number | null;
}

export interface RadarSettings {
  timeframe: Timeframe;
  windowMinutes: number; // default 3
  stdDevMultiplier: number; // default 1.0
  earlyTriggerSecond: 45 | 50 | 55; // default 55
  ceStrike: number;
  peStrike: number;
  expiry: string;
  ceEntryPrice: number | null;
  peEntryPrice: number | null;
  ceLots: number;
  peLots: number;
  simScenario: SimScenario;
  simSpeed: 1 | 2 | 5;
  simPaused: boolean;
}

export interface DhanStatus {
  mode: DataSourceMode;
  hasCredentials: boolean;
  clientIdMasked: string;
  wsConnected: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  scripCountLoaded: number;
  persistenceMode: 'SQLITE_LOCAL' | 'SQLITE_CLOUD_READY';
}

export interface StreamPayload {
  config: InstrumentConfig;
  candles: Candle[];
  snapshot: RadarSnapshot;
  recentForecasts: ForecastRecord[];
}

export interface RadarBroadcast {
  type: 'FULL_STATE' | 'TICK_UPDATE';
  serverTimeMs: number;
  dhanStatus: DhanStatus;
  settings: RadarSettings;
  streams: Record<StreamKey, StreamPayload>;
}

export interface BacktestRow {
  targetMinuteSec: number;
  timeLabel: string;
  baseLow: number;
  baseHigh: number;
  lowDev1m: number;
  stdDev: number;
  bullishPct: number;
  bearishPct: number;
  predictedSupport: number;
  predictedResistance: number;
  actualLow: number;
  actualHigh: number;
  actualClose: number;
  lowErrorPts: number;
  highErrorPts: number;
  rangeHit: boolean;
  directionHit: boolean;
}

export interface BacktestSummary {
  streamKey: StreamKey;
  symbol: string;
  totalPredictions: number;
  rangeHitCount: number;
  rangeHitRatePct: number;
  supportHoldRatePct: number;
  resistanceCapRatePct: number;
  directionHitRatePct: number;
  avgSupportErrorPts: number;
  avgResistanceErrorPts: number;
  rows: BacktestRow[];
}
