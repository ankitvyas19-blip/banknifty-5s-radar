import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { RadarSettings, StreamKey } from '../shared/types.js';
import { EngineManager } from './engineManager.js';
import { RadarStore } from './store.js';

const PORT = Number(process.env.PORT || 8080);
const IS_PROD = process.env.NODE_ENV === 'production';

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const store = new RadarStore();
  const engine = new EngineManager(store);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      dbPath: store.dbPath,
      dhanStatus: engine.getDhanStatus(),
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get('/api/state', (_req, res) => {
    res.json(engine.getFullBroadcast('FULL_STATE'));
  });

  app.post('/api/settings', async (req, res) => {
    try {
      const body = req.body as Partial<RadarSettings>;
      const nextState = await engine.updateSettings(body);
      res.json(nextState);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid settings payload',
      });
    }
  });

  app.post('/api/simulator/reseed', (req, res) => {
    try {
      const body = (req.body || {}) as { scenario?: RadarSettings['simScenario'] };
      if (body.scenario) {
        void engine.updateSettings({ simScenario: body.scenario }).then((state) => res.json(state));
      } else {
        engine.seedSimulatorHistory();
        res.json(engine.getFullBroadcast('FULL_STATE'));
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Reseed error' });
    }
  });

  app.post('/api/dhan/connect', async (req, res) => {
    try {
      const { clientId, accessToken } = (req.body || {}) as {
        clientId?: string;
        accessToken?: string;
      };
      const status = await engine.connectDhanLive(clientId, accessToken);
      res.json({ ok: true, dhanStatus: status });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to connect DhanHQ Live Feed',
      });
    }
  });

  app.post('/api/dhan/disconnect', (_req, res) => {
    const status = engine.switchToSimulator();
    res.json({ ok: true, dhanStatus: status });
  });

  app.get('/api/dhan/expiries', async (_req, res) => {
    try {
      const expiries = await engine.getExpiries();
      res.json({ expiries });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to fetch expiries',
      });
    }
  });

  app.get('/api/backtest', (req, res) => {
    const streamKey = (String(req.query.streamKey || 'BANKNIFTY_SPOT') as StreamKey);
    const windowMinutes = Math.max(1, Math.min(10, Number(req.query.windowMinutes || 3)));
    const stdDevMultiplier = Math.max(
      0.25,
      Math.min(3.0, Number(req.query.stdDevMultiplier || 1.0))
    );
    const rawTrigger = Number(req.query.triggerSecond || 55);
    const triggerSecond: 45 | 50 | 55 =
      rawTrigger === 45 ? 45 : rawTrigger === 50 ? 50 : 55;

    const summary = engine.runBacktest({
      streamKey,
      windowMinutes,
      stdDevMultiplier,
      triggerSecond,
    });
    res.json(summary);
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    socket.send(JSON.stringify(engine.getFullBroadcast('FULL_STATE')));
  });

  engine.on('broadcast', (payload) => {
    const encoded = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(encoded);
      }
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[BankNifty 5s Radar] Listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'})`
    );
  });
}

bootstrap().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
