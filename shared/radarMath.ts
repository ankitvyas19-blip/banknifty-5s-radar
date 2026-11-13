import type {
  BacktestRow,
  BacktestSummary,
  Candle,
  ConfluenceCheckItem,
  ConfluenceSideEvaluation,
  ConfluenceSignal,
  ConfluenceVerdict,
  EarlyPhase,
  InstrumentConfig,
  OptionChargeBreakdown,
  RadarSnapshot,
  SimulatedTradeRow,
  StrategyBacktestParams,
  StrategyBacktestSummary,
  StrategyPreset,
  StreamKey,
  Timeframe,
} from './types.js';

export function roundToTick(value: number, tickSize: number): number {
  const safeTick = tickSize > 0 ? tickSize : 0.05;
  return Math.round(value / safeTick) * safeTick;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-clamp(x, -12, 12)));
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  let sq = 0;
  for (const v of values) {
    const d = v - avg;
    sq += d * d;
  }
  return Math.sqrt(sq / values.length);
}

export function computeEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (Math.max(1, period) + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i] + (1 - alpha) * ema;
  }
  return ema;
}

export function formatIstDateKey(timestampSec: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestampSec * 1000));
  } catch {
    return new Date(timestampSec * 1000).toISOString().slice(0, 10);
  }
}

/**
 * Computes intraday session VWAP (`sum(typical * vol) / sum(vol)`) for the latest IST session date.
 * Returns null if volume across the session is 0 (e.g., Spot Index streams).
 */
export function computeSessionVwap(bars1m: Candle[]): number | null {
  if (bars1m.length === 0) return null;
  const latestDay = formatIstDateKey(bars1m[bars1m.length - 1].time);
  let cumTpVol = 0;
  let cumVol = 0;
  for (const b of bars1m) {
    if (formatIstDateKey(b.time) !== latestDay) continue;
    const vol = b.volume > 0 ? b.volume : 0;
    if (vol <= 0) continue;
    const typical = (b.high + b.low + b.close) / 3;
    cumTpVol += typical * vol;
    cumVol += vol;
  }
  if (cumVol <= 0) return null;
  return round2(cumTpVol / cumVol);
}

/**
 * Computes exact FY 2026-27 DhanHQ + NSE Equity Options buyer round-trip charges:
 * - Brokerage: ₹20 buy + ₹20 sell = ₹40
 * - STT (eff. Apr 1, 2026): 0.15% on sell premium turnover (rounded to nearest ₹)
 * - NSE Txn + IPFT (eff. Mar 1, 2026): 0.03553% on total turnover
 * - SEBI Turnover Fee: 0.0001% on total turnover
 * - Stamp Duty: 0.003% on buy turnover (rounded to nearest ₹)
 * - GST: 18% on (Brokerage + NSE Txn/IPFT + SEBI)
 */
export function calcOptionRoundTripCharges(
  buyPrice: number,
  sellPrice: number,
  qty = 30
): OptionChargeBreakdown {
  const safeQty = Math.max(1, qty);
  const safeBuy = Math.max(0, buyPrice);
  const safeSell = Math.max(0, sellPrice);
  const buyVal = safeBuy * safeQty;
  const sellVal = safeSell * safeQty;
  const totalVal = buyVal + sellVal;

  const brokerage = 40;
  const stt = Math.round(sellVal * 0.0015);
  const exchTxnIpft = totalVal * 0.0003553;
  const sebiFee = totalVal * 0.000001;
  const stampDuty = Math.round(buyVal * 0.00003);
  const gst = (brokerage + exchTxnIpft + sebiFee) * 0.18;

  const totalCharges = round2(brokerage + stt + exchTxnIpft + sebiFee + stampDuty + gst);
  return {
    brokerage: round2(brokerage),
    stt: round2(stt),
    exchTxnIpft: round2(exchTxnIpft),
    sebiFee: round2(sebiFee),
    stampDuty: round2(stampDuty),
    gst: round2(gst),
    totalCharges,
    breakevenPts: round2(totalCharges / safeQty),
  };
}

export function computeATR(candles: Candle[], period = 14): number {
  if (candles.length === 0) return 0;
  const slice = candles.slice(-Math.max(2, period + 1));
  if (slice.length === 1) return Math.max(0.05, slice[0].high - slice[0].low);

  const trs: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i];
    const prev = slice[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  return mean(trs);
}

/**
 * Aggregates 5-second candles into 10s or 1m candles deterministically.
 */
export function aggregateCandles(candles5s: Candle[], timeframe: Timeframe): Candle[] {
  if (timeframe === '5s') return candles5s;
  const bucketSec = timeframe === '10s' ? 10 : 60;
  const out: Candle[] = [];
  let current: Candle | null = null;

  for (const c of candles5s) {
    const aligned = Math.floor(c.time / bucketSec) * bucketSec;
    if (!current || current.time !== aligned) {
      if (current) out.push(current);
      current = {
        time: aligned,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        probLine: c.probLine,
        bullishPct: c.bullishPct,
      };
    } else {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume += c.volume;
      current.probLine = c.probLine;
      current.bullishPct = c.bullishPct;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Enriches a sequence of 5s candles with the Dynamic Probability Baseline (`probLine`)
 * and `bullishPct` (0..100) for charting and live signal calculation.
 */
export function enrichWithProbabilityLine(
  candles5s: Candle[],
  windowMinutes: number,
  tickSize: number
): Candle[] {
  if (candles5s.length === 0) return [];
  const windowBars = Math.max(6, Math.round((windowMinutes * 60) / 5));

  let fastEma = candles5s[0].close;
  let slowEma = candles5s[0].close;
  const alphaFast = 2 / (9 + 1);
  const alphaSlow = 2 / (24 + 1);

  const enriched: Candle[] = new Array<Candle>(candles5s.length);
  for (let i = 0; i < candles5s.length; i++) {
    const c = candles5s[i];
    const typical = (c.high + c.low + c.close) / 3;
    fastEma = alphaFast * typical + (1 - alphaFast) * fastEma;
    slowEma = alphaSlow * typical + (1 - alphaSlow) * slowEma;

    const probLine = round2(0.65 * fastEma + 0.35 * slowEma);
    const startIdx = Math.max(0, i - windowBars + 1);

    let higherLowCount = 0;
    let totalSteps = 0;
    for (let j = startIdx + 1; j <= i; j++) {
      totalSteps++;
      const cur = candles5s[j];
      const prev = candles5s[j - 1];
      if (cur.low > prev.low) {
        higherLowCount += 1;
      } else if (cur.low === prev.low && cur.close >= prev.close) {
        higherLowCount += 0.5;
      }
    }

    const rawHigherLowRatio = totalSteps > 0 ? higherLowCount / totalSteps : 0.5;
    const sampleWeight = Math.min(1, totalSteps / 6);
    const higherLowRatio = sampleWeight * rawHigherLowRatio + (1 - sampleWeight) * 0.5;

    const atrStart = Math.max(startIdx, i - 12);
    let rawAtr = 0;
    if (atrStart >= i) {
      rawAtr = Math.max(0.05, c.high - c.low);
    } else {
      let trSum = 0;
      for (let j = atrStart + 1; j <= i; j++) {
        const cur = candles5s[j];
        const prev = candles5s[j - 1];
        trSum += Math.max(
          cur.high - cur.low,
          Math.abs(cur.high - prev.close),
          Math.abs(cur.low - prev.close)
        );
      }
      rawAtr = trSum / (i - atrStart);
    }

    const atr = Math.max(tickSize * 2, rawAtr);
    const prevLine = i > 0 ? (enriched[i - 1].probLine ?? probLine) : probLine;
    const lineSlope = probLine - prevLine;

    const distScore = sigmoid((c.close - probLine) / (atr * 0.85));
    const slopeScore = sigmoid(lineSlope / (atr * 0.22));
    const rawPct = (0.38 * higherLowRatio + 0.37 * distScore + 0.25 * slopeScore) * 100;
    const bullishPct = clamp(Math.round(rawPct), 1, 99);

    enriched[i] = {
      ...c,
      probLine,
      bullishPct,
    };
  }

  return enriched;
}

export function formatIstTime(timestampMs: number): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestampMs));
  } catch {
    const d = new Date(timestampMs);
    return d.toISOString().slice(11, 19);
  }
}

export function formatIstMinute(timestampSec: number): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestampSec * 1000));
  } catch {
    const d = new Date(timestampSec * 1000);
    return d.toISOString().slice(11, 16);
  }
}

export interface ComputeSnapshotParams {
  key: StreamKey;
  candles5s: Candle[];
  prevDayClose: number;
  nowMs: number;
  windowMinutes: number;
  stdDevMultiplier: number;
  tickSize: number;
  prevLocked50s?: RadarSnapshot['locked50s'];
  prevLocked55s?: RadarSnapshot['locked55s'];
  bootstrap1m?: Candle[];
}

export function computeRadarSnapshot(params: ComputeSnapshotParams): RadarSnapshot {
  const {
    key,
    candles5s,
    prevDayClose,
    nowMs,
    windowMinutes,
    stdDevMultiplier,
    tickSize,
    prevLocked50s,
    prevLocked55s,
    bootstrap1m,
  } = params;

  let needsEnrich = false;
  for (let i = candles5s.length - 1; i >= 0; i--) {
    if (candles5s[i].probLine == null || candles5s[i].bullishPct == null) {
      needsEnrich = true;
      break;
    }
  }
  const enriched = needsEnrich
    ? enrichWithProbabilityLine(candles5s, windowMinutes, tickSize)
    : candles5s;
  const windowBars = Math.max(6, Math.round((windowMinutes * 60) / 5));
  const recent5s = enriched.slice(-windowBars);
  const latest = recent5s[recent5s.length - 1] ?? {
    time: Math.floor(nowMs / 1000),
    open: prevDayClose,
    high: prevDayClose,
    low: prevDayClose,
    close: prevDayClose,
    volume: 0,
    probLine: prevDayClose,
    bullishPct: 50,
  };

  // 5s step deviations in the 3-minute window
  const lowSteps5s: number[] = [];
  const highSteps5s: number[] = [];
  for (let i = 1; i < recent5s.length; i++) {
    lowSteps5s.push(recent5s[i].low - recent5s[i - 1].low);
    highSteps5s.push(recent5s[i].high - recent5s[i - 1].high);
  }

  const avgStepLow5s = mean(lowSteps5s);
  const stdDevLow5s = stdDev(lowSteps5s);
  const avgStepHigh5s = mean(highSteps5s);
  const stdDevHigh5s = stdDev(highSteps5s);
  const atr5s = computeATR(recent5s, 14);

  // Build 1-minute bars from all available 5s bars, optionally prepending closed intraday 1m context
  const live1m = aggregateCandles(enriched, '1m');
  const firstLiveMin = live1m[0]?.time ?? Infinity;
  const liveMinSet = new Set(live1m.map((b) => b.time));
  const prefix1m = (bootstrap1m ?? []).filter(
    (b) => b.time < firstLiveMin && !liveMinSet.has(b.time)
  );
  const bars1m = [...prefix1m, ...live1m].sort((a, b) => a.time - b.time);

  const forming1m = live1m[live1m.length - 1] ?? latest;
  const prev1m =
    live1m.length >= 2
      ? live1m[live1m.length - 2]
      : (prefix1m[prefix1m.length - 1] ?? forming1m);

  const recent1m = (live1m.length > 0 ? bars1m : prefix1m).slice(-Math.max(4, windowMinutes + 1));
  const lowSteps1m: number[] = [];
  const highSteps1m: number[] = [];
  for (let i = 1; i < recent1m.length; i++) {
    lowSteps1m.push(recent1m[i].low - recent1m[i - 1].low);
    highSteps1m.push(recent1m[i].high - recent1m[i - 1].high);
  }

  const lowDev1m = round2(forming1m.low - prev1m.low);
  const highDev1m = round2(forming1m.high - prev1m.high);
  const avgLowDev1m = lowSteps1m.length > 0 ? mean(lowSteps1m) : avgStepLow5s * 12;
  const avgHighDev1m = highSteps1m.length > 0 ? mean(highSteps1m) : avgStepHigh5s * 12;
  const atr1m =
    bars1m.length >= 2
      ? computeATR(bars1m, Math.max(3, windowMinutes))
      : atr5s * Math.sqrt(12);

  // Blend 1m Low-to-Low StdDev with 5s-scaled StdDev (sqrt(12) scaling rule from 5s to 60s)
  const scaled5sStdLow = stdDevLow5s * Math.sqrt(12);
  const scaled5sStdHigh = stdDevHigh5s * Math.sqrt(12);
  const stdDevLow1m =
    lowSteps1m.length >= 2
      ? round2(0.55 * stdDev(lowSteps1m) + 0.45 * scaled5sStdLow)
      : round2(scaled5sStdLow);
  const stdDevHigh1m =
    highSteps1m.length >= 2
      ? round2(0.55 * stdDev(highSteps1m) + 0.45 * scaled5sStdHigh)
      : round2(scaled5sStdHigh);

  // Combine 5s probability with 1m low-deviation momentum
  const baseBullish = latest.bullishPct ?? 50;
  const devMomentum = sigmoid(lowDev1m / Math.max(tickSize * 4, atr1m * 0.45)) * 100;
  const combinedBullish = clamp(Math.round(0.75 * baseBullish + 0.25 * devMomentum), 1, 99);
  const combinedBearish = 100 - combinedBullish;
  const regime =
    combinedBullish >= 54 ? 'BULLISH' : combinedBullish <= 46 ? 'BEARISH' : 'NEUTRAL';

  // Directional Support & Resistance Forecast for the upcoming 1m candle
  const effectiveSigmaLow = Math.max(tickSize * 2, stdDevLow1m || atr1m * 0.45);
  const effectiveSigmaHigh = Math.max(tickSize * 2, stdDevHigh1m || atr1m * 0.45);
  const k = Math.max(0.1, stdDevMultiplier);

  // 5s-derived projected 1m drift blended with realized 1m drift
  const driftLow = 0.55 * avgLowDev1m + 0.45 * (avgStepLow5s * 12);
  const driftHigh = 0.55 * avgHighDev1m + 0.45 * (avgStepHigh5s * 12);

  let predictedNextSupport: number;
  let predictedNextResistance: number;

  if (combinedBullish >= 50) {
    // Bullish: low shifts higher / holds near forming low minus volatility band; resistance extends forward
    const bullishLowAdvance = clamp(driftLow * 0.35, 0, effectiveSigmaLow * 0.8);
    predictedNextSupport = roundToTick(
      forming1m.low + bullishLowAdvance - k * effectiveSigmaLow * 0.65,
      tickSize
    );
    const bullishHighAdvance = Math.max(0, driftHigh * 0.45);
    predictedNextResistance = roundToTick(
      forming1m.high + bullishHighAdvance + k * effectiveSigmaHigh,
      tickSize
    );
  } else {
    // Bearish: support steps down below current low; resistance gets capped lower
    const bearishLowDrop = Math.min(0, driftLow * 0.45);
    predictedNextSupport = roundToTick(
      forming1m.low + bearishLowDrop - k * effectiveSigmaLow,
      tickSize
    );
    const bearishHighDrop = clamp(driftHigh * 0.35, -effectiveSigmaHigh * 0.8, 0);
    predictedNextResistance = roundToTick(
      forming1m.high + bearishHighDrop + k * effectiveSigmaHigh * 0.65,
      tickSize
    );
  }

  // Ensure sensible ordering (Support <= Resistance)
  if (predictedNextSupport >= predictedNextResistance) {
    const mid = (predictedNextSupport + predictedNextResistance) / 2;
    predictedNextSupport = roundToTick(mid - effectiveSigmaLow * 0.5, tickSize);
    predictedNextResistance = roundToTick(mid + effectiveSigmaHigh * 0.5, tickSize);
  }

  const nowSec = Math.floor(nowMs / 1000);
  const secondInMinute = ((nowSec % 60) + 60) % 60;
  const secondsRemainingInMinute = 60 - secondInMinute;
  const currentMinuteStartSec = Math.floor(nowSec / 60) * 60;

  let phase: EarlyPhase = 'BUILDING';
  if (secondInMinute >= 55) phase = 'FINAL_55S';
  else if (secondInMinute >= 50) phase = 'EARLY_50S';

  let locked50s =
    prevLocked50s && prevLocked50s.minuteStartSec === currentMinuteStartSec
      ? prevLocked50s
      : null;
  let locked55s =
    prevLocked55s && prevLocked55s.minuteStartSec === currentMinuteStartSec
      ? prevLocked55s
      : null;

  if (secondInMinute >= 50 && !locked50s) {
    locked50s = {
      minuteStartSec: currentMinuteStartSec,
      capturedAtSec: nowSec,
      predictedSupport: round2(predictedNextSupport),
      predictedResistance: round2(predictedNextResistance),
      bullishPct: combinedBullish,
      bearishPct: combinedBearish,
      lowDev1m,
    };
  }
  if (secondInMinute >= 55 && !locked55s) {
    locked55s = {
      minuteStartSec: currentMinuteStartSec,
      capturedAtSec: nowSec,
      predictedSupport: round2(predictedNextSupport),
      predictedResistance: round2(predictedNextResistance),
      bullishPct: combinedBullish,
      bearishPct: combinedBearish,
      lowDev1m,
    };
  }

  const ltp = round2(latest.close);
  const change = round2(ltp - prevDayClose);
  const changePct = prevDayClose > 0 ? round2((change / prevDayClose) * 100) : 0;

  // 1m EMAs, rolling 15-minute structure, and intraday Option VWAP (Spot has no volume in live feed)
  const effectiveBars1m = bars1m.length > 0 ? bars1m : [forming1m];
  const closes1m = effectiveBars1m.map((b) => b.close);
  const ema9_1m = round2(computeEMA(closes1m, 9));
  const ema21_1m = round2(computeEMA(closes1m, 21));
  const swingWindow15 = effectiveBars1m.slice(-15);
  const swing15mHigh = round2(Math.max(...swingWindow15.map((b) => b.high)));
  const swing15mLow = round2(Math.min(...swingWindow15.map((b) => b.low)));
  const vwap =
    key === 'CE_OPTION' || key === 'PE_OPTION' ? computeSessionVwap(effectiveBars1m) : null;

  return {
    key,
    timestampMs: nowMs,
    istTimeStr: formatIstTime(nowMs),
    secondInMinute,
    secondsRemainingInMinute,
    phase,
    ltp,
    prevClose: round2(prevDayClose),
    change,
    changePct,
    windowMinutes,
    sampleCount5s: recent5s.length,
    avgStepLow5s: round2(avgStepLow5s),
    stdDevLow5s: round2(stdDevLow5s),
    avgStepHigh5s: round2(avgStepHigh5s),
    stdDevHigh5s: round2(stdDevHigh5s),
    atr5s: round2(atr5s),
    atr1m: round2(atr1m),
    forming1mOpen: round2(forming1m.open),
    forming1mHigh: round2(forming1m.high),
    forming1mLow: round2(forming1m.low),
    forming1mClose: round2(forming1m.close),
    prev1mHigh: round2(prev1m.high),
    prev1mLow: round2(prev1m.low),
    prev1mClose: round2(prev1m.close),
    lowDev1m,
    highDev1m,
    avgLowDev1m: round2(avgLowDev1m),
    stdDevLow1m: round2(stdDevLow1m),
    probLine: round2(latest.probLine ?? ltp),
    ema9_1m,
    ema21_1m,
    vwap,
    swing15mHigh,
    swing15mLow,
    bullishPct: combinedBullish,
    bearishPct: combinedBearish,
    regime,
    predictedNextSupport: round2(predictedNextSupport),
    predictedNextResistance: round2(predictedNextResistance),
    supportDelta: round2(predictedNextSupport - forming1m.low),
    resistanceDelta: round2(predictedNextResistance - forming1m.high),
    locked50s,
    locked55s,
  };
}

/**
 * Replays stored 5-second candles minute-by-minute, cutting off at `triggerSecond`
 * (e.g. :50s or :55s) so there is zero look-ahead bias, then compares the prediction
 * against the actual next 1-minute candle!
 */
export function runBacktestOn5sCandles(params: {
  streamKey: StreamKey;
  symbol: string;
  candles5s: Candle[];
  windowMinutes: number;
  stdDevMultiplier: number;
  triggerSecond: 45 | 50 | 55;
  tickSize: number;
}): BacktestSummary {
  const {
    streamKey,
    symbol,
    candles5s,
    windowMinutes,
    stdDevMultiplier,
    triggerSecond,
    tickSize,
  } = params;

  if (candles5s.length < 36) {
    return {
      streamKey,
      symbol,
      totalPredictions: 0,
      rangeHitCount: 0,
      rangeHitRatePct: 0,
      supportHoldRatePct: 0,
      resistanceCapRatePct: 0,
      directionHitRatePct: 0,
      avgSupportErrorPts: 0,
      avgResistanceErrorPts: 0,
      rows: [],
    };
  }

  // Group 5s candles by 1-minute bucket
  const minuteMap = new Map<number, Candle[]>();
  for (const c of candles5s) {
    const minSec = Math.floor(c.time / 60) * 60;
    const arr = minuteMap.get(minSec) ?? [];
    arr.push(c);
    minuteMap.set(minSec, arr);
  }
  const minutes = Array.from(minuteMap.keys()).sort((a, b) => a - b);

  const rows: BacktestRow[] = [];
  let supportHoldCount = 0;
  let resistanceCapCount = 0;
  const prevDayClose = candles5s[0].open;

  // Start evaluating once we have at least `windowMinutes` full minutes
  for (let mIdx = windowMinutes; mIdx < minutes.length - 1; mIdx++) {
    const currentMin = minutes[mIdx];
    const nextMin = minutes[mIdx + 1];
    const nextMinBars = minuteMap.get(nextMin) ?? [];
    if (nextMinBars.length < 10) continue; // skip incomplete trailing minute

    // Cut-off timestamp = currentMin + triggerSecond (strictly no future data!)
    const cutoffSec = currentMin + triggerSecond;
    const prefixBars = candles5s.filter((c) => c.time <= cutoffSec);
    if (prefixBars.length < 12) continue;

    const snap = computeRadarSnapshot({
      key: streamKey,
      candles5s: prefixBars,
      prevDayClose,
      nowMs: cutoffSec * 1000,
      windowMinutes,
      stdDevMultiplier,
      tickSize,
    });

    const actualOpen = nextMinBars[0].open;
    const actualHigh = Math.max(...nextMinBars.map((b) => b.high));
    const actualLow = Math.min(...nextMinBars.map((b) => b.low));
    const actualClose = nextMinBars[nextMinBars.length - 1].close;

    const tol = Math.max(tickSize * 2, snap.atr5s * 0.5);
    const supportHeld = actualLow >= snap.predictedNextSupport - tol;
    const resistanceRespected = actualHigh <= snap.predictedNextResistance + tol;
    if (supportHeld) supportHoldCount++;
    if (resistanceRespected) resistanceCapCount++;
    const rangeHit = supportHeld && resistanceRespected;

    const predictedUp = snap.bullishPct >= 50;
    const actualUp = actualClose >= actualOpen || actualLow >= snap.forming1mLow;
    const directionHit = predictedUp === actualUp;

    rows.push({
      targetMinuteSec: nextMin,
      timeLabel: formatIstMinute(nextMin),
      baseLow: snap.forming1mLow,
      baseHigh: snap.forming1mHigh,
      lowDev1m: snap.lowDev1m,
      stdDev: snap.stdDevLow1m,
      bullishPct: snap.bullishPct,
      bearishPct: snap.bearishPct,
      predictedSupport: snap.predictedNextSupport,
      predictedResistance: snap.predictedNextResistance,
      actualLow: round2(actualLow),
      actualHigh: round2(actualHigh),
      actualClose: round2(actualClose),
      lowErrorPts: round2(Math.abs(actualLow - snap.predictedNextSupport)),
      highErrorPts: round2(Math.abs(actualHigh - snap.predictedNextResistance)),
      rangeHit,
      directionHit,
    });
  }

  const total = rows.length;
  if (total === 0) {
    return {
      streamKey,
      symbol,
      totalPredictions: 0,
      rangeHitCount: 0,
      rangeHitRatePct: 0,
      supportHoldRatePct: 0,
      resistanceCapRatePct: 0,
      directionHitRatePct: 0,
      avgSupportErrorPts: 0,
      avgResistanceErrorPts: 0,
      rows: [],
    };
  }

  const rangeHitCount = rows.filter((r) => r.rangeHit).length;
  const dirHitCount = rows.filter((r) => r.directionHit).length;

  return {
    streamKey,
    symbol,
    totalPredictions: total,
    rangeHitCount,
    rangeHitRatePct: round2((rangeHitCount / total) * 100),
    supportHoldRatePct: round2((supportHoldCount / total) * 100),
    resistanceCapRatePct: round2((resistanceCapCount / total) * 100),
    directionHitRatePct: round2((dirHitCount / total) * 100),
    avgSupportErrorPts: round2(mean(rows.map((r) => r.lowErrorPts))),
    avgResistanceErrorPts: round2(mean(rows.map((r) => r.highErrorPts))),
    rows: rows.reverse(), // newest first for UI table
  };
}

function evaluateConfluenceSide(params: {
  optionType: 'CE' | 'PE';
  bn: RadarSnapshot;
  nf: RadarSnapshot;
  opt: RadarSnapshot;
  optCfg: InstrumentConfig;
}): ConfluenceSideEvaluation {
  const { optionType, bn, nf, opt, optCfg } = params;
  const isCe = optionType === 'CE';

  const bnEmaSep = bn.ema9_1m - bn.ema21_1m;
  const bnSpotPass = isCe
    ? bn.bullishPct >= 55 && bn.ltp > bn.probLine && bnEmaSep >= Math.max(2, bn.atr1m * 0.15)
    : bn.bullishPct <= 45 && bn.ltp < bn.probLine && bnEmaSep <= -Math.max(2, bn.atr1m * 0.15);

  const bnSpotCheck: ConfluenceCheckItem = {
    id: 'BN_SPOT',
    label: isCe ? 'BN Spot Bull + EMA9>21' : 'BN Spot Bear + EMA9<21',
    passed: bnSpotPass,
    detail: `${bn.bullishPct}% Bull · EMA9 ${bn.ema9_1m.toFixed(0)} vs ${bn.ema21_1m.toFixed(0)}`,
  };

  const nfPass = isCe
    ? nf.bullishPct >= 52 && nf.ltp >= nf.probLine - nf.atr1m * 0.15
    : nf.bullishPct <= 48 && nf.ltp <= nf.probLine + nf.atr1m * 0.15;

  const nfCheck: ConfluenceCheckItem = {
    id: 'NIFTY_SYNC',
    label: isCe ? 'Nifty ≥52% Sync' : 'Nifty ≤48% Sync',
    passed: nfPass,
    detail: `Nifty ${nf.bullishPct}% Bull (${nf.ltp.toFixed(1)})`,
  };

  const vwapClearance =
    opt.vwap == null
      ? true
      : opt.ltp >= opt.vwap + Math.max(2, opt.atr1m * 0.4, opt.vwap * 0.008) &&
        opt.ema9_1m >= opt.vwap;
  const optPass =
    opt.bullishPct >= 56 &&
    opt.ltp > opt.probLine &&
    opt.ema9_1m - opt.ema21_1m >= Math.max(0.5, opt.atr1m * 0.12) &&
    vwapClearance &&
    opt.lowDev1m >= 0;

  const optCheck: ConfluenceCheckItem = {
    id: 'OPTION_VWAP',
    label: opt.vwap != null ? `${optionType} > VWAP (+0.8%) & EMA` : `${optionType} Momentum`,
    passed: optPass,
    detail:
      opt.vwap != null
        ? `${opt.bullishPct}% Bull · LTP ₹${opt.ltp.toFixed(1)} vs VWAP ₹${opt.vwap.toFixed(1)}`
        : `${opt.bullishPct}% Bull · LowΔ ${opt.lowDev1m >= 0 ? '+' : ''}${opt.lowDev1m.toFixed(1)}`,
  };

  const bnRange15 = bn.swing15mHigh - bn.swing15mLow;
  const bnPos15 = bnRange15 > 0 ? (bn.ltp - bn.swing15mLow) / bnRange15 : 0.5;
  const optRange15 = opt.swing15mHigh - opt.swing15mLow;
  const optPos15 = optRange15 > 0 ? (opt.ltp - opt.swing15mLow) / optRange15 : 0.5;
  const structPass =
    bnRange15 >= Math.max(8, bn.atr1m * 1.4) &&
    (isCe ? bnPos15 >= 0.6 : bnPos15 <= 0.4) &&
    optPos15 >= 0.6;

  const structCheck: ConfluenceCheckItem = {
    id: 'STRUCTURE_15M',
    label: '15m Breakout Structure',
    passed: structPass,
    detail: `BN 15m ${bn.swing15mLow.toFixed(0)}–${bn.swing15mHigh.toFixed(0)} (${bnRange15.toFixed(0)}pt)`,
  };

  const qty = Math.max(1, optCfg.lots ?? 1) * Math.max(1, optCfg.lotSize ?? 30);
  const safeLtp = Math.max(0.5, opt.ltp);
  const estCharges = calcOptionRoundTripCharges(safeLtp, safeLtp, qty);
  const expectedRoomPts = round2(
    Math.max(opt.predictedNextResistance - opt.ltp, opt.atr1m * 3.0)
  );
  const rewardToCostRatio =
    estCharges.breakevenPts > 0 ? round2(expectedRoomPts / estCharges.breakevenPts) : 0;
  const costPass = rewardToCostRatio >= 4.0;

  const costCheck: ConfluenceCheckItem = {
    id: 'COST_EDGE',
    label: 'Target ≥ 4× FY26-27 Tax',
    passed: costPass,
    detail: `Room +${expectedRoomPts.toFixed(1)}pt vs Tax ${estCharges.breakevenPts.toFixed(1)}pt (${rewardToCostRatio.toFixed(1)}×)`,
  };

  const checks = [bnSpotCheck, nfCheck, optCheck, structCheck, costCheck];
  const score = checks.filter((c) => c.passed).length;
  const passed = score >= 4 && bnSpotCheck.passed && optCheck.passed && costCheck.passed;

  return {
    optionType,
    symbol: optCfg.symbol,
    ltp: round2(opt.ltp),
    score,
    passed,
    estCostRs: estCharges.totalCharges,
    breakevenPts: estCharges.breakevenPts,
    expectedRoomPts,
    rewardToCostRatio,
    checks,
  };
}

/**
 * Computes the live top-level 3-Way Confluence decision ("A+ CE", "A+ PE", or "CHOP WAIT")
 * combining Bank Nifty Spot, Nifty 50 Spot, Option + Session VWAP, 15m Structure, and FY 2026-27 Taxes.
 */
export function computeConfluenceSignal(params: {
  snapshots: Record<StreamKey, RadarSnapshot>;
  configs: Record<StreamKey, InstrumentConfig>;
}): ConfluenceSignal {
  const { snapshots, configs } = params;
  const bn = snapshots.BANKNIFTY_SPOT;
  const nf = snapshots.NIFTY_SPOT;
  const ce = snapshots.CE_OPTION;
  const pe = snapshots.PE_OPTION;

  const ceEval = evaluateConfluenceSide({
    optionType: 'CE',
    bn,
    nf,
    opt: ce,
    optCfg: configs.CE_OPTION,
  });
  const peEval = evaluateConfluenceSide({
    optionType: 'PE',
    bn,
    nf,
    opt: pe,
    optCfg: configs.PE_OPTION,
  });

  const suggestedAtmStrike = Math.round(bn.ltp / 100) * 100;

  let verdict: ConfluenceVerdict = 'CHOP_WAIT';
  let direction: 'CE' | 'PE' | 'NONE' = 'NONE';
  let activeEval = bn.bullishPct >= 50 ? ceEval : peEval;

  if (ceEval.passed && (!peEval.passed || ceEval.score >= peEval.score)) {
    verdict = 'A_PLUS_CE';
    direction = 'CE';
    activeEval = ceEval;
  } else if (peEval.passed) {
    verdict = 'A_PLUS_PE';
    direction = 'PE';
    activeEval = peEval;
  } else if (ceEval.score === 3 && bn.bullishPct >= 52 && (!peEval.passed && ceEval.score >= peEval.score)) {
    verdict = 'WATCH_CE';
    direction = 'CE';
    activeEval = ceEval;
  } else if (peEval.score === 3 && bn.bullishPct <= 48) {
    verdict = 'WATCH_PE';
    direction = 'PE';
    activeEval = peEval;
  }

  let headline = 'CHOP / SIDEWAYS — WAIT (NO TRADE · PROTECT CAPITAL)';
  let subline = `No 3-Way Alignment yet · Est. Cost ₹${activeEval.estCostRs.toFixed(0)} (${activeEval.breakevenPts.toFixed(1)}pt breakeven) vs +${activeEval.expectedRoomPts.toFixed(1)}pt room — Wait for clean setup.`;

  if (verdict === 'A_PLUS_CE') {
    headline = `A+ CALL (CE) READY — BUY ${ceEval.symbol}`;
    subline = `Score ${ceEval.score}/5 · Spot+Nifty+VWAP Aligned · Tax ₹${ceEval.estCostRs.toFixed(0)} (${ceEval.breakevenPts.toFixed(1)}pt) vs +${ceEval.expectedRoomPts.toFixed(1)}pt room (${ceEval.rewardToCostRatio.toFixed(1)}× edge).`;
  } else if (verdict === 'A_PLUS_PE') {
    headline = `A+ PUT (PE) READY — BUY ${peEval.symbol}`;
    subline = `Score ${peEval.score}/5 · BN Falling + Nifty+PE VWAP Aligned · Tax ₹${peEval.estCostRs.toFixed(0)} (${peEval.breakevenPts.toFixed(1)}pt) vs +${peEval.expectedRoomPts.toFixed(1)}pt room (${peEval.rewardToCostRatio.toFixed(1)}× edge).`;
  } else if (verdict === 'WATCH_CE' || verdict === 'WATCH_PE') {
    headline = `${direction} SETUP FORMING (${activeEval.score}/5) — WAIT CONFIRMATION`;
    const missing = activeEval.checks
      .filter((c) => !c.passed)
      .map((c) => c.label)
      .join(', ');
    subline = `Missing: ${missing || 'Momentum confirm'} · Avoid entering early in chop.`;
  } else {
    const failed = activeEval.checks
      .filter((c) => !c.passed)
      .map((c) => c.label)
      .slice(0, 3)
      .join(' · ');
    subline = `Blocked (${activeEval.optionType} ${activeEval.score}/5): ${failed} · FY26-27 Tax ₹${activeEval.estCostRs.toFixed(0)}/trade eats choppy scalps.`;
  }

  return {
    verdict,
    direction,
    headline,
    subline,
    activeScore: activeEval.score,
    suggestedAtmStrike,
    ceEval,
    peEval,
  };
}

interface Bar1mState {
  time: number;
  open: number;
  close: number;
  high: number;
  low: number;
  prevLow: number;
  close5Ago: number;
  probLine: number;
  slope: number;
  ema9: number;
  ema21: number;
  vwap: number | null;
  swing15mHigh: number;
  swing15mLow: number;
  bullishPct: number;
  atr: number;
  atr14: number;
  predSup: number;
  predRes: number;
}

function buildIncremental1mStates(
  bars: Candle[],
  stdDevMultiplier: number,
  tickSize: number,
  trackVwap: boolean
): Bar1mState[] {
  const out: Bar1mState[] = [];
  if (bars.length === 0) return out;

  const alphaFast = 2 / (9 + 1);
  const alphaSlow = 2 / (24 + 1);
  const alpha9 = 2 / (9 + 1);
  const alpha21 = 2 / (21 + 1);

  let fastEma = bars[0].close;
  let slowEma = bars[0].close;
  let probLine = fastEma;
  let ema9 = bars[0].close;
  let ema21 = bars[0].close;

  let curDay = formatIstDateKey(bars[0].time);
  let cumTpVol = 0;
  let cumVol = 0;

  const trHistory: number[] = [];
  const tr14History: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    const prev = i > 0 ? bars[i - 1] : c;
    const typical = (c.high + c.low + c.close) / 3;

    fastEma = alphaFast * typical + (1 - alphaFast) * fastEma;
    slowEma = alphaSlow * typical + (1 - alphaSlow) * slowEma;
    const prevProb = probLine;
    probLine = 0.65 * fastEma + 0.35 * slowEma;
    const slope = probLine - prevProb;

    if (i > 0) {
      ema9 = alpha9 * c.close + (1 - alpha9) * ema9;
      ema21 = alpha21 * c.close + (1 - alpha21) * ema21;
    }

    const dayKey = formatIstDateKey(c.time);
    if (dayKey !== curDay) {
      curDay = dayKey;
      cumTpVol = 0;
      cumVol = 0;
    }
    if (trackVwap && c.volume > 0) {
      cumTpVol += typical * c.volume;
      cumVol += c.volume;
    }
    const vwap = trackVwap && cumVol > 0 ? round2(cumTpVol / cumVol) : null;

    if (i > 0) {
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      );
      trHistory.push(tr);
      if (trHistory.length > 5) trHistory.shift();
      tr14History.push(tr);
      if (tr14History.length > 14) tr14History.shift();
    }
    const atr = Math.max(tickSize * 2, trHistory.length > 0 ? mean(trHistory) : c.high - c.low);
    const atr14 = Math.max(tickSize * 2, tr14History.length > 0 ? mean(tr14History) : c.high - c.low);

    // 3m window steps (last 4 bars => 3 consecutive diffs)
    const winStart = Math.max(0, i - 3);
    let hlCount = 0;
    let steps = 0;
    const lowSteps: number[] = [];
    const highSteps: number[] = [];
    for (let j = winStart + 1; j <= i; j++) {
      steps++;
      if (bars[j].low > bars[j - 1].low) hlCount += 1;
      else if (bars[j].low === bars[j - 1].low && bars[j].close >= bars[j - 1].close) {
        hlCount += 0.5;
      }
      lowSteps.push(bars[j].low - bars[j - 1].low);
      highSteps.push(bars[j].high - bars[j - 1].high);
    }

    const sampleWeight = Math.min(1, steps / 4);
    const hlRatio = sampleWeight * (steps > 0 ? hlCount / steps : 0.5) + (1 - sampleWeight) * 0.5;
    const distScore = sigmoid((c.close - probLine) / (atr * 0.85));
    const slopeScore = sigmoid(slope / (atr * 0.22));
    const baseBull = (0.38 * hlRatio + 0.37 * distScore + 0.25 * slopeScore) * 100;

    const lowDev = c.low - prev.low;
    const devMom = sigmoid(lowDev / Math.max(tickSize * 4, atr * 0.45)) * 100;
    const bullishPct = clamp(Math.round(0.75 * baseBull + 0.25 * devMom), 1, 99);

    const sigL = Math.max(tickSize * 2, stdDev(lowSteps) || atr * 0.45);
    const sigH = Math.max(tickSize * 2, stdDev(highSteps) || atr * 0.45);
    const dL = mean(lowSteps);
    const dH = mean(highSteps);

    let predSup: number;
    let predRes: number;
    if (bullishPct >= 50) {
      predSup = roundToTick(c.low + clamp(dL * 0.35, 0, sigL * 0.8) - stdDevMultiplier * sigL * 0.65, tickSize);
      predRes = roundToTick(c.high + Math.max(0, dH * 0.45) + stdDevMultiplier * sigH, tickSize);
    } else {
      predSup = roundToTick(c.low + Math.min(0, dL * 0.45) - stdDevMultiplier * sigL, tickSize);
      predRes = roundToTick(c.high + clamp(dH * 0.35, -sigH * 0.8, 0) + stdDevMultiplier * sigH * 0.65, tickSize);
    }
    if (predSup >= predRes) {
      const mid = (predSup + predRes) / 2;
      predSup = roundToTick(mid - sigL * 0.5, tickSize);
      predRes = roundToTick(mid + sigH * 0.5, tickSize);
    }

    const s15Start = Math.max(0, i - 14);
    let s15High = bars[s15Start].high;
    let s15Low = bars[s15Start].low;
    for (let k = s15Start + 1; k <= i; k++) {
      if (bars[k].high > s15High) s15High = bars[k].high;
      if (bars[k].low < s15Low) s15Low = bars[k].low;
    }

    const close5Ago = i >= 5 ? bars[i - 5].close : bars[0].close;

    out.push({
      time: c.time,
      open: c.open,
      close: c.close,
      high: c.high,
      low: c.low,
      prevLow: prev.low,
      close5Ago,
      probLine: round2(probLine),
      slope,
      ema9,
      ema21,
      vwap,
      swing15mHigh: s15High,
      swing15mLow: s15Low,
      bullishPct,
      atr,
      atr14,
      predSup: round2(predSup),
      predRes: round2(predRes),
    });
  }

  return out;
}

function executeStrategySimulation(params: {
  optionType: 'CE' | 'PE';
  optBars1m: Candle[];
  bnStates: Bar1mState[];
  nfStates: Bar1mState[];
  optStates: Bar1mState[];
  strategy: StrategyPreset;
  qty: number;
  maxTrades: number;
  cooldownMinutes: number;
  minCostMult: number;
  slAtrMult: number;
  trailingEnabled: boolean;
  tickSize: number;
}): {
  trades: SimulatedTradeRow[];
  grossPnlRs: number;
  totalChargesRs: number;
  totalSttRs: number;
  netPnlRs: number;
  maxDrawdownRs: number;
} {
  const {
    optionType,
    optBars1m,
    bnStates,
    nfStates,
    optStates,
    strategy,
    qty,
    maxTrades,
    cooldownMinutes,
    minCostMult,
    slAtrMult,
    trailingEnabled,
    tickSize,
  } = params;

  const isCe = optionType === 'CE';
  const trades: SimulatedTradeRow[] = [];
  let bnPtr = 0;
  let nfPtr = 0;
  let coolUntilIdx = -1;

  interface OpenPos {
    entryTimeSec: number;
    entryTime: string;
    entryPrice: number;
    sl: number | null;
    tgt: number;
    peak: number;
    atr: number;
    breakevenPts: number;
    note: string;
  }
  let pos: OpenPos | null = null;

  const firstBarHhmm = formatIstMinute(optBars1m[0].time);
  const startsNearMarketOpen = firstBarHhmm >= '09:14' && firstBarHhmm <= '09:20';

  const closePosition = (
    openPos: OpenPos,
    exitBarTime: number,
    exitPrice: number,
    reason: SimulatedTradeRow['reason']
  ) => {
    const safeExit = Math.max(0.05, roundToTick(exitPrice, tickSize));
    const charges = calcOptionRoundTripCharges(openPos.entryPrice, safeExit, qty);
    const pnlPts = round2(safeExit - openPos.entryPrice);
    const grossRs = round2(pnlPts * qty);
    const netRs = round2(grossRs - charges.totalCharges);
    trades.push({
      id: trades.length + 1,
      entryTimeSec: openPos.entryTimeSec,
      exitTimeSec: exitBarTime,
      entryTime: openPos.entryTime,
      exitTime: formatIstMinute(exitBarTime),
      entryPrice: round2(openPos.entryPrice),
      exitPrice: safeExit,
      pnlPts,
      reason,
      grossRs,
      chargesRs: charges.totalCharges,
      sttRs: charges.stt,
      netRs,
      note: openPos.note,
    });
  };

  for (let i = 4; i < optBars1m.length - 1; i++) {
    const oSig = optStates[i];
    const nextBar = optBars1m[i + 1];
    const hhmm = formatIstMinute(nextBar.time);

    while (bnPtr + 1 < bnStates.length && bnStates[bnPtr + 1].time <= oSig.time) {
      bnPtr++;
    }
    while (nfPtr + 1 < nfStates.length && nfStates[nfPtr + 1].time <= oSig.time) {
      nfPtr++;
    }
    const bSig = bnStates[bnPtr];
    const nSig = nfStates[nfPtr];

    if (!pos) {
      const cap = strategy === 'NAIVE_SR' ? 999 : maxTrades;
      if (trades.length >= cap || i < coolUntilIdx) continue;
      if (startsNearMarketOpen && hhmm < (strategy === 'STRONG_CONFLUENCE' ? '09:40' : '09:25')) continue;
      if (hhmm > (strategy === 'STRONG_CONFLUENCE' ? '15:10' : '15:14') && hhmm <= '15:30') continue;

      if (strategy === 'NAIVE_SR') {
        if (nextBar.low <= oSig.predSup && nextBar.open >= oSig.predSup * 0.96) {
          const ep = Math.min(nextBar.open, oSig.predSup);
          const ch = calcOptionRoundTripCharges(ep, ep, qty);
          if (nextBar.high >= oSig.predRes) {
            closePosition(
              {
                entryTimeSec: nextBar.time,
                entryTime: hhmm,
                entryPrice: ep,
                sl: null,
                tgt: oSig.predRes,
                peak: ep,
                atr: oSig.atr,
                breakevenPts: ch.breakevenPts,
                note: 'Blind Limit@Support',
              },
              nextBar.time,
              oSig.predRes,
              'TARGET_RES'
            );
          } else {
            pos = {
              entryTimeSec: nextBar.time,
              entryTime: hhmm,
              entryPrice: ep,
              sl: null,
              tgt: oSig.predRes,
              peak: ep,
              atr: oSig.atr,
              breakevenPts: ch.breakevenPts,
              note: 'Blind Limit@Support',
            };
          }
        }
        continue;
      }

      if (strategy === 'TREND_SR') {
        if (oSig.bullishPct < 54 || oSig.close <= oSig.probLine) continue;
        if (nextBar.low <= oSig.predSup && nextBar.open >= oSig.predSup * 0.96) {
          const ep = Math.min(nextBar.open, oSig.predSup);
          const sl = roundToTick(ep - slAtrMult * oSig.atr, tickSize);
          const ch = calcOptionRoundTripCharges(ep, ep, qty);
          const curPos: OpenPos = {
            entryTimeSec: nextBar.time,
            entryTime: hhmm,
            entryPrice: ep,
            sl,
            tgt: oSig.predRes,
            peak: ep,
            atr: oSig.atr,
            breakevenPts: ch.breakevenPts,
            note: `Opt ${oSig.bullishPct}% Bull`,
          };
          if (nextBar.low <= sl) {
            closePosition(curPos, nextBar.time, sl, 'STOP_LOSS');
          } else if (nextBar.high >= oSig.predRes) {
            closePosition(curPos, nextBar.time, oSig.predRes, 'TARGET_RES');
          } else {
            pos = curPos;
          }
        }
        continue;
      }

      // STRONG_CONFLUENCE: 3-Way Alignment + VWAP Clearance + 15m Structure + Pullback Entry Discipline
      if (i < 15 || !bSig || !nSig) continue;

      const bnEmaSep = bSig.ema9 - bSig.ema21;
      const bnProg5 = bSig.close - bSig.close5Ago;
      const bnCandleOk = isCe ? bSig.close >= bSig.open : bSig.close <= bSig.open;
      const bnOk = isCe
        ? bnCandleOk &&
          bnProg5 > 0 &&
          bSig.bullishPct >= 55 &&
          bSig.close > bSig.probLine &&
          bnEmaSep >= bSig.atr14 * 0.25 &&
          bSig.close > bSig.ema9
        : bnCandleOk &&
          bnProg5 < 0 &&
          bSig.bullishPct <= 45 &&
          bSig.close < bSig.probLine &&
          bnEmaSep <= -bSig.atr14 * 0.25 &&
          bSig.close < bSig.ema9;

      const nfOk = isCe
        ? nSig.bullishPct >= 52 && nSig.ema9 >= nSig.ema21 && nSig.close >= nSig.probLine - nSig.atr14 * 0.15
        : nSig.bullishPct <= 48 && nSig.ema9 <= nSig.ema21 && nSig.close <= nSig.probLine + nSig.atr14 * 0.15;

      const vwapReq =
        oSig.vwap == null ? 0 : oSig.vwap + Math.max(3, oSig.atr14 * 0.45, oSig.vwap * 0.008);
      const vwapMargin = oSig.vwap == null ? true : oSig.close >= vwapReq && oSig.ema9 >= oSig.vwap;
      const optEmaSep = oSig.ema9 - oSig.ema21;
      const notExtendedEma = (oSig.close - oSig.ema9) <= 1.2 * oSig.atr14;
      const optOk =
        oSig.close >= oSig.open &&
        oSig.bullishPct >= 56 &&
        oSig.close > oSig.probLine &&
        optEmaSep >= oSig.atr14 * 0.15 &&
        vwapMargin &&
        notExtendedEma;

      const bnRange15 = bSig.swing15mHigh - bSig.swing15mLow;
      const bnPos15 = bnRange15 > 0 ? (bSig.close - bSig.swing15mLow) / bnRange15 : 0.5;
      const optRange15 = oSig.swing15mHigh - oSig.swing15mLow;
      const optPos15 = optRange15 > 0 ? (oSig.close - oSig.swing15mLow) / optRange15 : 0.5;
      const structOk =
        bnRange15 >= Math.max(10, bSig.atr14 * 1.5) &&
        (isCe ? bnPos15 >= 0.65 : bnPos15 <= 0.35) &&
        optPos15 >= 0.65;

      if (!bnOk || !nfOk || !optOk || !structOk) continue;

      const entryZone = roundToTick(
        Math.max(oSig.predSup, oSig.ema9 + 0.15 * oSig.atr14, oSig.probLine - 0.15 * oSig.atr14),
        tickSize
      );
      const pulledBack = nextBar.low <= entryZone;
      const freshCoilBreak =
        !pulledBack &&
        oSig.close - oSig.ema9 <= 0.85 * oSig.atr14 &&
        nextBar.open <= oSig.close + 0.25 * oSig.atr14;
      if (!pulledBack && !freshCoilBreak) continue;

      const ep = pulledBack ? Math.min(nextBar.open, entryZone) : nextBar.open;
      if (ep <= 0) continue;

      const estCost = calcOptionRoundTripCharges(ep, ep, qty);
      const target = roundToTick(
        Math.max(oSig.predRes, ep + Math.max(2.6, slAtrMult * 2.15) * oSig.atr14),
        tickSize
      );
      if (target - ep < estCost.breakevenPts * minCostMult) continue;

      const sl = roundToTick(ep - slAtrMult * oSig.atr14, tickSize);
      const roomRatio = estCost.breakevenPts > 0 ? (target - ep) / estCost.breakevenPts : 0;
      const curPos: OpenPos = {
        entryTimeSec: nextBar.time,
        entryTime: hhmm,
        entryPrice: ep,
        sl,
        tgt: target,
        peak: ep,
        atr: oSig.atr14,
        breakevenPts: estCost.breakevenPts,
        note: `BN ${bSig.bullishPct}% · NF ${nSig.bullishPct}% · Edge ${roomRatio.toFixed(1)}×`,
      };

      if (nextBar.low <= sl) {
        closePosition(curPos, nextBar.time, Math.min(nextBar.open, sl), 'STOP_LOSS');
        coolUntilIdx = i + 1 + cooldownMinutes;
      } else if (nextBar.high >= target) {
        closePosition(curPos, nextBar.time, nextBar.open > target ? nextBar.open : target, 'TARGET_RES');
        coolUntilIdx = i + 1 + cooldownMinutes;
      } else {
        pos = curPos;
      }
    } else {
      // Manage open position conservatively on `nextBar`
      const activeTarget = strategy === 'STRONG_CONFLUENCE' ? pos.tgt : oSig.predRes;

      if (pos.sl != null && nextBar.low <= pos.sl) {
        const xp = Math.min(nextBar.open, pos.sl);
        const reason: SimulatedTradeRow['reason'] =
          xp > pos.entryPrice ? 'TRAILING_SL' : 'STOP_LOSS';
        closePosition(pos, nextBar.time, xp, reason);
        pos = null;
        coolUntilIdx = i + 1 + cooldownMinutes;
      } else if (nextBar.high >= activeTarget) {
        const xp = nextBar.open > activeTarget ? nextBar.open : activeTarget;
        closePosition(pos, nextBar.time, xp, 'TARGET_RES');
        pos = null;
        coolUntilIdx = i + 1 + cooldownMinutes;
      } else if (strategy === 'TREND_SR' && oSig.bullishPct <= 44) {
        closePosition(pos, nextBar.time, nextBar.open, 'TREND_EXIT');
        pos = null;
      } else if (strategy === 'STRONG_CONFLUENCE' && trailingEnabled && pos.sl != null) {
        pos.peak = Math.max(pos.peak, nextBar.high);
        if (pos.peak - pos.entryPrice >= 2.2 * pos.atr) {
          const breakevenFloor = roundToTick(pos.entryPrice + pos.breakevenPts + 2, tickSize);
          const trailSl = roundToTick(pos.peak - 1.55 * pos.atr, tickSize);
          pos.sl = Math.max(pos.sl, breakevenFloor, trailSl);
        }
      }
    }
  }

  if (pos) {
    const lastBar = optBars1m[optBars1m.length - 1];
    closePosition(pos, lastBar.time, lastBar.close, 'MARK_TO_MKT');
  }

  let runningEquity = 0;
  let peakEquity = 0;
  let maxDd = 0;
  let grossPnlRs = 0;
  let totalChargesRs = 0;
  let totalSttRs = 0;

  for (const t of trades) {
    grossPnlRs += t.grossRs;
    totalChargesRs += t.chargesRs;
    totalSttRs += t.sttRs;
    runningEquity += t.netRs;
    if (runningEquity > peakEquity) peakEquity = runningEquity;
    const dd = peakEquity - runningEquity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: trades.slice().reverse(),
    grossPnlRs: round2(grossPnlRs),
    totalChargesRs: round2(totalChargesRs),
    totalSttRs: round2(totalSttRs),
    netPnlRs: round2(grossPnlRs - totalChargesRs),
    maxDrawdownRs: round2(maxDd),
  };
}

/**
 * Look-ahead-free intraday option strategy backtester with exact FY 2026-27
 * Dhan + NSE + 0.15% STT cost deduction and side-by-side Naive vs Strong comparison.
 */
export function runStrategyBacktest(input: {
  params: StrategyBacktestParams;
  symbol: string;
  lotSize: number;
  tickSize: number;
  dataSourceLabel: string;
  bnBars1m: Candle[];
  nfBars1m: Candle[];
  optBars1m: Candle[];
}): StrategyBacktestSummary {
  const {
    params,
    symbol,
    lotSize,
    tickSize,
    dataSourceLabel,
    bnBars1m,
    nfBars1m,
    optBars1m,
  } = input;

  const qty = Math.max(1, params.lots) * Math.max(1, lotSize);
  const optionType: 'CE' | 'PE' = params.optionKey === 'CE_OPTION' ? 'CE' : 'PE';

  if (optBars1m.length < 10) {
    return {
      optionKey: params.optionKey,
      symbol,
      strategy: params.strategy,
      dataSourceLabel,
      barsEvaluated: optBars1m.length,
      sessionStartIst: optBars1m[0] ? formatIstMinute(optBars1m[0].time) : '--:--',
      sessionEndIst: optBars1m[optBars1m.length - 1]
        ? formatIstMinute(optBars1m[optBars1m.length - 1].time)
        : '--:--',
      qty,
      tradeCount: 0,
      winCount: 0,
      lossCount: 0,
      winRatePct: 0,
      grossPnlRs: 0,
      totalChargesRs: 0,
      totalSttRs: 0,
      netPnlRs: 0,
      avgChargePerTradeRs: 0,
      maxDrawdownRs: 0,
      trades: [],
    };
  }

  const bnStates = buildIncremental1mStates(bnBars1m, params.stdDevMultiplier, tickSize, false);
  const nfStates = buildIncremental1mStates(nfBars1m, params.stdDevMultiplier, tickSize, false);
  const optStates = buildIncremental1mStates(optBars1m, params.stdDevMultiplier, tickSize, true);

  const selectedRun = executeStrategySimulation({
    optionType,
    optBars1m,
    bnStates,
    nfStates,
    optStates,
    strategy: params.strategy,
    qty,
    maxTrades: params.maxTrades,
    cooldownMinutes: params.cooldownMinutes,
    minCostMult: params.minCostMult,
    slAtrMult: params.slAtrMult,
    trailingEnabled: params.trailingEnabled,
    tickSize,
  });

  const naiveRun =
    params.strategy === 'NAIVE_SR'
      ? selectedRun
      : executeStrategySimulation({
          optionType,
          optBars1m,
          bnStates,
          nfStates,
          optStates,
          strategy: 'NAIVE_SR',
          qty,
          maxTrades: 999,
          cooldownMinutes: 0,
          minCostMult: 0,
          slAtrMult: params.slAtrMult,
          trailingEnabled: false,
          tickSize,
        });

  const strongRun =
    params.strategy === 'STRONG_CONFLUENCE'
      ? selectedRun
      : executeStrategySimulation({
          optionType,
          optBars1m,
          bnStates,
          nfStates,
          optStates,
          strategy: 'STRONG_CONFLUENCE',
          qty,
          maxTrades: params.maxTrades,
          cooldownMinutes: params.cooldownMinutes,
          minCostMult: params.minCostMult,
          slAtrMult: params.slAtrMult,
          trailingEnabled: params.trailingEnabled,
          tickSize,
        });

  const winCount = selectedRun.trades.filter((t) => t.netRs > 0).length;
  const tradeCount = selectedRun.trades.length;

  return {
    optionKey: params.optionKey,
    symbol,
    strategy: params.strategy,
    dataSourceLabel,
    barsEvaluated: optBars1m.length,
    sessionStartIst: formatIstMinute(optBars1m[0].time),
    sessionEndIst: formatIstMinute(optBars1m[optBars1m.length - 1].time),
    qty,
    tradeCount,
    winCount,
    lossCount: tradeCount - winCount,
    winRatePct: tradeCount > 0 ? round2((winCount / tradeCount) * 100) : 0,
    grossPnlRs: selectedRun.grossPnlRs,
    totalChargesRs: selectedRun.totalChargesRs,
    totalSttRs: selectedRun.totalSttRs,
    netPnlRs: selectedRun.netPnlRs,
    avgChargePerTradeRs: tradeCount > 0 ? round2(selectedRun.totalChargesRs / tradeCount) : 0,
    maxDrawdownRs: selectedRun.maxDrawdownRs,
    trades: selectedRun.trades,
    comparison: {
      naiveTrades: naiveRun.trades.length,
      naiveGrossRs: naiveRun.grossPnlRs,
      naiveChargesRs: naiveRun.totalChargesRs,
      naiveNetRs: naiveRun.netPnlRs,
      strongTrades: strongRun.trades.length,
      strongGrossRs: strongRun.grossPnlRs,
      strongChargesRs: strongRun.totalChargesRs,
      strongNetRs: strongRun.netPnlRs,
    },
  };
}
