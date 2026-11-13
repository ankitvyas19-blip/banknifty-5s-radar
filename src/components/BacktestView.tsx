import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, TrendingUp } from 'lucide-react';
import type {
  BacktestSummary,
  StrategyBacktestParams,
  StrategyBacktestSummary,
  StrategyPreset,
  StreamKey,
} from '../../shared/types.js';

interface BacktestViewProps {
  defaultWindow: number;
  defaultMultiplier: number;
  defaultTrigger: 45 | 50 | 55;
  ceSymbol: string;
  peSymbol: string;
  onRunBacktest: (params: {
    streamKey: StreamKey;
    windowMinutes: number;
    stdDevMultiplier: number;
    triggerSecond: 45 | 50 | 55;
  }) => Promise<BacktestSummary>;
  onRunStrategyBacktest: (params: StrategyBacktestParams) => Promise<StrategyBacktestSummary>;
}

type BacktestTabMode = 'STRATEGY' | 'SR_RANGE';

function fmtRs(val: number, signed = false): string {
  const abs = Math.abs(val).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  if (val < 0) return `-₹${abs}`;
  if (signed && val > 0) return `+₹${abs}`;
  return `₹${abs}`;
}

export function BacktestView({
  defaultWindow,
  defaultMultiplier,
  defaultTrigger,
  ceSymbol,
  peSymbol,
  onRunBacktest,
  onRunStrategyBacktest,
}: BacktestViewProps) {
  const [subTab, setSubTab] = useState<BacktestTabMode>('STRATEGY');

  // 5s S/R Accuracy State
  const [streamKey, setStreamKey] = useState<StreamKey>('BANKNIFTY_SPOT');
  const [windowMinutes, setWindowMinutes] = useState<number>(defaultWindow);
  const [stdDevMultiplier, setStdDevMultiplier] = useState<number>(defaultMultiplier);
  const [triggerSecond, setTriggerSecond] = useState<45 | 50 | 55>(defaultTrigger);
  const [srResult, setSrResult] = useState<BacktestSummary | null>(null);
  const [srLoading, setSrLoading] = useState(false);

  // Net-of-Tax Strategy Simulator State
  const [optionKey, setOptionKey] = useState<'CE_OPTION' | 'PE_OPTION'>('PE_OPTION');
  const [strategy, setStrategy] = useState<StrategyPreset>('STRONG_CONFLUENCE');
  const [lots, setLots] = useState<number>(1);
  const [maxTrades, setMaxTrades] = useState<number>(6);
  const [cooldownMinutes, setCooldownMinutes] = useState<number>(4);
  const [minCostMult, setMinCostMult] = useState<number>(4.0);
  const [slAtrMult, setSlAtrMult] = useState<number>(1.5);
  const [trailingEnabled, setTrailingEnabled] = useState<boolean>(true);
  const [sourceMode, setSourceMode] = useState<'AUTO' | '5S_TICKS'>('AUTO');
  const [stratResult, setStratResult] = useState<StrategyBacktestSummary | null>(null);
  const [stratLoading, setStratLoading] = useState(false);

  const executeSr = useCallback(async () => {
    setSrLoading(true);
    try {
      const res = await onRunBacktest({
        streamKey,
        windowMinutes,
        stdDevMultiplier,
        triggerSecond,
      });
      setSrResult(res);
    } finally {
      setSrLoading(false);
    }
  }, [onRunBacktest, streamKey, windowMinutes, stdDevMultiplier, triggerSecond]);

  const executeStrategy = useCallback(async () => {
    setStratLoading(true);
    try {
      const res = await onRunStrategyBacktest({
        optionKey,
        strategy,
        lots,
        maxTrades,
        cooldownMinutes,
        minCostMult,
        slAtrMult,
        trailingEnabled,
        stdDevMultiplier,
        source: sourceMode,
      });
      setStratResult(res);
    } finally {
      setStratLoading(false);
    }
  }, [
    onRunStrategyBacktest,
    optionKey,
    strategy,
    lots,
    maxTrades,
    cooldownMinutes,
    minCostMult,
    slAtrMult,
    trailingEnabled,
    stdDevMultiplier,
    sourceMode,
  ]);

  useEffect(() => {
    if (subTab !== 'SR_RANGE') return;
    let cancelled = false;
    void onRunBacktest({
      streamKey,
      windowMinutes,
      stdDevMultiplier,
      triggerSecond,
    }).then((res) => {
      if (!cancelled) setSrResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [subTab, onRunBacktest, streamKey, windowMinutes, stdDevMultiplier, triggerSecond, ceSymbol, peSymbol]);

  useEffect(() => {
    if (subTab !== 'STRATEGY') return;
    let cancelled = false;
    void onRunStrategyBacktest({
      optionKey,
      strategy,
      lots,
      maxTrades,
      cooldownMinutes,
      minCostMult,
      slAtrMult,
      trailingEnabled,
      stdDevMultiplier,
      source: sourceMode,
    }).then((res) => {
      if (!cancelled) setStratResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [
    subTab,
    onRunStrategyBacktest,
    optionKey,
    strategy,
    lots,
    maxTrades,
    cooldownMinutes,
    minCostMult,
    slAtrMult,
    trailingEnabled,
    stdDevMultiplier,
    sourceMode,
    ceSymbol,
    peSymbol,
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Mode Switcher */}
      <div
        className="panel-surface"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          padding: '10px 14px',
        }}
      >
        <div className="seg-group" aria-label="Backtest Mode">
          <button
            className={`seg-btn ${subTab === 'STRATEGY' ? 'active' : ''}`}
            onClick={() => setSubTab('STRATEGY')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px' }}
          >
            <ShieldCheck size={13} />
            Net-of-Tax Auto Strategy Simulator (CE / PE)
          </button>
          <button
            className={`seg-btn ${subTab === 'SR_RANGE' ? 'active' : ''}`}
            onClick={() => setSubTab('SR_RANGE')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 12px' }}
          >
            <TrendingUp size={13} />
            5s S/R Range Forecast Accuracy (:50s / :55s)
          </button>
        </div>

        <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
          FY 2026–27 Exact Costs: Dhan ₹40/trade + 0.15% Sell STT + NSE/IPFT 0.03553% + Stamp + 18% GST
        </span>
      </div>

      {subTab === 'STRATEGY' && (
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
                Net-of-Tax Option Strategy Simulator (Zero Look-Ahead)
              </h2>
              <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {stratResult
                  ? `${stratResult.dataSourceLabel} · ${stratResult.sessionStartIst}–${stratResult.sessionEndIst} IST (${stratResult.barsEvaluated}×1m bars, Qty ${stratResult.qty})`
                  : 'Loading full session bars and simulating net P&L...'}
              </p>
            </div>

            <div className="control-group">
              <label className="field-box">
                <span className="field-label">Option</span>
                <select
                  className="field-select"
                  value={optionKey}
                  onChange={(e) => setOptionKey(e.target.value as 'CE_OPTION' | 'PE_OPTION')}
                >
                  <option value="PE_OPTION">{peSymbol}</option>
                  <option value="CE_OPTION">{ceSymbol}</option>
                </select>
              </label>

              <label className="field-box">
                <span className="field-label">Strategy</span>
                <select
                  className="field-select"
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as StrategyPreset)}
                >
                  <option value="STRONG_CONFLUENCE">Strong 3-Way Confluence + VWAP + Trail</option>
                  <option value="TREND_SR">Trend S/R (1m Bull + SL)</option>
                  <option value="NAIVE_SR">Old Rule: Blind Support→Res</option>
                </select>
              </label>

              <label className="field-box">
                <span className="field-label">Lots</span>
                <select
                  className="field-select"
                  value={lots}
                  onChange={(e) => setLots(Number(e.target.value))}
                >
                  <option value={1}>1 Lot</option>
                  <option value={2}>2 Lots</option>
                  <option value={3}>3 Lots</option>
                  <option value={5}>5 Lots</option>
                </select>
              </label>

              <label className="field-box">
                <span className="field-label">Max/Day</span>
                <select
                  className="field-select"
                  value={maxTrades}
                  onChange={(e) => setMaxTrades(Number(e.target.value))}
                >
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={6}>6</option>
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                </select>
              </label>

              <label className="field-box">
                <span className="field-label">Cooldown</span>
                <select
                  className="field-select"
                  value={cooldownMinutes}
                  onChange={(e) => setCooldownMinutes(Number(e.target.value))}
                >
                  <option value={0}>0m</option>
                  <option value={3}>3m</option>
                  <option value={4}>4m</option>
                  <option value={6}>6m</option>
                  <option value={10}>10m</option>
                </select>
              </label>

              <label className="field-box">
                <span className="field-label">Tax Edge</span>
                <select
                  className="field-select"
                  value={minCostMult}
                  onChange={(e) => setMinCostMult(Number(e.target.value))}
                >
                  <option value={0}>Any (0×)</option>
                  <option value={2.5}>2.5× Tax</option>
                  <option value={4}>4.0× Tax</option>
                  <option value={5}>5.0× Tax</option>
                </select>
              </label>

              <label className="field-box">
                <span className="field-label">SL ATR</span>
                <select
                  className="field-select"
                  value={slAtrMult}
                  onChange={(e) => setSlAtrMult(Number(e.target.value))}
                >
                  <option value={1.0}>1.0×</option>
                  <option value={1.5}>1.5×</option>
                  <option value={2.0}>2.0×</option>
                </select>
              </label>

              <label className="field-box" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={trailingEnabled}
                  onChange={(e) => setTrailingEnabled(e.target.checked)}
                />
                <span className="field-label">Trail SL</span>
              </label>

              <label className="field-box">
                <span className="field-label">Data</span>
                <select
                  className="field-select"
                  value={sourceMode}
                  onChange={(e) => setSourceMode(e.target.value as 'AUTO' | '5S_TICKS')}
                >
                  <option value="AUTO">Full 1m Session</option>
                  <option value="5S_TICKS">5s Recorded Only</option>
                </select>
              </label>

              <button
                className="btn btn-primary"
                onClick={() => void executeStrategy()}
                disabled={stratLoading}
              >
                <RefreshCw size={13} />
                {stratLoading ? 'Simulating...' : 'Simulate'}
              </button>
            </div>
          </div>

          {stratResult && (
            <>
              {stratResult.comparison && (
                <div
                  className={`alert-banner ${stratResult.comparison.strongNetRs >= stratResult.comparison.naiveNetRs ? 'ok' : ''}`}
                  style={{
                    marginBottom: '14px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px',
                  }}
                >
                  <span>
                    <strong>Old Naive Support→Res:</strong> {stratResult.comparison.naiveTrades} trades ·{' '}
                    Charges {fmtRs(stratResult.comparison.naiveChargesRs)} · Net{' '}
                    <strong
                      className={
                        stratResult.comparison.naiveNetRs >= 0 ? 'text-bull' : 'text-bear'
                      }
                    >
                      {fmtRs(stratResult.comparison.naiveNetRs, true)}
                    </strong>
                  </span>
                  <span>
                    <strong>Strong 3-Way Confluence:</strong> {stratResult.comparison.strongTrades}{' '}
                    trades · Charges {fmtRs(stratResult.comparison.strongChargesRs)} · Net{' '}
                    <strong
                      className={
                        stratResult.comparison.strongNetRs >= 0 ? 'text-bull' : 'text-bear'
                      }
                    >
                      {fmtRs(stratResult.comparison.strongNetRs, true)}
                    </strong>
                  </span>
                  <span className="tag bull tabular">
                    Improvement:{' '}
                    {fmtRs(
                      stratResult.comparison.strongNetRs - stratResult.comparison.naiveNetRs,
                      true
                    )}
                  </span>
                </div>
              )}

              <div className="kpi-grid tabular">
                <div className="kpi-box">
                  <div className="kpi-label">Trades (Win Rate)</div>
                  <div className="kpi-value">
                    {stratResult.tradeCount}{' '}
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      ({stratResult.winRatePct}%)
                    </span>
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Gross P&amp;L (Before Cost)</div>
                  <div
                    className={`kpi-value ${stratResult.grossPnlRs >= 0 ? 'text-bull' : 'text-bear'}`}
                  >
                    {fmtRs(stratResult.grossPnlRs, true)}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Dhan + 0.15% STT + Taxes</div>
                  <div className="kpi-value text-amber">
                    -{fmtRs(stratResult.totalChargesRs)}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">NET P&amp;L (AFTER TAX)</div>
                  <div
                    className={`kpi-value ${stratResult.netPnlRs >= 0 ? 'text-bull' : 'text-bear'}`}
                  >
                    {fmtRs(stratResult.netPnlRs, true)}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Avg Cost / Trade (STT ₹{stratResult.totalSttRs})</div>
                  <div className="kpi-value" style={{ fontSize: '18px', marginTop: '6px' }}>
                    {fmtRs(stratResult.avgChargePerTradeRs)}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Max Drawdown</div>
                  <div className="kpi-value text-bear" style={{ fontSize: '18px', marginTop: '6px' }}>
                    -{fmtRs(stratResult.maxDrawdownRs)}
                  </div>
                </div>
              </div>

              <div className="table-scroll">
                <table className="data-table tabular">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Entry IST</th>
                      <th>Exit IST</th>
                      <th>Buy ₹</th>
                      <th>Sell ₹</th>
                      <th>Pts</th>
                      <th>Exit Reason</th>
                      <th>Gross ₹</th>
                      <th>Brok+STT+Tax</th>
                      <th>Net ₹</th>
                      <th>Setup / Rule Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stratResult.trades.length === 0 ? (
                      <tr>
                        <td colSpan={11} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                          {stratResult.barsEvaluated < 12
                            ? 'Need at least 12 completed 1-minute bars to simulate strategy.'
                            : 'Zero qualifying trades under strict confluence/tax filters in this window (Protected capital from chop!).'}
                        </td>
                      </tr>
                    ) : (
                      stratResult.trades.map((t) => (
                        <tr key={t.id}>
                          <td>{t.id}</td>
                          <td>{t.entryTime}</td>
                          <td>{t.exitTime}</td>
                          <td>{t.entryPrice.toFixed(2)}</td>
                          <td>{t.exitPrice.toFixed(2)}</td>
                          <td className={t.pnlPts >= 0 ? 'text-bull' : 'text-bear'}>
                            {t.pnlPts > 0 ? '+' : ''}
                            {t.pnlPts.toFixed(2)}
                          </td>
                          <td>
                            <span
                              className={`tag ${
                                t.reason === 'TARGET_RES' || t.reason === 'TRAILING_SL'
                                  ? 'bull'
                                  : t.reason === 'STOP_LOSS'
                                    ? 'bear'
                                    : 'amber'
                              }`}
                            >
                              {t.reason}
                            </span>
                          </td>
                          <td className={t.grossRs >= 0 ? 'text-bull' : 'text-bear'}>
                            {fmtRs(t.grossRs, true)}
                          </td>
                          <td className="text-amber">-{fmtRs(t.chargesRs)}</td>
                          <td
                            style={{ fontWeight: 700 }}
                            className={t.netRs >= 0 ? 'text-bull' : 'text-bear'}
                          >
                            {fmtRs(t.netRs, true)}
                          </td>
                          <td style={{ color: 'var(--text-secondary)' }}>{t.note}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {subTab === 'SR_RANGE' && (
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
                  <option value="CE_OPTION">Bank Nifty Call ({ceSymbol})</option>
                  <option value="PE_OPTION">Bank Nifty Put ({peSymbol})</option>
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

              <button
                className="btn btn-primary"
                onClick={() => void executeSr()}
                disabled={srLoading}
              >
                <RefreshCw size={13} />
                {srLoading ? 'Running...' : 'Re-Run Backtest'}
              </button>
            </div>
          </div>

          {srResult && (
            <>
              <div className="kpi-grid tabular">
                <div className="kpi-box">
                  <div className="kpi-label">Evaluated Minutes ({srResult.symbol})</div>
                  <div className="kpi-value">{srResult.totalPredictions}</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Support Hold Rate</div>
                  <div className="kpi-value text-bull">{srResult.supportHoldRatePct}%</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Resistance Cap Rate</div>
                  <div className="kpi-value text-ice">{srResult.resistanceCapRatePct}%</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Full Band Hit Rate</div>
                  <div className="kpi-value text-amber">{srResult.rangeHitRatePct}%</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Direction Match</div>
                  <div className="kpi-value">{srResult.directionHitRatePct}%</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">Avg Low / High Error</div>
                  <div className="kpi-value" style={{ fontSize: '16px', marginTop: '8px' }}>
                    {srResult.avgSupportErrorPts} / {srResult.avgResistanceErrorPts} pts
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
                    {srResult.rows.length === 0 ? (
                      <tr>
                        <td colSpan={11} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                          Need at least {windowMinutes + 2} minutes of 5-second candles in storage to
                          score predictions.
                        </td>
                      </tr>
                    ) : (
                      srResult.rows.map((r) => (
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
      )}
    </div>
  );
}
