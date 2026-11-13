import assert from 'node:assert/strict';
import {
  aggregateCandles,
  computeRadarSnapshot,
  runBacktestOn5sCandles,
} from '../shared/radarMath.js';
import type { Candle } from '../shared/types.js';
import { DhanClient } from '../server/dhanClient.js';

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

