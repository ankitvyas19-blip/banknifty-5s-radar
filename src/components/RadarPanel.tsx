import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { StreamPayload, Timeframe } from '../../shared/types.js';

interface RadarPanelProps {
  stream: StreamPayload;
  timeframe: Timeframe;
}

function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtSigned(v: number): string {
  const prefix = v > 0 ? '+' : '';
  return `${prefix}${v.toFixed(2)}`;
}

function fmtIstAxis(unixSec: number): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(unixSec * 1000));
  } catch {
    return String(unixSec);
  }
}

function fmtIstTickMark(time: Time, tickMarkType: TickMarkType): string | null {
  if (typeof time !== 'number') return null;
  try {
    if (tickMarkType === TickMarkType.TimeWithSeconds) {
      return fmtIstAxis(time);
    }
    if (tickMarkType === TickMarkType.Time) {
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(time * 1000));
    }
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
    }).format(new Date(time * 1000));
  } catch {
    return null;
  }
}

export function RadarPanel({ stream, timeframe }: RadarPanelProps) {
  const { config, candles, snapshot } = stream;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const probSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const supportLineRef = useRef<IPriceLine | null>(null);
  const resistanceLineRef = useRef<IPriceLine | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const didFitRef = useRef(false);

  // Initialize Lightweight Chart once per panel
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#090d12' },
        textColor: '#8b9bb0',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.035)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.035)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 6,
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) =>
          fmtIstTickMark(time, tickMarkType),
      },
      localization: {
        timeFormatter: (t: number) => fmtIstAxis(t),
      },
      crosshair: {
        vertLine: { color: 'rgba(255, 255, 255, 0.22)', width: 1, style: LineStyle.Dashed },
        horzLine: { color: 'rgba(255, 255, 255, 0.22)', width: 1, style: LineStyle.Dashed },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderUpColor: '#10b981',
      borderDownColor: '#f43f5e',
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });

    const probSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'Prob Line',
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    probSeriesRef.current = probSeries;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      probSeriesRef.current = null;
      supportLineRef.current = null;
      resistanceLineRef.current = null;
      entryLineRef.current = null;
      didFitRef.current = false;
    };
  }, []);

  // Reset zoom fit when timeframe changes
  useEffect(() => {
    didFitRef.current = false;
  }, [timeframe, config.symbol]);

  // Update candle series, probability line, and S/R projections
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const probSeries = probSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !probSeries || !chart || candles.length === 0) return;

    const formattedCandles = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const formattedProb = candles
      .filter((c) => c.probLine != null)
      .map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.probLine as number,
      }));

    candleSeries.setData(formattedCandles);
    probSeries.setData(formattedProb);

    if (!didFitRef.current) {
      const visibleCount = timeframe === '5s' ? 48 : timeframe === '10s' ? 36 : 25;
      const total = formattedCandles.length;
      if (total > visibleCount) {
        chart.timeScale().setVisibleLogicalRange({
          from: total - visibleCount,
          to: total + 4,
        });
      } else {
        chart.timeScale().fitContent();
      }
      didFitRef.current = true;
    }

    // Remove and re-apply dynamic horizontal price lines for Next Support / Resistance / Entry
    if (supportLineRef.current) {
      candleSeries.removePriceLine(supportLineRef.current);
      supportLineRef.current = null;
    }
    if (resistanceLineRef.current) {
      candleSeries.removePriceLine(resistanceLineRef.current);
      resistanceLineRef.current = null;
    }
    if (entryLineRef.current) {
      candleSeries.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }

    supportLineRef.current = candleSeries.createPriceLine({
      price: snapshot.predictedNextSupport,
      color: '#10b981',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Next Sup',
    });

    resistanceLineRef.current = candleSeries.createPriceLine({
      price: snapshot.predictedNextResistance,
      color: '#f43f5e',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Next Res',
    });

    if (config.entryPrice != null && config.entryPrice > 0) {
      entryLineRef.current = candleSeries.createPriceLine({
        price: config.entryPrice,
        color: '#38bdf8',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Entry',
      });
    }
  }, [
    candles,
    snapshot.predictedNextSupport,
    snapshot.predictedNextResistance,
    config.entryPrice,
    timeframe,
  ]);

  const isPositiveDay = snapshot.change >= 0;
  const lowDevPositive = snapshot.lowDev1m >= 0;
  const isBull = snapshot.regime === 'BULLISH';
  const isBear = snapshot.regime === 'BEARISH';

  // Active Trade P&L calculation for Call / Put
  const hasEntry = config.entryPrice != null && config.entryPrice > 0;
  const qty = (config.lots ?? 1) * (config.lotSize ?? 30);
  const tradePnlPts = hasEntry ? snapshot.ltp - (config.entryPrice ?? 0) : 0;
  const tradePnlRs = tradePnlPts * qty;

  // Early snapshot highlight
  const activeEarly =
    snapshot.phase === 'FINAL_55S' && snapshot.locked55s
      ? {
          label: ':55s FINAL TENTATIVE RESULT',
          cls: 'locked-55',
          sup: snapshot.locked55s.predictedSupport,
          res: snapshot.locked55s.predictedResistance,
          bull: snapshot.locked55s.bullishPct,
          bear: snapshot.locked55s.bearishPct,
        }
      : snapshot.phase === 'EARLY_50S' && snapshot.locked50s
        ? {
            label: ':50s EARLY SIGNAL LOCKED',
            cls: 'locked-50',
            sup: snapshot.locked50s.predictedSupport,
            res: snapshot.locked50s.predictedResistance,
            bull: snapshot.locked50s.bullishPct,
            bear: snapshot.locked50s.bearishPct,
          }
        : {
            label: `BUILDING 1m CANDLE · T-${snapshot.secondsRemainingInMinute}s TO CLOSE`,
            cls: '',
            sup: snapshot.predictedNextSupport,
            res: snapshot.predictedNextResistance,
            bull: snapshot.bullishPct,
            bear: snapshot.bearishPct,
          };

  return (
    <section className="radar-card" aria-label={config.label}>
      {/* Panel Header */}
      <div className="radar-header">
        <div className="radar-title-wrap">
          <div className="radar-title-row">
            <span className="radar-title">{config.label}</span>
            <span className={`tag ${isBull ? 'bull' : isBear ? 'bear' : 'amber'}`}>
              {snapshot.regime}
            </span>
            <span
              className={`tag tabular ${lowDevPositive ? 'bull' : 'bear'}`}
              title="Current 1m candle Low minus Previous 1m candle Low"
            >
              1m Low Δ {fmtSigned(snapshot.lowDev1m)}
            </span>
            {hasEntry && (
              <span className={`tag tabular ${tradePnlRs >= 0 ? 'bull' : 'bear'}`}>
                Trade P&amp;L: ₹{tradePnlRs >= 0 ? '+' : ''}
                {Math.round(tradePnlRs).toLocaleString('en-IN')} ({fmtSigned(tradePnlPts)})
              </span>
            )}
          </div>
          <div className="radar-sub tabular">
            <span>{config.symbol}</span>
            <span>•</span>
            <span>{timeframe.toUpperCase()}</span>
            <span>•</span>
            <span>{snapshot.sampleCount5s}×5s ({snapshot.windowMinutes}m)</span>
            <span>•</span>
            <span>ATR(5s): {snapshot.atr5s.toFixed(2)}</span>
          </div>
        </div>

        <div className="price-cluster tabular">
          <div className="ltp-value">{fmtPrice(snapshot.ltp)}</div>
          <div className={`chg-row ${isPositiveDay ? 'text-bull' : 'text-bear'}`}>
            {fmtSigned(snapshot.change)} ({fmtSigned(snapshot.changePct)}%)
          </div>
        </div>
      </div>

      {/* Combined Bullish / Bearish Dynamic Probability Meter */}
      <div className="prob-bar-wrap">
        <div className="prob-labels tabular">
          <span className="text-bull">BULLISH {snapshot.bullishPct}%</span>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '10px' }}>
            DYNAMIC LINE: {fmtPrice(snapshot.probLine)}
          </span>
          <span className="text-bear">{snapshot.bearishPct}% BEARISH</span>
        </div>
        <div className="prob-track" role="progressbar" aria-valuenow={snapshot.bullishPct} aria-valuemin={0} aria-valuemax={100}>
          <div className="prob-fill-bull" style={{ width: `${snapshot.bullishPct}%` }} />
          <div className="prob-mid-tick" />
        </div>
      </div>

      {/* Interactive Chart */}
      <div className="chart-box">
        <div className="chart-legend tabular">
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: '#f59e0b' }} />
            Prob Line
          </span>
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: '#10b981' }} />
            Next Sup {fmtPrice(snapshot.predictedNextSupport)}
          </span>
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: '#f43f5e' }} />
            Next Res {fmtPrice(snapshot.predictedNextResistance)}
          </span>
          {hasEntry && (
            <span className="legend-item">
              <span className="legend-swatch" style={{ background: '#38bdf8' }} />
              Entry {fmtPrice(config.entryPrice ?? 0)}
            </span>
          )}
        </div>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* Early :50s / :55s Signal Banner */}
      <div className={`early-banner tabular ${activeEarly.cls}`}>
        <span style={{ fontWeight: 700 }}>{activeEarly.label}</span>
        <span>
          Forecast @ {activeEarly.bull}% Bull / {activeEarly.bear}% Bear → Sup{' '}
          <strong className="text-bull">{fmtPrice(activeEarly.sup)}</strong> | Res{' '}
          <strong className="text-bear">{fmtPrice(activeEarly.res)}</strong>
        </span>
      </div>

      {/* 4-Metric Mathematical Breakdown Strip */}
      <div className="forecast-strip tabular">
        <div className="metric-cell">
          <span className="metric-label">1m Low (Cur vs Prev)</span>
          <span className="metric-val">{fmtPrice(snapshot.forming1mLow)}</span>
          <span className={`metric-sub ${lowDevPositive ? 'text-bull' : 'text-bear'}`}>
            Prev {fmtPrice(snapshot.prev1mLow)} ({fmtSigned(snapshot.lowDev1m)})
          </span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">3m 5s Drift / StdDev σ</span>
          <span className="metric-val">σ {snapshot.stdDevLow1m.toFixed(2)}</span>
          <span className="metric-sub">
            5s μ {fmtSigned(snapshot.avgStepLow5s)} · ATR₁ₘ {snapshot.atr1m.toFixed(1)}
          </span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Next Candle Support</span>
          <span className="metric-val text-bull">{fmtPrice(snapshot.predictedNextSupport)}</span>
          <span className="metric-sub">
            {fmtSigned(snapshot.supportDelta)} from cur low
          </span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">Next Candle Resistance</span>
          <span className="metric-val text-bear">{fmtPrice(snapshot.predictedNextResistance)}</span>
          <span className="metric-sub">
            {fmtSigned(snapshot.resistanceDelta)} from cur high
          </span>
        </div>
      </div>
    </section>
  );
}
