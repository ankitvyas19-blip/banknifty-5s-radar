import { useState, type FormEvent } from 'react';
import { Cloud, PlugZap, PowerOff, RefreshCw } from 'lucide-react';
import type { DhanStatus } from '../../shared/types.js';

interface DhanSetupViewProps {
  dhanStatus: DhanStatus;
  onConnect: (clientId: string, accessToken: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onFetchExpiries: () => Promise<string[]>;
  onSelectExpiry: (expiry: string) => Promise<void>;
}

export function DhanSetupView({
  dhanStatus,
  onConnect,
  onDisconnect,
  onFetchExpiries,
  onSelectExpiry,
}: DhanSetupViewProps) {
  const [clientId, setClientId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [expiries, setExpiries] = useState<string[]>([]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      await onConnect(clientId, accessToken);
      setFeedback({
        type: 'ok',
        msg: 'DhanHQ v2 live market feed activated and subscribed to Bank Nifty, Nifty 50, CE & PE.',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        msg: err instanceof Error ? err.message : 'Failed to connect DhanHQ',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleExpiries = async () => {
    setBusy(true);
    try {
      const list = await onFetchExpiries();
      setExpiries(list);
      if (list[0]) {
        await onSelectExpiry(list[0]);
      }
    } finally {
      setBusy(false);
    }
  };

  const transportLabel =
    dhanStatus.mode !== 'DHAN_LIVE'
      ? 'STANDBY'
      : dhanStatus.wsConnected
        ? dhanStatus.feedTransport === 'REST_QUOTE'
          ? 'LIVE (REST 1s)'
          : 'LIVE (WS v2)'
        : 'RECONNECTING';

  return (
    <div className="setup-grid">
      <div className="panel-surface">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <PlugZap size={16} className="text-bull" />
          <h2 style={{ margin: 0, fontSize: '15px' }}>DhanHQ v2 Live Connector</h2>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
          Connects directly to <code>wss://api-feed.dhan.co?version=2</code> (binary Little-Endian
          Quote packets) with automatic fallback to <code>/v2/marketfeed/quote</code> (1s polling) if
          a network proxy blocks WebSocket upgrades. Resolves strikes from Dhan&apos;s Scrip Master CSV.
        </p>

        <div className="kpi-grid tabular" style={{ marginBottom: '14px' }}>
          <div className="kpi-box">
            <div className="kpi-label">Active Mode</div>
            <div
              className={`kpi-value ${dhanStatus.mode === 'DHAN_LIVE' ? 'text-bull' : 'text-ice'}`}
              style={{ fontSize: '15px' }}
            >
              {dhanStatus.mode}
            </div>
          </div>
          <div className="kpi-box">
            <div className="kpi-label">Feed Transport</div>
            <div
              className={`kpi-value ${dhanStatus.wsConnected ? 'text-bull' : ''}`}
              style={{ fontSize: '15px' }}
            >
              {transportLabel}
            </div>
          </div>
          <div className="kpi-box">
            <div className="kpi-label">Client ID</div>
            <div className="kpi-value" style={{ fontSize: '15px' }}>
              {dhanStatus.clientIdMasked}
            </div>
          </div>
          <div className="kpi-box">
            <div className="kpi-label">Contracts Cached</div>
            <div className="kpi-value" style={{ fontSize: '15px' }}>
              {dhanStatus.scripCountLoaded}
            </div>
          </div>
        </div>

        {dhanStatus.lastError && (
          <div className="alert-banner err" style={{ marginBottom: '12px' }}>
            DhanHQ Status: {dhanStatus.lastError}
          </div>
        )}

        {feedback && (
          <div className={`alert-banner ${feedback.type}`} style={{ marginBottom: '12px' }}>
            {feedback.msg}
          </div>
        )}

        <form className="form-stack" onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="dhan-client-id">Dhan Client ID</label>
            <input
              id="dhan-client-id"
              type="text"
              placeholder="e.g. 1000xxxxxx"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required={!dhanStatus.hasCredentials}
            />
          </div>

          <div className="form-field">
            <label htmlFor="dhan-access-token">Dhan Daily Access Token (JWT)</label>
            <input
              id="dhan-access-token"
              type="password"
              placeholder="Paste daily DhanHQ v2 Access Token"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              required={!dhanStatus.hasCredentials}
            />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              <PlugZap size={14} />
              {busy ? 'Connecting...' : 'Connect DhanHQ Live'}
            </button>

            {dhanStatus.mode === 'DHAN_LIVE' && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void onDisconnect()}
                disabled={busy}
              >
                <PowerOff size={14} />
                Switch Back to Simulator
              </button>
            )}

            <button
              type="button"
              className="btn"
              onClick={() => void handleExpiries()}
              disabled={busy}
            >
              <RefreshCw size={14} />
              Sync Bank Nifty Expiries
            </button>
          </div>
        </form>

        {expiries.length > 0 && (
          <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            Active Expiries:{' '}
            {expiries.slice(0, 6).map((ex) => (
              <button
                key={ex}
                type="button"
                className="tag tabular"
                style={{ marginRight: '6px', cursor: 'pointer' }}
                onClick={() => void onSelectExpiry(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="panel-surface">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <Cloud size={16} className="text-ice" />
          <h2 style={{ margin: 0, fontSize: '15px' }}>
            24×7 Google Cloud Run Deployment (Always-On Collector)
          </h2>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
          Because DhanHQ Historical Intraday API only serves 1m+ candles (not 5s candles), running
          this container on <strong>Google Cloud Run</strong> with <code>--min-instances=1</code>{' '}
          keeps the Dhan WebSocket alive even when your laptop is closed, continuously recording 5s
          bars and <code>:55s</code> forecasts into SQLite/Cloud Storage for instant Backtesting.
        </p>

        <pre className="code-block">{`# 1. Build & deploy to Google Cloud Run (Mumbai asia-south1 for lowest NSE latency)
gcloud run deploy banknifty-5s-radar \\
  --source . \\
  --region asia-south1 \\
  --platform managed \\
  --allow-unauthenticated \\
  --min-instances 1 \\
  --max-instances 1 \\
  --no-cpu-throttling \\
  --set-env-vars "NODE_ENV=production,DHAN_AUTO_CONNECT=true" \\
  --set-secrets "DHAN_CLIENT_ID=dhan-client-id:latest,DHAN_ACCESS_TOKEN=dhan-token:latest"`}</pre>

        <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '12px' }}>
          Tip: Add <code>--no-cpu-throttling</code> so Node continues aggregating 5-second candles and
          evaluating <code>:50s / :55s</code> forecasts even when no browser tab is open. Mount a GCS
          FUSE bucket at <code>/app/data</code> (<code>RADAR_DATA_DIR=/app/data</code>) to preserve
          SQLite history across container restarts.
        </p>
      </div>
    </div>
  );
}
