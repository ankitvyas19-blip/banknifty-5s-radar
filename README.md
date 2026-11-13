# BankNifty 5s Scalp Radar

Real-time **Bank Nifty Spot**, **Nifty 50 Spot**, and **Bank Nifty Call (CE) / Put (PE)** live radar with **3-minute rolling 5-second candles**, **Dynamic Bullish/Bearish Probability Line**, **`:50s` / `:55s` Early Next-Candle Support & Resistance Forecasting**, SQLite persistence, Look-Ahead-Free Backtesting, and **DhanHQ v2 Binary WebSocket** integration.

## Features
- **4-Chart Synchronized Radar**: Bank Nifty Spot (`IDX_I:25`), Nifty 50 Spot (`IDX_I:13`), dynamic CE strike, and dynamic PE strike with custom Trade Entry Price & live ₹ P&L tracking.
- **3-Minute Rolling 5s Engine**: Computes Low-to-Low / High-to-High directional drift ($\mu$), Standard Deviation ($\sigma$), and ATR across the latest 3-minute 5-second candles.
- **Early `:50s` & `:55s` Tentative Result**: Locks next-minute Support (Probable Low) and Resistance (Probable High) 5–10 seconds before the current 1-minute candle closes.
- **DhanHQ v2 Live Connector**: Binary Little-Endian WebSocket parser (`wss://api-feed.dhan.co?version=2`) + automatic `NSE_FNO` strike `SecurityId` resolution from Dhan Scrip Master.
- **Built-In Market Simulator**: Instant testing with `Bullish 61360→61368 (+8pt)`, `Bearish Breakdown`, `Choppy Range`, and `Volatility Spike` scenarios at `1× / 2× / 5×` speed.
- **Look-Ahead-Free Backtester**: Evaluates `:45s / :50s / :55s` predictions against completed 1-minute candles with tunable window and StdDev multiplier $k$.

## Local Run

```bash
npm install
npm run dev
```

Or build and run in production mode:

```bash
npm run build
npm start
```

## Google Cloud Run (Always-On Collector)

```bash
gcloud run deploy banknifty-5s-radar \
  --source . \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 1 \
  --no-cpu-throttling \
  --set-env-vars "NODE_ENV=production,DHAN_AUTO_CONNECT=true" \
  --set-secrets "DHAN_CLIENT_ID=dhan-client-id:latest,DHAN_ACCESS_TOKEN=dhan-token:latest"
```
