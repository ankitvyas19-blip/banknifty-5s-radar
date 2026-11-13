import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Crosshair,
  Pause,
  Play,
  PlugZap,
  RotateCcw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { ConfluenceSideEvaluation, SimScenario, StreamKey, Timeframe } from '../shared/types.js';
import { BacktestView } from './components/BacktestView.js';
import { DhanSetupView } from './components/DhanSetupView.js';
import { RadarPanel } from './components/RadarPanel.js';
import { useRadarSocket } from './hooks/useRadarSocket.js';

type ActiveTab = 'RADAR' | 'BACKTEST' | 'SETUP';

const STREAM_ORDER: StreamKey[] = ['BANKNIFTY_SPOT', 'NIFTY_SPOT', 'CE_OPTION', 'PE_OPTION'];

export function App() {
  const {
    state,
    connected,
    error,
    updateSettings,
    snapToAtm,
    reseedScenario,
    connectDhanLive,
    disconnectDhanLive,
    runBacktest,
    runStrategyBacktest,
    fetchExpiries,
  } = useRadarSocket();

  const [tab, setTab] = useState<ActiveTab>('RADAR');
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const [snappingAtm, setSnappingAtm] = useState(false);

  // Local input drafts for strike & entry price so typing feels instantaneous
  const [drafts, setDrafts] = useState<{
    ceStrike?: string;
    peStrike?: string;
    ceEntry?: string;
    peEntry?: string;
    expiry?: string;
  }>({});

  if (!state) {
    return (
      <div className="app-shell" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="panel-surface" style={{ maxWidth: '420px', textAlign: 'center' }}>
          <h1 style={{ fontSize: '16px', margin: '0 0 8px' }}>Initializing 5s Scalp Radar</h1>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            {error ? `Connection error: ${error}` : 'Connecting to backend WebSocket stream...'}
          </p>
        </div>
      </div>
    );
  }

  const { settings, dhanStatus, streams, confluence } = state;
  const mainSnap = streams.BANKNIFTY_SPOT.snapshot;
  const suggestedAtm = confluence?.suggestedAtmStrike ?? Math.round(mainSnap.ltp / 100) * 100;

  const ceStrikeDraft = drafts.ceStrike ?? String(settings.ceStrike);
  const peStrikeDraft = drafts.peStrike ?? String(settings.peStrike);
  const ceEntryDraft =
    drafts.ceEntry ?? (settings.ceEntryPrice != null ? String(settings.ceEntryPrice) : '');
  const peEntryDraft =
    drafts.peEntry ?? (settings.peEntryPrice != null ? String(settings.peEntryPrice) : '');
  const expiryDraft = drafts.expiry ?? settings.expiry;

  const applyStrikesAndTrades = async () => {
    setInputWarning(null);
    const ceStrike = Number(ceStrikeDraft);
    const peStrike = Number(peStrikeDraft);
    const ceEntryPrice = ceEntryDraft.trim() === '' ? null : Number(ceEntryDraft);
    const peEntryPrice = peEntryDraft.trim() === '' ? null : Number(peEntryDraft);

    if (
      (ceEntryPrice != null && ceEntryPrice >= 15000) ||
      (peEntryPrice != null && peEntryPrice >= 15000)
    ) {
      setInputWarning(
        'CE/PE Entry ₹ me Option Premium price (e.g. 240 ya 680) daalein — 61000 jaisa Strike price nahi!'
      );
      return;
    }

    await updateSettings({
      ceStrike: Number.isFinite(ceStrike) && ceStrike > 0 ? ceStrike : settings.ceStrike,
      peStrike: Number.isFinite(peStrike) && peStrike > 0 ? peStrike : settings.peStrike,
      ceEntryPrice:
        ceEntryPrice != null && Number.isFinite(ceEntryPrice) && ceEntryPrice > 0
          ? ceEntryPrice
          : null,
      peEntryPrice:
        peEntryPrice != null && Number.isFinite(peEntryPrice) && peEntryPrice > 0
          ? peEntryPrice
          : null,
      expiry: expiryDraft.trim() || settings.expiry,
    });
    setDrafts({});
  };

  const handleSnapAtm = async () => {
    setInputWarning(null);
    setSnappingAtm(true);
    try {
      await snapToAtm();
      setDrafts((d) => ({
        ...d,
        ceStrike: undefined,
        peStrike: undefined,
      }));
    } catch (err) {
      setInputWarning(err instanceof Error ? err.message : 'Failed to snap ATM strike');
    } finally {
      setSnappingAtm(false);
    }
  };

  const phaseClass =
    mainSnap.phase === 'FINAL_55S'
      ? 'phase-final'
      : mainSnap.phase === 'EARLY_50S'
        ? 'phase-early'
        : '';

  const activeSideEval: ConfluenceSideEvaluation | null = confluence
    ? confluence.direction === 'CE'
      ? confluence.ceEval
      : confluence.direction === 'PE'
        ? confluence.peEval
        : mainSnap.bullishPct >= 50
          ? confluence.ceEval
          : confluence.peEval
    : null;

  const confluenceCls =
    confluence?.verdict === 'A_PLUS_CE'
      ? 'conf-ce'
      : confluence?.verdict === 'A_PLUS_PE'
        ? 'conf-pe'
        : confluence?.verdict === 'WATCH_CE' || confluence?.verdict === 'WATCH_PE'
          ? 'conf-watch'
          : 'conf-chop';

  return (
    <div className="app-shell">
      {/* Sticky Top Header */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={16} />
          </div>
          <div>
            <h1 className="brand-title">BANKNIFTY · 5s SCALP RADAR</h1>
            <div className="brand-sub">
              3-Min Rolling StdDev, VWAP &amp; 3-Way Confluence Engine
            </div>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="Primary Views">
          <button
            className={`nav-tab ${tab === 'RADAR' ? 'active' : ''}`}
            onClick={() => setTab('RADAR')}
          >
            <Activity size={14} />
            Live 4-Chart Radar
          </button>
          <button
            className={`nav-tab ${tab === 'BACKTEST' ? 'active' : ''}`}
            onClick={() => setTab('BACKTEST')}
          >
            <BarChart3 size={14} />
            Strategy &amp; Backtest
          </button>
          <button
            className={`nav-tab ${tab === 'SETUP' ? 'active' : ''}`}
            onClick={() => setTab('SETUP')}
          >
            <Settings2 size={14} />
            DhanHQ &amp; Cloud Setup
          </button>
        </nav>

        <div className="topbar-right">
          <div className={`clock-pill tabular ${phaseClass}`}>
            <Clock size={13} />
            <span>{mainSnap.istTimeStr} IST</span>
            <span style={{ opacity: 0.7 }}>|</span>
            <strong>
              {mainSnap.phase === 'FINAL_55S'
                ? `:55s FINAL (T-${mainSnap.secondsRemainingInMinute}s)`
                : mainSnap.phase === 'EARLY_50S'
                  ? `:50s LOCK (T-${mainSnap.secondsRemainingInMinute}s)`
                  : `T-${mainSnap.secondsRemainingInMinute}s`}
            </strong>
          </div>

          <button
            className={`status-chip ${dhanStatus.mode === 'DHAN_LIVE' ? 'live' : 'sim'}`}
            onClick={() => setTab('SETUP')}
            title="Click to configure DhanHQ v2 credentials or switch mode"
          >
            <span className="dot" />
            {dhanStatus.mode === 'DHAN_LIVE'
              ? dhanStatus.wsConnected
                ? dhanStatus.feedTransport === 'REST_QUOTE'
                  ? 'DHANHQ LIVE (REST 1s)'
                  : 'DHANHQ LIVE'
                : 'DHAN RECONNECTING'
              : 'DEMO SIMULATOR (NOT LIVE)'}
            {!connected && ' (WS OFFLINE)'}
          </button>
        </div>
      </header>

      {dhanStatus.mode === 'SIMULATOR' && tab !== 'SETUP' && (
        <div className="mode-alert-bar" role="status">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={15} />
            <span>
              <strong>DEMO SIMULATOR DATA (Not Live NSE):</strong> Abhi fake test prices (~61,570
              / ~25,680) chal rahe hain. Real NSE BankNifty / Nifty / Options prices dekhne ke liye
              DhanHQ Token connect karein.
            </span>
          </div>
          <button className="btn btn-primary" onClick={() => setTab('SETUP')}>
            <PlugZap size={13} />
            Connect DhanHQ Live →
          </button>
        </div>
      )}

      {dhanStatus.mode === 'DHAN_LIVE' && dhanStatus.lastError && tab !== 'SETUP' && (
        <div className="mode-alert-bar err" role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={15} />
            <span>
              <strong>DhanHQ Feed Issue:</strong> {dhanStatus.lastError}
            </span>
          </div>
          <button className="btn" onClick={() => setTab('SETUP')}>
            Check Token / Setup →
          </button>
        </div>
      )}

      {inputWarning && (
        <div className="mode-alert-bar err" role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AlertTriangle size={15} />
            <span>{inputWarning}</span>
          </div>
          <button className="btn" onClick={() => setInputWarning(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Trade Strike & Formula Control Ribbon */}
      <div className="control-ribbon">
        <div className="control-group">
          <label className="field-box">
            <span className="field-label text-bull">CE Strike</span>
            <input
              className="field-input"
              type="number"
              step={100}
              value={ceStrikeDraft}
              onChange={(e) => setDrafts((d) => ({ ...d, ceStrike: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && void applyStrikesAndTrades()}
            />
          </label>
          <label
            className="field-box"
            title="Optional Call option buy price in ₹ (e.g. 240), NOT Strike/Spot"
          >
            <span className="field-label">CE Entry ₹</span>
            <input
              className="field-input narrow"
              type="number"
              step={0.05}
              placeholder="Opt ₹"
              value={ceEntryDraft}
              onChange={(e) => setDrafts((d) => ({ ...d, ceEntry: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && void applyStrikesAndTrades()}
            />
          </label>

          <label className="field-box">
            <span className="field-label text-bear">PE Strike</span>
            <input
              className="field-input"
              type="number"
              step={100}
              value={peStrikeDraft}
              onChange={(e) => setDrafts((d) => ({ ...d, peStrike: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && void applyStrikesAndTrades()}
            />
          </label>
          <label
            className="field-box"
            title="Optional Put option buy price in ₹ (e.g. 190), NOT Strike/Spot"
          >
            <span className="field-label">PE Entry ₹</span>
            <input
              className="field-input narrow"
              type="number"
              step={0.05}
              placeholder="Opt ₹"
              value={peEntryDraft}
              onChange={(e) => setDrafts((d) => ({ ...d, peEntry: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && void applyStrikesAndTrades()}
            />
          </label>

          <label className="field-box">
            <span className="field-label">Expiry</span>
            <input
              className="field-input"
              style={{ width: '92px' }}
              type="text"
              value={expiryDraft}
              onChange={(e) => setDrafts((d) => ({ ...d, expiry: e.target.value }))}
            />
          </label>

          <button className="btn btn-primary" onClick={() => void applyStrikesAndTrades()}>
            Apply Trade
          </button>

          <button
            className="btn btn-ice tabular"
            onClick={() => void handleSnapAtm()}
            disabled={snappingAtm}
            title="Auto-switch CE & PE to Bank Nifty's nearest At-The-Money (ATM) strike"
          >
            <Crosshair size={13} />
            {snappingAtm ? 'Snapping...' : `Snap ATM (${suggestedAtm})`}
          </button>
        </div>

        <div className="control-group">
          <div className="seg-group" aria-label="Chart Timeframe">
            {(['5s', '10s', '1m'] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                className={`seg-btn ${settings.timeframe === tf ? 'active' : ''}`}
                onClick={() => void updateSettings({ timeframe: tf })}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>

          <label className="field-box">
            <span className="field-label">Window</span>
            <select
              className="field-select"
              value={settings.windowMinutes}
              onChange={(e) => void updateSettings({ windowMinutes: Number(e.target.value) })}
            >
              <option value={2}>2m</option>
              <option value={3}>3m</option>
              <option value={5}>5m</option>
            </select>
          </label>

          <label className="field-box">
            <span className="field-label">StdDev k</span>
            <select
              className="field-select"
              value={settings.stdDevMultiplier}
              onChange={(e) => void updateSettings({ stdDevMultiplier: Number(e.target.value) })}
            >
              <option value={0.5}>0.5×</option>
              <option value={1}>1.0×</option>
              <option value={1.5}>1.5×</option>
            </select>
          </label>

          {dhanStatus.mode === 'SIMULATOR' && (
            <>
              <label className="field-box">
                <span className="field-label">Scenario</span>
                <select
                  className="field-select"
                  value={settings.simScenario}
                  onChange={(e) =>
                    void updateSettings({ simScenario: e.target.value as SimScenario })
                  }
                >
                  <option value="USER_BULLISH_61360">Bullish 61360→61368 (+8pt)</option>
                  <option value="BEARISH_BREAKDOWN">Bearish Breakdown</option>
                  <option value="CHOPPY_RANGE">Choppy Range</option>
                  <option value="VOLATILITY_SPIKE">High Volatility</option>
                </select>
              </label>

              <div className="seg-group" aria-label="Simulator Speed">
                {([1, 2, 5] as const).map((spd) => (
                  <button
                    key={spd}
                    className={`seg-btn ${settings.simSpeed === spd ? 'active' : ''}`}
                    onClick={() => void updateSettings({ simSpeed: spd })}
                  >
                    {spd}×
                  </button>
                ))}
              </div>

              <button
                className="btn"
                onClick={() => void updateSettings({ simPaused: !settings.simPaused })}
                title={settings.simPaused ? 'Resume ticks' : 'Pause ticks'}
              >
                {settings.simPaused ? <Play size={13} /> : <Pause size={13} />}
              </button>

              <button
                className="btn"
                onClick={() => void reseedScenario(settings.simScenario)}
                title="Reseed simulator history"
              >
                <RotateCcw size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main View Switcher */}
      <main className="main-content">
        {tab === 'RADAR' && (
          <>
            {confluence && activeSideEval && (
              <section
                className={`confluence-bar ${confluenceCls}`}
                aria-label="3-Way Confluence Decision"
              >
                <div className="conf-top">
                  <div className="conf-headline-wrap">
                    {confluence.verdict === 'A_PLUS_CE' || confluence.verdict === 'A_PLUS_PE' ? (
                      <ShieldCheck size={18} />
                    ) : (
                      <ShieldAlert size={18} />
                    )}
                    <div>
                      <div className="conf-headline">{confluence.headline}</div>
                      <div className="conf-subline tabular">{confluence.subline}</div>
                    </div>
                  </div>

                  <div className="conf-scores tabular">
                    <span className="tag" title="Call Confluence Score">
                      CE {confluence.ceEval.score}/5
                    </span>
                    <span className="tag" title="Put Confluence Score">
                      PE {confluence.peEval.score}/5
                    </span>
                  </div>
                </div>

                <div className="conf-checks tabular">
                  {activeSideEval.checks.map((chk) => (
                    <div
                      key={chk.id}
                      className={`conf-pill ${chk.passed ? 'ok' : 'no'}`}
                      title={chk.detail}
                    >
                      {chk.passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                      <span>{chk.label}:</span>
                      <strong>{chk.detail}</strong>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="radar-grid">
              {STREAM_ORDER.map((key) => (
                <RadarPanel
                  key={key}
                  stream={streams[key]}
                  timeframe={settings.timeframe}
                />
              ))}
            </div>
          </>
        )}

        {tab === 'BACKTEST' && (
          <BacktestView
            defaultWindow={settings.windowMinutes}
            defaultMultiplier={settings.stdDevMultiplier}
            defaultTrigger={settings.earlyTriggerSecond}
            ceSymbol={streams.CE_OPTION.config.symbol}
            peSymbol={streams.PE_OPTION.config.symbol}
            onRunBacktest={runBacktest}
            onRunStrategyBacktest={runStrategyBacktest}
          />
        )}

        {tab === 'SETUP' && (
          <DhanSetupView
            dhanStatus={dhanStatus}
            onConnect={connectDhanLive}
            onDisconnect={disconnectDhanLive}
            onFetchExpiries={fetchExpiries}
            onSelectExpiry={async (expiry) => {
              await updateSettings({ expiry });
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
