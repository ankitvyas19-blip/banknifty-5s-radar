import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Candle, ForecastRecord, RadarSettings, StreamKey } from '../shared/types.js';

const DEFAULT_DATA_DIR = process.env.RADAR_DATA_DIR || path.resolve(process.cwd(), 'data');

export class RadarStore {
  private db: DatabaseSync;
  public readonly dbPath: string;

  constructor(dataDir = DEFAULT_DATA_DIR) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, 'radar.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS candles_5s (
        stream_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        prob_line REAL,
        bullish_pct INTEGER,
        source TEXT NOT NULL DEFAULT 'SIMULATOR',
        PRIMARY KEY (stream_key, symbol, time, source)
      );

      CREATE INDEX IF NOT EXISTS idx_candles_lookup
        ON candles_5s (stream_key, source, time DESC);

      CREATE TABLE IF NOT EXISTS forecasts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        target_minute_sec INTEGER NOT NULL,
        captured_at_sec INTEGER NOT NULL,
        trigger_second INTEGER NOT NULL,
        base_low REAL NOT NULL,
        base_high REAL NOT NULL,
        base_close REAL NOT NULL,
        low_dev_1m REAL NOT NULL,
        std_dev_low REAL NOT NULL,
        atr REAL NOT NULL,
        bullish_pct INTEGER NOT NULL,
        bearish_pct INTEGER NOT NULL,
        predicted_support REAL NOT NULL,
        predicted_resistance REAL NOT NULL,
        actual_open REAL,
        actual_high REAL,
        actual_low REAL,
        actual_close REAL,
        support_error_pts REAL,
        resistance_error_pts REAL,
        support_held INTEGER,
        resistance_respected INTEGER,
        direction_matched INTEGER,
        evaluated_at INTEGER,
        source TEXT NOT NULL DEFAULT 'SIMULATOR',
        UNIQUE(stream_key, symbol, target_minute_sec, trigger_second, source)
      );

      CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  public saveSettings(settings: RadarSettings): void {
    const stmt = this.db.prepare(`
      INSERT INTO kv_state (key, value, updated_at)
      VALUES ('radar_settings', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(JSON.stringify(settings), Date.now());
  }

  public loadSettings(): Partial<RadarSettings> | null {
    const stmt = this.db.prepare(`SELECT value FROM kv_state WHERE key = 'radar_settings'`);
    const row = stmt.get() as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as Partial<RadarSettings>;
    } catch {
      return null;
    }
  }

  public upsertCandles5s(
    streamKey: StreamKey,
    symbol: string,
    candles: Candle[],
    source: 'SIMULATOR' | 'DHAN_LIVE'
  ): void {
    if (candles.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO candles_5s (
        stream_key, symbol, time, open, high, low, close, volume, prob_line, bullish_pct, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_key, symbol, time, source) DO UPDATE SET
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        prob_line = excluded.prob_line,
        bullish_pct = excluded.bullish_pct
    `);

    this.db.exec('BEGIN');
    try {
      for (const c of candles) {
        stmt.run(
          streamKey,
          symbol,
          c.time,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          c.probLine ?? null,
          c.bullishPct ?? null,
          source
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public clearSimulatorCandles(): void {
    this.db.prepare(`DELETE FROM candles_5s WHERE source = 'SIMULATOR'`).run();
    this.db.prepare(`DELETE FROM forecasts WHERE source = 'SIMULATOR'`).run();
  }

  public getRecentCandles5s(
    streamKey: StreamKey,
    symbol: string,
    source: 'SIMULATOR' | 'DHAN_LIVE',
    limit = 1500
  ): Candle[] {
    const stmt = this.db.prepare(`
      SELECT time, open, high, low, close, volume, prob_line, bullish_pct
      FROM candles_5s
      WHERE stream_key = ? AND symbol = ? AND source = ?
      ORDER BY time DESC
      LIMIT ?
    `);
    const rows = stmt.all(streamKey, symbol, source, limit) as Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      prob_line: number | null;
      bullish_pct: number | null;
    }>;

    return rows.reverse().map((r) => ({
      time: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      probLine: r.prob_line ?? undefined,
      bullishPct: r.bullish_pct ?? undefined,
    }));
  }

  public getStreamCandlesForBacktest(
    streamKey: StreamKey,
    source: 'SIMULATOR' | 'DHAN_LIVE',
    limit = 5000
  ): { symbol: string; candles: Candle[] } {
    const latestRow = this.db
      .prepare(
        `SELECT symbol FROM candles_5s WHERE stream_key = ? AND source = ? ORDER BY time DESC LIMIT 1`
      )
      .get(streamKey, source) as { symbol?: string } | undefined;

    if (!latestRow?.symbol) {
      return { symbol: streamKey, candles: [] };
    }
    return {
      symbol: latestRow.symbol,
      candles: this.getRecentCandles5s(streamKey, latestRow.symbol, source, limit),
    };
  }

  public saveForecast(
    record: ForecastRecord,
    source: 'SIMULATOR' | 'DHAN_LIVE'
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO forecasts (
        stream_key, symbol, target_minute_sec, captured_at_sec, trigger_second,
        base_low, base_high, base_close, low_dev_1m, std_dev_low, atr,
        bullish_pct, bearish_pct, predicted_support, predicted_resistance, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_key, symbol, target_minute_sec, trigger_second, source) DO NOTHING
    `);
    stmt.run(
      record.streamKey,
      record.symbol,
      record.targetMinuteSec,
      record.capturedAtSec,
      record.triggerSecond,
      record.baseLow,
      record.baseHigh,
      record.baseClose,
      record.lowDev1m,
      record.stdDevLow,
      record.atr,
      record.bullishPct,
      record.bearishPct,
      record.predictedSupport,
      record.predictedResistance,
      source
    );
  }

  public evaluateCompletedMinuteForecasts(params: {
    streamKey: StreamKey;
    symbol: string;
    minuteSec: number;
    actualOpen: number;
    actualHigh: number;
    actualLow: number;
    actualClose: number;
    tolerance: number;
    source: 'SIMULATOR' | 'DHAN_LIVE';
  }): void {
    const pending = this.db
      .prepare(`
        SELECT id, base_low, bullish_pct, predicted_support, predicted_resistance
        FROM forecasts
        WHERE stream_key = ? AND symbol = ? AND target_minute_sec = ? AND source = ? AND evaluated_at IS NULL
      `)
      .all(params.streamKey, params.symbol, params.minuteSec, params.source) as Array<{
      id: number;
      base_low: number;
      bullish_pct: number;
      predicted_support: number;
      predicted_resistance: number;
    }>;

    if (pending.length === 0) return;

    const updateStmt = this.db.prepare(`
      UPDATE forecasts SET
        actual_open = ?,
        actual_high = ?,
        actual_low = ?,
        actual_close = ?,
        support_error_pts = ?,
        resistance_error_pts = ?,
        support_held = ?,
        resistance_respected = ?,
        direction_matched = ?,
        evaluated_at = ?
      WHERE id = ?
    `);

    const now = Date.now();
    for (const row of pending) {
      const supportErr = Math.round(Math.abs(params.actualLow - row.predicted_support) * 100) / 100;
      const resErr = Math.round(Math.abs(params.actualHigh - row.predicted_resistance) * 100) / 100;
      const supportHeld = params.actualLow >= row.predicted_support - params.tolerance ? 1 : 0;
      const resRespected = params.actualHigh <= row.predicted_resistance + params.tolerance ? 1 : 0;
      const predUp = row.bullish_pct >= 50;
      const actualUp = params.actualClose >= params.actualOpen || params.actualLow >= row.base_low;
      const dirMatched = predUp === actualUp ? 1 : 0;

      updateStmt.run(
        params.actualOpen,
        params.actualHigh,
        params.actualLow,
        params.actualClose,
        supportErr,
        resErr,
        supportHeld,
        resRespected,
        dirMatched,
        now,
        row.id
      );
    }
  }

  public getRecentForecasts(
    streamKey: StreamKey,
    source: 'SIMULATOR' | 'DHAN_LIVE',
    limit = 20
  ): ForecastRecord[] {
    const rows = this.db
      .prepare(`
        SELECT
          id, stream_key, symbol, target_minute_sec, captured_at_sec, trigger_second,
          base_low, base_high, base_close, low_dev_1m, std_dev_low, atr,
          bullish_pct, bearish_pct, predicted_support, predicted_resistance,
          actual_open, actual_high, actual_low, actual_close,
          support_error_pts, resistance_error_pts, support_held, resistance_respected,
          direction_matched, evaluated_at
        FROM forecasts
        WHERE stream_key = ? AND source = ?
        ORDER BY target_minute_sec DESC, trigger_second DESC
        LIMIT ?
      `)
      .all(streamKey, source, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      streamKey: r.stream_key as StreamKey,
      symbol: String(r.symbol),
      targetMinuteSec: Number(r.target_minute_sec),
      capturedAtSec: Number(r.captured_at_sec),
      triggerSecond: Number(r.trigger_second),
      baseLow: Number(r.base_low),
      baseHigh: Number(r.base_high),
      baseClose: Number(r.base_close),
      lowDev1m: Number(r.low_dev_1m),
      stdDevLow: Number(r.std_dev_low),
      atr: Number(r.atr),
      bullishPct: Number(r.bullish_pct),
      bearishPct: Number(r.bearish_pct),
      predictedSupport: Number(r.predicted_support),
      predictedResistance: Number(r.predicted_resistance),
      actualOpen: r.actual_open == null ? null : Number(r.actual_open),
      actualHigh: r.actual_high == null ? null : Number(r.actual_high),
      actualLow: r.actual_low == null ? null : Number(r.actual_low),
      actualClose: r.actual_close == null ? null : Number(r.actual_close),
      supportErrorPts: r.support_error_pts == null ? null : Number(r.support_error_pts),
      resistanceErrorPts:
        r.resistance_error_pts == null ? null : Number(r.resistance_error_pts),
      supportHeld: r.support_held == null ? null : Boolean(r.support_held),
      resistanceRespected:
        r.resistance_respected == null ? null : Boolean(r.resistance_respected),
      directionMatched:
        r.direction_matched == null ? null : Boolean(r.direction_matched),
      evaluatedAt: r.evaluated_at == null ? null : Number(r.evaluated_at),
    }));
  }
}
