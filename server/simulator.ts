import { roundToTick } from '../shared/radarMath.js';
import type { Candle, SimScenario, StreamKey } from '../shared/types.js';

export interface SimTickBatch {
  timestampMs: number;
  prices: Record<StreamKey, number>;
  volumes: Record<StreamKey, number>;
}

/**
 * Computes realistic initial option premium given spot, strike, and option type.
 */
export function estimateOptionPremium(
  spot: number,
  strike: number,
  optionType: 'CE' | 'PE'
): number {
  const intrinsic =
    optionType === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const distance = Math.abs(spot - strike);
  // Smooth decaying time value (~220 ATM, ~32 at ~600-800 pts OTM)
  const timeValue = Math.max(8, 225 * Math.exp(-distance / 320));
  return roundToTick(intrinsic + timeValue, 0.05);
}

/**
 * Generates correlated, realistic 1-second ticks & 5-second seed candles
 * for Bank Nifty Spot, Nifty Spot, Call (CE) and Put (PE) strikes.
 */
export class MarketSimulator {
  private spotBN = 61368.4;
  private spotNifty = 25648.2;
  private ceStrike = 61300;
  private peStrike = 61300;
  private cePrice = 248.5;
  private pePrice = 176.2;
  private simTimeMs = Math.floor(Date.now() / 1000) * 1000;
  private scenario: SimScenario = 'USER_BULLISH_61360';
  private stepCount = 0;

  constructor(ceStrike = 61300, peStrike = 61300, scenario: SimScenario = 'USER_BULLISH_61360') {
    this.ceStrike = ceStrike;
    this.peStrike = peStrike;
    this.scenario = scenario;
  }

  public setStrikes(ceStrike: number, peStrike: number): { cePrice: number; pePrice: number } {
    if (ceStrike !== this.ceStrike) {
      this.ceStrike = ceStrike;
      this.cePrice = estimateOptionPremium(this.spotBN, ceStrike, 'CE');
    }
    if (peStrike !== this.peStrike) {
      this.peStrike = peStrike;
      this.pePrice = estimateOptionPremium(this.spotBN, peStrike, 'PE');
    }
    return { cePrice: this.cePrice, pePrice: this.pePrice };
  }

  public getSpotPrices(): { bn: number; nifty: number; ce: number; pe: number } {
    return {
      bn: this.spotBN,
      nifty: this.spotNifty,
      ce: this.cePrice,
      pe: this.pePrice,
    };
  }

  /**
   * Seeds 25 minutes (300 x 5s candles) ending right before `nowMs`
   * so both the 3-minute live window and the Backtest Replay have rich immediate history.
   */
  public seedHistory(
    scenario: SimScenario,
    ceStrike: number,
    peStrike: number,
    minutesBack = 25
  ): {
    candlesByStream: Record<StreamKey, Candle[]>;
    prevClose: Record<StreamKey, number>;
    lastSimMs: number;
  } {
    this.scenario = scenario;
    this.ceStrike = ceStrike;
    this.peStrike = peStrike;
    this.stepCount = 0;

    // Align seed start to exact minute boundary
    const nowAlignedSec = Math.floor(Date.now() / 1000);
    const startSec = Math.floor((nowAlignedSec - minutesBack * 60) / 60) * 60;
    const totalSeconds = Math.max(60, nowAlignedSec - startSec);

    this.spotBN = scenario === 'BEARISH_BREAKDOWN' ? 61485.0 : 61332.0;
    this.spotNifty = scenario === 'BEARISH_BREAKDOWN' ? 25710.0 : 25628.0;
    this.cePrice = estimateOptionPremium(this.spotBN, ceStrike, 'CE');
    this.pePrice = estimateOptionPremium(this.spotBN, peStrike, 'PE');

    const prevClose: Record<StreamKey, number> = {
      BANKNIFTY_SPOT: roundToTick(this.spotBN - 45, 0.05),
      NIFTY_SPOT: roundToTick(this.spotNifty - 18, 0.05),
      CE_OPTION: roundToTick(this.cePrice * 0.92, 0.05),
      PE_OPTION: roundToTick(this.pePrice * 1.06, 0.05),
    };

    const buckets: Record<StreamKey, Map<number, Candle>> = {
      BANKNIFTY_SPOT: new Map(),
      NIFTY_SPOT: new Map(),
      CE_OPTION: new Map(),
      PE_OPTION: new Map(),
    };

    for (let s = 0; s < totalSeconds; s++) {
      const sec = startSec + s;
      // During the last ~3 minutes of USER_BULLISH_61360, sculpt the exact 61360.45 -> 61368 progression
      const remainingSec = totalSeconds - s;
      const tick = this.generateOneSecondAt(sec * 1000, remainingSec);
      const bar5s = Math.floor(sec / 5) * 5;

      (['BANKNIFTY_SPOT', 'NIFTY_SPOT', 'CE_OPTION', 'PE_OPTION'] as StreamKey[]).forEach(
        (key) => {
          const price = tick.prices[key];
          const vol = tick.volumes[key];
          const map = buckets[key];
          const existing = map.get(bar5s);
          if (!existing) {
            map.set(bar5s, {
              time: bar5s,
              open: price,
              high: price,
              low: price,
              close: price,
              volume: vol,
            });
          } else {
            existing.high = Math.max(existing.high, price);
            existing.low = Math.min(existing.low, price);
            existing.close = price;
            existing.volume += vol;
          }
        }
      );
    }

    this.simTimeMs = (startSec + totalSeconds - 1) * 1000;

    return {
      candlesByStream: {
        BANKNIFTY_SPOT: Array.from(buckets.BANKNIFTY_SPOT.values()).sort((a, b) => a.time - b.time),
        NIFTY_SPOT: Array.from(buckets.NIFTY_SPOT.values()).sort((a, b) => a.time - b.time),
        CE_OPTION: Array.from(buckets.CE_OPTION.values()).sort((a, b) => a.time - b.time),
        PE_OPTION: Array.from(buckets.PE_OPTION.values()).sort((a, b) => a.time - b.time),
      },
      prevClose,
      lastSimMs: this.simTimeMs,
    };
  }

  public nextTick(): SimTickBatch {
    this.simTimeMs += 1000;
    return this.generateOneSecondAt(this.simTimeMs, 0);
  }

  private generateOneSecondAt(timestampMs: number, remainingSeedSec: number): SimTickBatch {
    this.stepCount++;
    const t = this.stepCount;
    const waveSlow = Math.sin(t / 35);
    const waveFast = Math.sin(t / 7);
    const noise = (Math.random() - 0.5) * 2;

    let driftBN = 0;
    let volScale = 1.0;

    switch (this.scenario) {
      case 'USER_BULLISH_61360': {
        // Construct steady bullish higher-low impulse (~+4 to +8 pts/min)
        driftBN = 0.14 + 0.08 * waveSlow + 0.35 * waveFast + noise * 1.15;
        // Guide final 150s cleanly through 61360.45 -> 61368+ range if seeding
        if (remainingSeedSec > 90 && remainingSeedSec <= 150) {
          const target = 61360.45;
          driftBN += (target - this.spotBN) * 0.06;
        } else if (remainingSeedSec > 30 && remainingSeedSec <= 90) {
          const target = 61368.0;
          driftBN += (target - this.spotBN) * 0.06;
        }
        break;
      }
      case 'BEARISH_BREAKDOWN': {
        driftBN = -0.17 + 0.09 * waveSlow + 0.45 * waveFast + noise * 1.35;
        volScale = 1.15;
        break;
      }
      case 'CHOPPY_RANGE': {
        driftBN = (61375 - this.spotBN) * 0.025 + 0.65 * waveFast + noise * 1.1;
        volScale = 0.9;
        break;
      }
      case 'VOLATILITY_SPIKE': {
        driftBN = 0.18 * Math.sin(t / 18) + 1.1 * waveFast + noise * 2.4;
        volScale = 1.85;
        break;
      }
    }

    this.spotBN = roundToTick(Math.max(55000, this.spotBN + driftBN), 0.05);

    // Nifty correlated ~0.42 ratio + slight independent jitter
    const driftNifty = driftBN * 0.38 + (Math.random() - 0.5) * 0.6 * volScale;
    this.spotNifty = roundToTick(Math.max(20000, this.spotNifty + driftNifty), 0.05);

    // Option delta sensitivity depends on moneyness
    const ceDiff = this.spotBN - this.ceStrike;
    const ceDelta = Math.max(0.14, Math.min(0.86, 0.5 + ceDiff / 1200));
    const peDiff = this.peStrike - this.spotBN;
    const peDelta = Math.max(0.14, Math.min(0.86, 0.5 + peDiff / 1200));

    const ceNoise = (Math.random() - 0.5) * 0.45 * volScale;
    const peNoise = (Math.random() - 0.5) * 0.45 * volScale;

    this.cePrice = roundToTick(Math.max(3.5, this.cePrice + driftBN * ceDelta + ceNoise - 0.002), 0.05);
    this.pePrice = roundToTick(Math.max(3.5, this.pePrice - driftBN * peDelta + peNoise - 0.002), 0.05);

    const baseVol = Math.round((45 + Math.random() * 140) * volScale);

    return {
      timestampMs,
      prices: {
        BANKNIFTY_SPOT: this.spotBN,
        NIFTY_SPOT: this.spotNifty,
        CE_OPTION: this.cePrice,
        PE_OPTION: this.pePrice,
      },
      volumes: {
        BANKNIFTY_SPOT: 0,
        NIFTY_SPOT: 0,
        CE_OPTION: baseVol * 15,
        PE_OPTION: Math.round(baseVol * 13.5),
      },
    };
  }
}
