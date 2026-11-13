import assert from 'node:assert/strict';
import {
  aggregateCandles,
  calcOptionRoundTripCharges,
  computeConfluenceSignal,
  computeRadarSnapshot,
  computeSessionVwap,
  runBacktestOn5sCandles,
  runStrategyBacktest,
} from '../shared/radarMath.js';
import type { Candle, InstrumentConfig, RadarSnapshot, StreamKey } from '../shared/types.js';
import {
  DhanClient,
  normalizeMarketQuoteResponse,
  parseDhanLttToUnixSec,
} from '../server/dhanClient.js';

// 1. Verify Bank Nifty 61360.45 -> 61368.00 bullish 1m low deviation & :55s early snapshot
const baseSec = 1794580320; // aligned minute
const bars5s: Candle[] = [];

// Minute 0 (14:32): Low = 61360.45, High = 61384
for (let i = 0; i < 12; i++) {
  const low = i === 0 ? 61360.45 : 61361 + i * 0.6;
  const high = 61364 + i * 1.5;
  bars5s.push({
    time: baseSec + i * 5,
    open: low + 0.5,
    high,
    low,
    close: high - 0.3,
    volume: 100,
  });
}

// Minute 1 (14:33) up to :55s (11 bars): Low = 61368.00, High = 61400
for (let i = 0; i < 11; i++) {
  const low = i === 0 ? 61368.0 : 61369 + i * 0.9;
  const high = 61372 + i * 2.8;
  bars5s.push({
    time: baseSec + 60 + i * 5,
    open: low + 0.4,
    high,
    low,
    close: high - 0.2,
    volume: 120,
  });
}

const bnSnap = computeRadarSnapshot({
  key: 'BANKNIFTY_SPOT',
  candles5s: bars5s,
  prevDayClose: 61310,
  nowMs: (baseSec + 60 + 55) * 1000,
  windowMinutes: 3,
  stdDevMultiplier: 1.0,
  tickSize: 0.05,
});

assert.equal(bnSnap.lowDev1m, 7.55, 'Expected 1m Low Deviation 61368.00 - 61360.45 = 7.55');
assert.equal(bnSnap.phase, 'FINAL_55S', 'Expected :55s phase');
assert.ok(bnSnap.locked55s !== null, 'Expected :55s tentative snapshot to lock');
assert.ok(bnSnap.bullishPct > 55, `Expected bullishPct > 55, got ${bnSnap.bullishPct}`);
assert.equal(bnSnap.bullishPct + bnSnap.bearishPct, 100);
assert.ok(
  bnSnap.predictedNextResistance > bnSnap.forming1mHigh,
  'Bullish resistance should extend above current high'
);
console.log('✓ Test 1 passed: Bank Nifty 61360.45 -> 61368 (+7.55) :55s snapshot:', {
  lowDev1m: bnSnap.lowDev1m,
  bullishPct: bnSnap.bullishPct,
  bearishPct: bnSnap.bearishPct,
  nextSupport: bnSnap.predictedNextSupport,
  nextResistance: bnSnap.predictedNextResistance,
});

// 2. Verify Option strike ~32 price candle (Low 28, High 36, Close 32)
const optBars: Candle[] = [];
for (let m = 0; m < 4; m++) {
  for (let i = 0; i < 12; i++) {
    const low = 28 + (i % 3);
    const high = 33 + (i % 4);
    optBars.push({
      time: baseSec + m * 60 + i * 5,
      open: 30,
      high: m === 3 && i === 11 ? 36 : high,
      low: m === 3 && i === 0 ? 28 : low,
      close: 32,
      volume: 500,
    });
  }
}
const optSnap = computeRadarSnapshot({
  key: 'CE_OPTION',
  candles5s: optBars,
  prevDayClose: 29,
  nowMs: (baseSec + 3 * 60 + 55) * 1000,
  windowMinutes: 3,
  stdDevMultiplier: 1.0,
  tickSize: 0.05,
});
assert.ok(
  optSnap.predictedNextSupport >= 20 && optSnap.predictedNextSupport <= 30,
  `Expected realistic option support near 24-28, got ${optSnap.predictedNextSupport}`
);
assert.ok(
  optSnap.predictedNextResistance >= 35 && optSnap.predictedNextResistance <= 44,
  `Expected realistic option resistance near 36-42, got ${optSnap.predictedNextResistance}`
);
console.log('✓ Test 2 passed: Option 28-36 range snapshot:', {
  support: optSnap.predictedNextSupport,
  resistance: optSnap.predictedNextResistance,
  stdDev1m: optSnap.stdDevLow1m,
});

// 3. Verify 10s / 1m candle aggregation & backtester
const bars1m = aggregateCandles(optBars, '1m');
assert.equal(bars1m.length, 4);

const btBars: Candle[] = [];
for (let m = 0; m < 10; m++) {
  for (let i = 0; i < 12; i++) {
    const p = 61350 + m * 4 + i * 0.4;
    btBars.push({
      time: baseSec + m * 60 + i * 5,
      open: p,
      high: p + 2.2,
      low: p - 1.8,
      close: p + 0.5,
      volume: 100,
    });
  }
}
const bt = runBacktestOn5sCandles({
  streamKey: 'BANKNIFTY_SPOT',
  symbol: 'BANKNIFTY',
  candles5s: btBars,
  windowMinutes: 3,
  stdDevMultiplier: 1.0,
  triggerSecond: 55,
  tickSize: 0.05,
});
assert.ok(bt.totalPredictions >= 5, `Expected >=5 backtest rows, got ${bt.totalPredictions}`);
assert.ok(bt.rangeHitRatePct >= 0 && bt.rangeHitRatePct <= 100);
console.log('✓ Test 3 passed: Look-ahead-free backtest:', {
  totalPredictions: bt.totalPredictions,
  rangeHitRatePct: bt.rangeHitRatePct,
  directionHitRatePct: bt.directionHitRatePct,
});

// 4. Verify DhanHQ v2 Binary Little-Endian Quote Packet decoding
const client = new DhanClient();
const packet = Buffer.alloc(50);
packet.writeUInt8(4, 0); // Quote packet
packet.writeInt16LE(50, 1); // Length
packet.writeUInt8(0, 3); // IDX_I
packet.writeInt32LE(25, 4); // BANKNIFTY SecurityId = 25
packet.writeFloatLE(61368.5, 8); // LTP
packet.writeInt16LE(1, 12); // LTQ
packet.writeInt32LE(1794580380, 14); // LTT
packet.writeFloatLE(61360.0, 18); // ATP
packet.writeInt32LE(12500, 22); // Volume

let decodedLtp = 0;
let decodedSecId = '';
client.on('tick', (ev) => {
  decodedLtp = ev.ltp;
  decodedSecId = ev.securityId;
});
(client as unknown as { parseBinaryPacket: (b: Buffer) => void }).parseBinaryPacket(packet);
assert.equal(decodedSecId, '25');
assert.ok(Math.abs(decodedLtp - 61368.5) < 0.01);
console.log('✓ Test 4 passed: DhanHQ v2 Binary Quote packet decoded:', {
  securityId: decodedSecId,
  ltp: decodedLtp,
});

// 5. Verify realistic MarketSimulator 25-minute backtest
import { MarketSimulator } from '../server/simulator.js';
const sim = new MarketSimulator();
const seeded = sim.seedHistory('USER_BULLISH_61360', 61300, 61300, 25);
const simBt = runBacktestOn5sCandles({
  streamKey: 'BANKNIFTY_SPOT',
  symbol: 'BANKNIFTY',
  candles5s: seeded.candlesByStream.BANKNIFTY_SPOT,
  windowMinutes: 3,
  stdDevMultiplier: 1.0,
  triggerSecond: 55,
  tickSize: 0.05,
});
const simBtWide = runBacktestOn5sCandles({
  streamKey: 'BANKNIFTY_SPOT',
  symbol: 'BANKNIFTY',
  candles5s: seeded.candlesByStream.BANKNIFTY_SPOT,
  windowMinutes: 3,
  stdDevMultiplier: 1.5,
  triggerSecond: 55,
  tickSize: 0.05,
});
assert.ok(simBt.totalPredictions >= 15);
assert.ok(simBt.rangeHitRatePct > 25 && simBt.rangeHitRatePct <= 100);
assert.ok(
  simBtWide.rangeHitRatePct >= simBt.rangeHitRatePct,
  `Expected k=1.5 (${simBtWide.rangeHitRatePct}%) >= k=1.0 (${simBt.rangeHitRatePct}%)`
);
console.log('✓ Test 5 passed: Realistic 25m Simulator Backtest:', {
  total: simBt.totalPredictions,
  k1RangeHitPct: simBt.rangeHitRatePct,
  k15RangeHitPct: simBtWide.rangeHitRatePct,
  supportHoldRatePct: simBt.supportHoldRatePct,
  directionHitRatePct: simBt.directionHitRatePct,
});

// 6. Verify 1-bar initial startup safety + bootstrap1m lowDev1m accuracy
const singleBar: Candle[] = [
  {
    time: baseSec + 60,
    open: 61045,
    high: 61048,
    low: 61042,
    close: 61047,
    volume: 10,
  },
];
const singleSnapNoBoot = computeRadarSnapshot({
  key: 'BANKNIFTY_SPOT',
  candles5s: singleBar,
  prevDayClose: 61518.5,
  nowMs: (baseSec + 60 + 2) * 1000,
  windowMinutes: 3,
  stdDevMultiplier: 1.0,
  tickSize: 0.05,
});
assert.ok(Number.isFinite(singleSnapNoBoot.predictedNextSupport));
assert.ok(Number.isFinite(singleSnapNoBoot.predictedNextResistance));
assert.ok(singleSnapNoBoot.predictedNextSupport < singleSnapNoBoot.predictedNextResistance);

const bootstrapPrev: Candle[] = [
  {
    time: baseSec,
    open: 61030,
    high: 61050,
    low: 61032.5,
    close: 61044,
    volume: 500,
  },
];
const singleSnapWithBoot = computeRadarSnapshot({
  key: 'BANKNIFTY_SPOT',
  candles5s: singleBar,
  prevDayClose: 61518.5,
  nowMs: (baseSec + 60 + 2) * 1000,
  windowMinutes: 3,
  stdDevMultiplier: 1.0,
  tickSize: 0.05,
  bootstrap1m: bootstrapPrev,
});
assert.equal(singleSnapWithBoot.lowDev1m, 9.5, 'Expected 61042 - 61032.5 = 9.50 using bootstrap1m');
assert.ok(singleSnapWithBoot.predictedNextSupport < singleSnapWithBoot.predictedNextResistance);
console.log('✓ Test 6 passed: 1-bar live warm-up + bootstrap1m lowDev1m:', {
  lowDev1m: singleSnapWithBoot.lowDev1m,
  support: singleSnapWithBoot.predictedNextSupport,
  resistance: singleSnapWithBoot.predictedNextResistance,
});

// 7. Verify Dhan Market Quote response normalization & IST LTT parsing
const parsedIstSec = parseDhanLttToUnixSec('13/11/2026 09:47:17', 999);
assert.equal(parsedIstSec, Math.floor(Date.parse('2026-11-13T09:47:17+05:30') / 1000));
const staleFallback = parseDhanLttToUnixSec('01/01/1980 00:00:00', 1794543439);
assert.equal(staleFallback, 1794543439);

const normalized = normalizeMarketQuoteResponse(
  {
    status: 'success',
    data: {
      IDX_I: {
        '25': {
          last_price: 61044.7,
          last_trade_time: '13/11/2026 09:47:17',
          volume: 0,
          oi: 0,
          ohlc: { open: 61300.55, close: 61518.5, high: 61300.55, low: 60862.2 },
        },
      },
      NSE_FNO: {
        '62341': {
          last_price: 519.8,
          last_trade_time: '13/11/2026 09:47:13',
          volume: 335340,
          oi: 232410,
          ohlc: { open: 740.35, close: 754.65, high: 740.35, low: 454.95 },
        },
      },
    },
  },
  1794543439
);
assert.equal(normalized.ticks.length, 2);
assert.equal(normalized.prevCloses.length, 2);
const bnQuoteTick = normalized.ticks.find((t) => t.securityId === '25');
const ceQuoteTick = normalized.ticks.find((t) => t.securityId === '62341');
assert.equal(bnQuoteTick?.ltp, 61044.7);
assert.equal(bnQuoteTick?.prevClose, 61518.5);
assert.equal(ceQuoteTick?.ltp, 519.8);
assert.equal(ceQuoteTick?.volume, 335340);
assert.equal(ceQuoteTick?.oi, 232410);
console.log('✓ Test 7 passed: Dhan REST Quote normalization & IST LTT parsing.');

// 8. Verify FY 2026-27 Dhan + NSE Option Charges (0.15% STT + ₹40 brokerage + NSE/IPFT + Stamp + GST)
const cheapCost = calcOptionRoundTripCharges(200, 215, 30);
assert.equal(cheapCost.brokerage, 40);
assert.equal(cheapCost.stt, Math.round(215 * 30 * 0.0015)); // 10
assert.ok(cheapCost.totalCharges > 55 && cheapCost.totalCharges < 70);
assert.ok(cheapCost.breakevenPts > 1.8 && cheapCost.breakevenPts < 2.4);

const expensiveCost = calcOptionRoundTripCharges(1370, 1385, 30);
assert.equal(expensiveCost.stt, Math.round(1385 * 30 * 0.0015)); // 62
assert.ok(expensiveCost.totalCharges > 135 && expensiveCost.totalCharges < 155);
console.log('✓ Test 8 passed: Exact FY 2026-27 Option Charges:', {
  at200Total: cheapCost.totalCharges,
  at1370Total: expensiveCost.totalCharges,
});

// 9. Verify Session VWAP (Option has VWAP, Spot IDX_I has null) & 3-Way Confluence Engine verdicts
assert.equal(
  computeSessionVwap([
    { time: baseSec, open: 100, high: 110, low: 90, close: 100, volume: 0 },
  ]),
  null
);
const testVwap = computeSessionVwap([
  { time: baseSec, open: 200, high: 210, low: 190, close: 200, volume: 100 }, // typical = 200
  { time: baseSec + 60, open: 220, high: 230, low: 210, close: 220, volume: 300 }, // typical = 220
]);
assert.equal(testVwap, 215); // (200*100 + 220*300) / 400

assert.equal(bnSnap.vwap, null, 'Spot IDX_I stream must keep vwap = null');
assert.ok(optSnap.vwap != null && optSnap.vwap > 20, `Option stream must compute VWAP, got ${optSnap.vwap}`);
assert.ok(bnSnap.ema9_1m > 0 && bnSnap.ema21_1m > 0);
assert.ok(bnSnap.swing15mHigh >= bnSnap.swing15mLow);

const mockConfigs: Record<StreamKey, InstrumentConfig> = {
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
    label: '61000 CE',
    symbol: 'BANKNIFTY 61000 CE',
    exchangeSegment: 'NSE_FNO',
    securityId: '1',
    lots: 1,
    lotSize: 30,
    tickSize: 0.05,
  },
  PE_OPTION: {
    key: 'PE_OPTION',
    label: '61000 PE',
    symbol: 'BANKNIFTY 61000 PE',
    exchangeSegment: 'NSE_FNO',
    securityId: '2',
    lots: 1,
    lotSize: 30,
    tickSize: 0.05,
  },
};

const mkSnap = (
  key: StreamKey,
  over: Partial<RadarSnapshot>
): RadarSnapshot => ({
  ...bnSnap,
  key,
  ...over,
});

const ceReadyConf = computeConfluenceSignal({
  configs: mockConfigs,
  snapshots: {
    BANKNIFTY_SPOT: mkSnap('BANKNIFTY_SPOT', {
      ltp: 61085,
      probLine: 61040,
      ema9_1m: 61065,
      ema21_1m: 61030,
      swing15mLow: 61000,
      swing15mHigh: 61090,
      atr1m: 18,
      bullishPct: 64,
    }),
    NIFTY_SPOT: mkSnap('NIFTY_SPOT', {
      ltp: 25660,
      probLine: 25645,
      atr1m: 8,
      bullishPct: 58,
    }),
    CE_OPTION: mkSnap('CE_OPTION', {
      ltp: 310,
      probLine: 298,
      vwap: 295,
      ema9_1m: 304,
      ema21_1m: 292,
      swing15mLow: 280,
      swing15mHigh: 315,
      predictedNextResistance: 325,
      atr1m: 6.5,
      lowDev1m: 3.5,
      bullishPct: 66,
    }),
    PE_OPTION: mkSnap('PE_OPTION', {
      ltp: 280,
      probLine: 295,
      vwap: 305,
      ema9_1m: 286,
      ema21_1m: 299,
      swing15mLow: 278,
      swing15mHigh: 312,
      predictedNextResistance: 288,
      atr1m: 5.5,
      lowDev1m: -4.2,
      bullishPct: 35,
    }),
  },
});
assert.equal(ceReadyConf.verdict, 'A_PLUS_CE', `Expected A_PLUS_CE, got ${ceReadyConf.verdict}`);
assert.equal(ceReadyConf.suggestedAtmStrike, 61100);

const chopConf = computeConfluenceSignal({
  configs: mockConfigs,
  snapshots: {
    BANKNIFTY_SPOT: mkSnap('BANKNIFTY_SPOT', {
      ltp: 61040,
      probLine: 61042,
      ema9_1m: 61039,
      ema21_1m: 61041,
      swing15mLow: 61030,
      swing15mHigh: 61048,
      atr1m: 22,
      bullishPct: 49,
    }),
    NIFTY_SPOT: mkSnap('NIFTY_SPOT', {
      ltp: 25640,
      probLine: 25644,
      atr1m: 8,
      bullishPct: 48,
    }),
    CE_OPTION: mkSnap('CE_OPTION', {
      ltp: 300,
      probLine: 303,
      vwap: 310,
      ema9_1m: 299,
      ema21_1m: 305,
      swing15mLow: 296,
      swing15mHigh: 308,
      predictedNextResistance: 302,
      atr1m: 1.5,
      lowDev1m: -1.5,
      bullishPct: 46,
    }),
    PE_OPTION: mkSnap('PE_OPTION', {
      ltp: 295,
      probLine: 298,
      vwap: 304,
      ema9_1m: 294,
      ema21_1m: 299,
      swing15mLow: 291,
      swing15mHigh: 301,
      predictedNextResistance: 297,
      atr1m: 1.4,
      lowDev1m: -1.0,
      bullishPct: 47,
    }),
  },
});
assert.equal(chopConf.verdict, 'CHOP_WAIT', `Expected CHOP_WAIT on sideways chop, got ${chopConf.verdict}`);
console.log('✓ Test 9 passed: Session VWAP & 3-Way Confluence Engine verdicts (A+ CE vs CHOP WAIT).');

// 10. Verify Net-of-Tax Strategy Backtester on 45-minute Simulator streams
const seeded45 = sim.seedHistory('BEARISH_BREAKDOWN', 61300, 61300, 45);
const stratSummary = runStrategyBacktest({
  params: {
    optionKey: 'PE_OPTION',
    strategy: 'STRONG_CONFLUENCE',
    lots: 1,
    maxTrades: 6,
    cooldownMinutes: 4,
    minCostMult: 3.0,
    slAtrMult: 1.5,
    trailingEnabled: true,
    stdDevMultiplier: 1.0,
  },
  symbol: 'BANKNIFTY 61300 PE',
  lotSize: 30,
  tickSize: 0.05,
  dataSourceLabel: 'Simulator 45m Test',
  bnBars1m: aggregateCandles(seeded45.candlesByStream.BANKNIFTY_SPOT, '1m'),
  nfBars1m: aggregateCandles(seeded45.candlesByStream.NIFTY_SPOT, '1m'),
  optBars1m: aggregateCandles(seeded45.candlesByStream.PE_OPTION, '1m'),
});
assert.ok(stratSummary.barsEvaluated >= 40);
assert.equal(
  Math.round((stratSummary.grossPnlRs - stratSummary.totalChargesRs) * 100),
  Math.round(stratSummary.netPnlRs * 100),
  'Net P&L must equal Gross - FY26-27 Charges'
);
assert.ok(stratSummary.comparison !== undefined);
console.log('✓ Test 10 passed: Net-of-Tax Strategy Backtester:', {
  bars: stratSummary.barsEvaluated,
  strongTrades: stratSummary.tradeCount,
  strongNetRs: stratSummary.netPnlRs,
  naiveTrades: stratSummary.comparison?.naiveTrades,
  naiveNetRs: stratSummary.comparison?.naiveNetRs,
});

