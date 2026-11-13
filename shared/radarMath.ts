import type {
  BacktestRow,
  BacktestSummary,
  Candle,
  EarlyPhase,
  RadarSnapshot,
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

  const enriched: Candle[] = [];
  for (let i = 0; i < candles5s.length; i++) {
    const c = candles5s[i];
    const typical = (c.high + c.low + c.close) / 3;
    fastEma = alphaFast * typical + (1 - alphaFast) * fastEma;
    slowEma = alphaSlow * typical + (1 - alphaSlow) * slowEma;

    const probLine = round2(0.65 * fastEma + 0.35 * slowEma);
    const startIdx = Math.max(0, i - windowBars + 1);
    const win = candles5s.slice(startIdx, i + 1);

    let higherLowCount = 0;
    let totalSteps = 0;
    for (let j = 1; j < win.length; j++) {
      totalSteps++;
      if (win[j].low > win[j - 1].low) {
        higherLowCount += 1;
      } else if (win[j].low === win[j - 1].low && win[j].close >= win[j - 1].close) {
        higherLowCount += 0.5;
      }
    }

    const higherLowRatio = totalSteps > 0 ? higherLowCount / totalSteps : 0.5;
    const atr = Math.max(tickSize * 2, computeATR(win, 12));
    const prevLine = enriched.length > 0 ? (enriched[enriched.length - 1].probLine ?? probLine) : probLine;
    const lineSlope = probLine - prevLine;

    const distScore = sigmoid((c.close - probLine) / (atr * 0.85));
    const slopeScore = sigmoid(lineSlope / (atr * 0.22));
    const rawPct = (0.38 * higherLowRatio + 0.37 * distScore + 0.25 * slopeScore) * 100;
    const bullishPct = clamp(Math.round(rawPct), 1, 99);

    enriched.push({
      ...c,
      probLine,
      bullishPct,
    });
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
  } = params;

  const enriched = enrichWithProbabilityLine(candles5s, windowMinutes, tickSize);
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

  // Build 1-minute bars from all available 5s bars (typically 3m to 60m buffer)
  const bars1m = aggregateCandles(enriched, '1m');
  const forming1m = bars1m[bars1m.length - 1] ?? latest;
  const prev1m = bars1m.length >= 2 ? bars1m[bars1m.length - 2] : forming1m;

  const recent1m = bars1m.slice(-Math.max(4, windowMinutes + 1));
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
  const atr1m = bars1m.length >= 2 ? computeATR(bars1m, Math.max(3, windowMinutes)) : atr5s * Math.sqrt(12);

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
