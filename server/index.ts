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

let lastServerError: string | null = null;

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const store = new RadarStore();
  const engine = new EngineManager(store);

  app.get('/api/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      runtimeTag: 'node24-slim-v3',
      dbPath: store.dbPath,
      dhanStatus: engine.getDhanStatus(),
      uptimeSec: Math.round(process.uptime()),
      memoryMb: {
        rss: Math.round(mem.rss / 1048576),
        heapUsed: Math.round(mem.heapUsed / 1048576),
        external: Math.round(mem.external / 1048576),
      },
      ...(lastServerError ? { lastServerError } : {}),
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
      const { clientId, accessToken, transport } = (req.body || {}) as {
        clientId?: string;
        accessToken?: string;
        transport?: 'AUTO' | 'REST';
      };
      const safeTransport = transport === 'REST' || transport === 'AUTO' ? transport : undefined;
      const status = await engine.connectDhanLive(clientId, accessToken, safeTransport);
      const mem = process.memoryUsage();
      res.json({
        ok: true,
        dhanStatus: status,
        memoryMb: {
          rss: Math.round(mem.rss / 1048576),
          heapUsed: Math.round(mem.heapUsed / 1048576),
          external: Math.round(mem.external / 1048576),
        },
      });
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

  app.post('/api/strikes/snap-atm', async (_req, res) => {
    try {
      const result = await engine.snapToAtmStrikes();
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to snap to ATM strikes',
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

  app.get('/api/strategy-backtest', async (req, res) => {
    try {
      const optionKey =
        req.query.optionKey === 'CE_OPTION' ? 'CE_OPTION' : 'PE_OPTION';
      const rawStrat = String(req.query.strategy || 'STRONG_CONFLUENCE');
      const strategy =
        rawStrat === 'NAIVE_SR' || rawStrat === 'TREND_SR' || rawStrat === 'STRONG_CONFLUENCE'
          ? rawStrat
          : 'STRONG_CONFLUENCE';
      const lots = Math.max(1, Math.min(50, Math.round(Number(req.query.lots || 1))));
      const maxTrades = Math.max(1, Math.min(100, Math.round(Number(req.query.maxTrades || 6))));
      const cooldownMinutes = Math.max(0, Math.min(30, Math.round(Number(req.query.cooldownMinutes ?? 4))));
      const minCostMult = Math.max(0, Math.min(12, Number(req.query.minCostMult ?? 4.0)));
      const slAtrMult = Math.max(0.5, Math.min(5, Number(req.query.slAtrMult ?? 1.5)));
      const trailingEnabled = String(req.query.trailingEnabled ?? 'true') !== 'false';
      const stdDevMultiplier = Math.max(
        0.25,
        Math.min(3.0, Number(req.query.stdDevMultiplier || 1.0))
      );
      const source = req.query.source === '5S_TICKS' ? '5S_TICKS' : 'AUTO';

      const summary = await engine.runStrategyBacktest({
        optionKey,
        strategy,
        lots,
        maxTrades,
        cooldownMinutes,
        minCostMult,
        slAtrMult,
        trailingEnabled,
        stdDevMultiplier,
        source,
      });
      res.json(summary);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Strategy backtest failed',
      });
    }
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
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false });

  wss.on('error', (err) => {
    lastServerError = `WSS error: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[BankNifty 5s Radar] WebSocketServer error:', err);
  });

  wss.on('connection', (socket: WebSocket) => {
    socket.on('error', () => {
      // ignore transient client socket errors
    });
    try {
      socket.send(JSON.stringify(engine.getFullBroadcast('FULL_STATE')));
    } catch {
      // ignore transient socket send errors
    }
  });

  engine.on('broadcast', (payload) => {
    if (wss.clients.size === 0) return;
    const encoded = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(encoded);
        } catch {
          // ignore closed socket send errors
        }
      }
    }
  });

  process.on('uncaughtException', (err) => {
    lastServerError = err instanceof Error ? err.message : String(err);
    console.error('[BankNifty 5s Radar] Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    lastServerError = reason instanceof Error ? reason.message : String(reason);
    console.error('[BankNifty 5s Radar] Unhandled rejection:', reason);
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
