import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BacktestSummary,
  RadarBroadcast,
  RadarSettings,
  StrategyBacktestParams,
  StrategyBacktestSummary,
  StreamKey,
} from '../../shared/types.js';

export function useRadarSocket() {
  const [state, setState] = useState<RadarBroadcast | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);

  const fetchInitialState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RadarBroadcast;
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load radar state');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/state')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<RadarBroadcast>;
      })
      .then((data) => {
        if (!cancelled) {
          setState(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load radar state');
        }
      });

    const connectWs = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setError(null);
      };

      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(String(ev.data)) as RadarBroadcast;
          setState(payload);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectTimer.current = window.setTimeout(connectWs, 2000);
        }
      };

      ws.onerror = () => {
        setConnected(false);
      };
    };

    connectWs();

    return () => {
      cancelled = true;
      if (reconnectTimer.current != null) {
        window.clearTimeout(reconnectTimer.current);
      }
      wsRef.current?.close();
    };
  }, []);

  const updateSettings = useCallback(async (partial: Partial<RadarSettings>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || 'Failed to update settings');
    }
    const next = (await res.json()) as RadarBroadcast;
    setState(next);
    return next;
  }, []);

  const snapToAtm = useCallback(async (): Promise<{ atmStrike: number; state: RadarBroadcast }> => {
    const res = await fetch('/api/strikes/snap-atm', { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || 'Failed to snap to ATM');
    }
    const data = (await res.json()) as { atmStrike: number; state: RadarBroadcast };
    setState(data.state);
    return data;
  }, []);

  const reseedScenario = useCallback(async (scenario?: RadarSettings['simScenario']) => {
    const res = await fetch('/api/simulator/reseed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    if (res.ok) {
      const next = (await res.json()) as RadarBroadcast;
      setState(next);
    }
  }, []);

  const connectDhanLive = useCallback(async (clientId: string, accessToken: string) => {
    const res = await fetch('/api/dhan/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, accessToken }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) {
      throw new Error(body.error || 'Failed to connect DhanHQ');
    }
    await fetchInitialState();
  }, [fetchInitialState]);

  const disconnectDhanLive = useCallback(async () => {
    await fetch('/api/dhan/disconnect', { method: 'POST' });
    await fetchInitialState();
  }, [fetchInitialState]);

  const runBacktest = useCallback(
    async (params: {
      streamKey: StreamKey;
      windowMinutes: number;
      stdDevMultiplier: number;
      triggerSecond: 45 | 50 | 55;
    }): Promise<BacktestSummary> => {
      const qs = new URLSearchParams({
        streamKey: params.streamKey,
        windowMinutes: String(params.windowMinutes),
        stdDevMultiplier: String(params.stdDevMultiplier),
        triggerSecond: String(params.triggerSecond),
      });
      const res = await fetch(`/api/backtest?${qs.toString()}`);
      if (!res.ok) throw new Error('Backtest failed');
      return (await res.json()) as BacktestSummary;
    },
    []
  );

  const runStrategyBacktest = useCallback(
    async (params: StrategyBacktestParams): Promise<StrategyBacktestSummary> => {
      const qs = new URLSearchParams({
        optionKey: params.optionKey,
        strategy: params.strategy,
        lots: String(params.lots),
        maxTrades: String(params.maxTrades),
        cooldownMinutes: String(params.cooldownMinutes),
        minCostMult: String(params.minCostMult),
        slAtrMult: String(params.slAtrMult),
        trailingEnabled: String(params.trailingEnabled),
        stdDevMultiplier: String(params.stdDevMultiplier),
        source: params.source ?? 'AUTO',
      });
      const res = await fetch(`/api/strategy-backtest?${qs.toString()}`);
      if (!res.ok) throw new Error('Strategy backtest failed');
      return (await res.json()) as StrategyBacktestSummary;
    },
    []
  );

  const fetchExpiries = useCallback(async (): Promise<string[]> => {
    const res = await fetch('/api/dhan/expiries');
    if (!res.ok) return [];
    const data = (await res.json()) as { expiries?: string[] };
    return data.expiries ?? [];
  }, []);

  return {
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
  };
}
