# 🥇 GoldForge — XAU/USD Automated Trading Bot

An intelligent, automated XAU/USD (Gold) trading bot with a premium web dashboard, real-time Bybit WebSocket prices, email notifications, and 24-hour operation in IST timezone.

## ✨ Features

✅ **Real-Time Gold Prices** — Bybit XAUUSDT WebSocket feed (zero delay)
✅ **24/7 Bot Operation** — Runs continuously in IST timezone
✅ **Fixed 0.01 Lot** — Consistent position sizing, never changes
✅ **Gold Trading Session** — 07:00–17:00 UTC (12:30 PM–10:30 PM IST)
✅ **10-Factor Confluence Scoring** — EMA, RSI, MACD, CPR, VWAP, Liquidity Sweeps, OTE, OB/FVG, CHoCH/BOS, Volume
✅ **Live Dashboard** — Real-time gold chart, trades, and balance tracking
✅ **Email Notifications** — Alerts for every trade executed
✅ **Trade Journal** — Comprehensive history with CSV export
✅ **Backtester** — Test strategy on real Bybit historical data
✅ **Manual Trading** — Execute paper trades manually
✅ **Docker Ready** — One-click deployment
✅ **Remote Access** — Deploy anywhere and access from any device

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm

### Installation

```bash
# Clone or navigate to the project
cd xauusd

# Run setup (installs deps + builds frontend)
chmod +x setup.sh && ./setup.sh

# OR manually:
npm install
cd frontend && npm install && npm run build && cd ..
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key settings:
```env
PORT=5002
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
NOTIFY_EMAIL=your-email@gmail.com
BOT_ENABLED=true
```

### Start the Bot

```bash
npm start
```

Visit `http://localhost:5002` to see the dashboard.

### Development Mode

```bash
# Terminal 1: Backend
npm run dev:backend

# Terminal 2: Frontend (hot reload)
npm run dev:frontend
```

## 📊 Trading Strategy

The bot uses a **10-factor institutional confluence scoring system**:

| Factor | Description |
|--------|-------------|
| EMA-50 Trend | Price above/below 50-period EMA |
| RSI | Relative Strength Index confirmation |
| MACD | Moving Average Convergence/Divergence |
| CPR Pivot Points | Central Pivot Range alignment |
| VWAP | Volume Weighted Average Price |
| Liquidity Sweep | Wyckoff stop hunt detection |
| OTE Zone | Optimal Trade Entry (Fibonacci 62-79%) |
| Order Block/FVG | Institutional order flow zones |
| CHoCH/BOS | Change of Character / Break of Structure |
| Volume | Volume confirmation |

**Minimum score: 7/10** to take a trade (A+ quality only).

## ⏰ Trading Session

| Session | UTC Time | IST Time |
|---------|----------|----------|
| London Open → NY Close | 07:00 – 17:00 | 12:30 PM – 10:30 PM |

This window captures the London session, London-NY overlap, and early NY session — when gold sees **70%+ of its daily volume** and the cleanest institutional price action.

## 🐳 Docker Deployment

```bash
docker-compose up -d
```

## 📁 Project Structure

```
xauusd/
├── backend/
│   ├── server.js           # Express + Bybit WebSocket
│   ├── tradingBot.js        # Core trading controller
│   ├── unifiedStrategy.js   # 10-factor confluence engine
│   ├── analysisEngine.js    # Strategy wrapper
│   ├── decisionEngine.js    # Session gate + circuit breaker
│   ├── executionEngine.js   # Trade lifecycle + trailing SL
│   └── emailService.js      # Email notifications
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Dashboard layout
│   │   ├── App.css          # Gold theme
│   │   ├── services/api.js  # API + WebSocket client
│   │   ├── utils/           # Time formatting
│   │   └── components/      # 7 dashboard components
│   ├── index.html
│   └── vite.config.js
├── package.json
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## 🔧 Risk Management

- **Dynamic Max Loss (10% Tiered):** Automatically caps the maximum loss to 10% of your account base. It steps up only when your account doubles (e.g., $5 max loss at $50, $10 max loss at $100).
- **Fixed Lot:** 0.01 oz per trade (never changes).
- **Daily Trade Limit:** 1 trade per session.
- **Circuit Breaker:** Stops trading after 2 consecutive losses.
- **Trailing Stop Loss:** 2R → breakeven, 3.5R → lock 60%, 5R → lock 80%.
- **Risk-Reward:** TP1 at 1:3, TP2 at 1:5.

## 📧 Email Setup (Gmail)

1. Enable 2-Factor Authentication on your Gmail account
2. Generate an App Password: Google Account → Security → App Passwords
3. Add to `.env`:
   ```env
   EMAIL_SERVICE=gmail
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=your-app-password
   NOTIFY_EMAIL=your-email@gmail.com
   ```
