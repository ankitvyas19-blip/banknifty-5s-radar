import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { BacktestSummary, StreamKey } from '../../shared/types.js';

interface BacktestViewProps {
  defaultWindow: number;
  defaultMultiplier: number;
  defaultTrigger: 45 | 50 | 55;
  onRunBacktest: (params: {
    streamKey: StreamKey;
    windowMinutes: number;
    stdDevMultiplier: number;
    triggerSecond: 45 | 50 | 55;
  }) => Promise<BacktestSummary>;
}

export function BacktestView({
  defaultWindow,
  defaultMultiplier,
  defaultTrigger,
  onRunBacktest,
}: BacktestViewProps) {
  const [streamKey, setStreamKey] = useState<StreamKey>('BANKNIFTY_SPOT');
  const [windowMinutes, setWindowMinutes] = useState<number>(defaultWindow);
  const [stdDevMultiplier, setStdDevMultiplier] = useState<number>(defaultMultiplier);
  const [triggerSecond, setTriggerSecond] = useState<45 | 50 | 55>(defaultTrigger);
  const [result, setResult] = useState<BacktestSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const execute = useCallback(async () => {
    setLoading(true);
    try {
      const res = await onRunBacktest({
        streamKey,
        windowMinutes,
        stdDevMultiplier,
        triggerSecond,
      });
      setResult(res);
    } finally {
      setLoading(false);
    }
  }, [onRunBacktest, streamKey, windowMinutes, stdDevMultiplier, triggerSecond]);

  useEffect(() => {
    let cancelled = false;
    void onRunBacktest({
      streamKey,
      windowMinutes,
      stdDevMultiplier,
      triggerSecond,
    }).then((res) => {
      if (!cancelled) setResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [onRunBacktest, streamKey, windowMinutes, stdDevMultiplier, triggerSecond]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="panel-surface">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginBottom: '14px',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '15px' }}>
              Look-Ahead-Free 5s Backtest &amp; Accuracy Replay
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
              Cuts off stored 5-second candles strictly at :{triggerSecond}s before each minute
              closes, then scores the projected Support/Resistance &amp; Bullish/Bearish% against
              the actual next 1-minute candle.
            </p>
          </div>

          <div className="control-group">
            <label className="field-box">
              <span className="field-label">Stream</span>
              <select
                className="field-select"
                value={streamKey}
                onChange={(e) => setStreamKey(e.target.value as StreamKey)}
              >
                <option value="BANKNIFTY_SPOT">Bank Nifty Spot</option>
                <option value="NIFTY_SPOT">Nifty 50 Spot</option>
                <option value="CE_OPTION">Bank Nifty Call (CE)</option>
                <option value="PE_OPTION">Bank Nifty Put (PE)</option>
              </select>
            </label>

            <label className="field-box">
              <span className="field-label">Window</span>
              <select
                className="field-select"
                value={windowMinutes}
                onChange={(e) => setWindowMinutes(Number(e.target.value))}
              >
                <option value={2}>2 Min</option>
                <option value={3}>3 Min</option>
                <option value={4}>4 Min</option>
                <option value={5}>5 Min</option>
              </select>
            </label>

            <label className="field-box">
              <span className="field-label">StdDev k</span>
              <select
                className="field-select"
                value={stdDevMultiplier}
                onChange={(e) => setStdDevMultiplier(Number(e.target.value))}
              >
                <option value={0.5}>0.50×</option>
                <option value={0.75}>0.75×</option>
                <option value={1}>1.00×</option>
                <option value={1.25}>1.25×</option>
                <option value={1.5}>1.50×</option>
              </select>
            </label>

            <label className="field-box">
              <span className="field-label">Trigger</span>
              <select
                className="field-select"
                value={triggerSecond}
                onChange={(e) => setTriggerSecond(Number(e.target.value) as 45 | 50 | 55)}
              >
                <option value={45}>:45s (T-15s)</option>
                <option value={50}>:50s (T-10s)</option>
                <option value={55}>:55s (T-5s)</option>
              </select>
            </label>

            <button className="btn btn-primary" onClick={() => void execute()} disabled={loading}>
              <RefreshCw size={13} />
              {loading ? 'Running...' : 'Re-Run Backtest'}
            </button>
          </div>
        </div>

        {result && (
          <>
            <div className="kpi-grid tabular">
              <div className="kpi-box">
                <div className="kpi-label">Evaluated Minutes ({result.symbol})</div>
                <div className="kpi-value">{result.totalPredictions}</div>
              </div>
              <div className="kpi-box">
                <div className="kpi-label">Support Hold Rate</div>
                <div className="kpi-value text-bull">{result.supportHoldRatePct}%</div>
              </div>
              <div className="kpi-box">
                <div className="kpi-label">Resistance Cap Rate</div>
                <div className="kpi-value text-ice">{result.resistanceCapRatePct}%</div>
              </div>
              <div className="kpi-box">
                <div className="kpi-label">Full Band Hit Rate</div>
                <div className="kpi-value text-amber">{result.rangeHitRatePct}%</div>
              </div>
              <div className="kpi-box">
                <div className="kpi-label">Direction Match</div>
                <div className="kpi-value">{result.directionHitRatePct}%</div>
              </div>
              <div className="kpi-box">
                <div className="kpi-label">Avg Low / High Error</div>
                <div className="kpi-value" style={{ fontSize: '16px', marginTop: '8px' }}>
                  {result.avgSupportErrorPts} / {result.avgResistanceErrorPts} pts
                </div>
              </div>
            </div>

            <div className="table-scroll">
              <table className="data-table tabular">
                <thead>
                  <tr>
                    <th>Next Min (IST)</th>
                    <th>1m Low Δ</th>
                    <th>StdDev σ</th>
                    <th>Bull / Bear %</th>
                    <th>Pred Support</th>
                    <th>Actual Low</th>
                    <th>Pred Resistance</th>
                    <th>Actual High</th>
                    <th>Err (L / H)</th>
                    <th>Band</th>
                    <th>Dir</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.length === 0 ? (
                    <tr>
                      <td colSpan={11} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        Need at least {windowMinutes + 2} minutes of 5-second candles in storage to
                        score predictions.
                      </td>
                    </tr>
                  ) : (
                    result.rows.map((r) => (
                      <tr key={r.targetMinuteSec}>
                        <td>{r.timeLabel}</td>
                        <td className={r.lowDev1m >= 0 ? 'text-bull' : 'text-bear'}>
                          {r.lowDev1m > 0 ? '+' : ''}
                          {r.lowDev1m.toFixed(2)}
                        </td>
                        <td>{r.stdDev.toFixed(2)}</td>
                        <td>
                          <span className="text-bull">{r.bullishPct}%</span> /{' '}
                          <span className="text-bear">{r.bearishPct}%</span>
                        </td>
                        <td className="text-bull">{r.predictedSupport.toFixed(2)}</td>
                        <td>{r.actualLow.toFixed(2)}</td>
                        <td className="text-bear">{r.predictedResistance.toFixed(2)}</td>
                        <td>{r.actualHigh.toFixed(2)}</td>
                        <td>
                          {r.lowErrorPts.toFixed(1)} / {r.highErrorPts.toFixed(1)}
                        </td>
                        <td>
                          <span className={`tag ${r.rangeHit ? 'bull' : 'bear'}`}>
                            {r.rangeHit ? 'HIT' : 'OUT'}
                          </span>
                        </td>
                        <td>
                          <span className={`tag ${r.directionHit ? 'bull' : 'amber'}`}>
                            {r.directionHit ? 'YES' : 'NO'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
