import { useState } from 'react';
import {
  Activity,
  BarChart3,
  Clock,
  Pause,
  Play,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import type { SimScenario, StreamKey, Timeframe } from '../shared/types.js';
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
    reseedScenario,
    connectDhanLive,
    disconnectDhanLive,
    runBacktest,
    fetchExpiries,
  } = useRadarSocket();

  const [tab, setTab] = useState<ActiveTab>('RADAR');

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

  const { settings, dhanStatus, streams } = state;
  const mainSnap = streams.BANKNIFTY_SPOT.snapshot;

  const ceStrikeDraft = drafts.ceStrike ?? String(settings.ceStrike);
  const peStrikeDraft = drafts.peStrike ?? String(settings.peStrike);
  const ceEntryDraft =
    drafts.ceEntry ?? (settings.ceEntryPrice != null ? String(settings.ceEntryPrice) : '');
  const peEntryDraft =
    drafts.peEntry ?? (settings.peEntryPrice != null ? String(settings.peEntryPrice) : '');
  const expiryDraft = drafts.expiry ?? settings.expiry;

  const applyStrikesAndTrades = async () => {
    const ceStrike = Number(ceStrikeDraft);
    const peStrike = Number(peStrikeDraft);
    const ceEntryPrice = ceEntryDraft.trim() === '' ? null : Number(ceEntryDraft);
    const peEntryPrice = peEntryDraft.trim() === '' ? null : Number(peEntryDraft);

    await updateSettings({
      ceStrike: Number.isFinite(ceStrike) && ceStrike > 0 ? ceStrike : settings.ceStrike,
      peStrike: Number.isFinite(peStrike) && peStrike > 0 ? peStrike : settings.peStrike,
      ceEntryPrice: ceEntryPrice != null && Number.isFinite(ceEntryPrice) ? ceEntryPrice : null,
      peEntryPrice: peEntryPrice != null && Number.isFinite(peEntryPrice) ? peEntryPrice : null,
      expiry: expiryDraft.trim() || settings.expiry,
    });
    setDrafts({});
  };

  const phaseClass =
    mainSnap.phase === 'FINAL_55S'
      ? 'phase-final'
      : mainSnap.phase === 'EARLY_50S'
        ? 'phase-early'
        : '';

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
              3-Min Rolling StdDev &amp; ATR Early Support/Resistance Engine
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
            Backtest &amp; Accuracy
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
              : 'SIMULATOR MODE'}
            {!connected && ' (WS OFFLINE)'}
          </button>
        </div>
      </header>

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
          <label className="field-box">
            <span className="field-label">CE Entry ₹</span>
            <input
              className="field-input narrow"
              type="number"
              step={0.05}
              placeholder="e.g. 32"
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
          <label className="field-box">
            <span className="field-label">PE Entry ₹</span>
            <input
              className="field-input narrow"
              type="number"
              step={0.05}
              placeholder="Optional"
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
          <div className="radar-grid">
            {STREAM_ORDER.map((key) => (
              <RadarPanel
                key={key}
                stream={streams[key]}
                timeframe={settings.timeframe}
              />
            ))}
          </div>
        )}

        {tab === 'BACKTEST' && (
          <BacktestView
            defaultWindow={settings.windowMinutes}
            defaultMultiplier={settings.stdDevMultiplier}
            defaultTrigger={settings.earlyTriggerSecond}
            onRunBacktest={runBacktest}
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
