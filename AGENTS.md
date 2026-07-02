# XAU/USD Backtest Project — Session Summary

## Goal
Make `V4-Plus` trading strategy profitable on XAU/USD at $50 starting capital with 0.01 minimum lots. Ready for Railway 24x7 deployment.

## Strategy Stack
- **Entry**: V4-Plus with 6.5 confluence threshold (8 indicators: DMI, Trend Index/Outlook, Oscillator, SMA, EMA, EMA2, PSAR, Stochastic)
- **Exit**: Multi-TP + trailing stop (60% at TP1, 25% at TP2, 15% trailing)
- **Risk**: Smart risk management — equity-aware position sizing, cool-off, daily loss cap (2/day), equity floor ($15)
- **Broker**: OctaFX standard — 4.2 pip slippage, 4.0 pip spread, $0 commission, session-aware fills
- **Data**: Binance XAUUSDT 6H (real-time WS + REST), + 15m MTF data

## Optimized Configuration (Deployed)
| Param | Value |
|-------|-------|
| confluenceThreshold | 6.5 |
| tp1ClosePercent | 60% |
| maxSlDistance | 10 pts |
| scoreMarginMin | 1.0 |
| buyScoreMargin | 2.0 |
| emaAlignmentRequired | false |

## Optimizer Results (216-config grid, 50-day window)
| Metric | Value |
|--------|-------|
| PF | 10.0 |
| WR | 87.5% |
| Trades | 8 |
| Final Equity | $159.40 (+218.8%) |
| Sharpe | 3.58 |
| Max DD | 8.2% (optimizer metric) |

## Latest Session Work (Completed)

### 1. Real-Time Chart Fix
- **Problem**: Frontend fetched candles from Bybit REST, but WebSocket pushed Binance data — different OHLC values caused chart glitches
- **Fix**: Added `/api/candles` endpoint using Binance REST; updated `api.js` `fetchCandles()` to use backend; both initial load + real-time updates now from Binance

### 2. Slippage Calibration
- Updated `brokerSimulation.js` baseSlippage from 41 → 42 points (4.1 → 4.2 pips) per user's OctaFX experience

### 3. Optimizer Parameter Wiring
- **Problem**: `scoreMarginMin`, `buyScoreMargin`, `emaAlignmentRequired` were in the optimizer grid but NOT wired to the strategy
- **Fix**: Added to `UnifiedStrategy` constructor (unifiedStrategyV3.js:59-61); wired through `runFastBacktest` in server.js; made score margin gate and EMA alignment filter configurable
- `SCORE_MARGIN_MIN`: Controls minimum directional confidence margin (was hardcoded 1.0)
- `BUY_SCORE_MARGIN`: Controls minimum margin for BUY trades (was hardcoded 2.0)
- `EMA_ALIGNMENT_REQUIRED`: Optional hard block on BUY without EMA alignment (was always penalty-based)

### 4. Daily Optimizer (Auto-Deploy)
- Grid search over 6 parameters, 216 configs (reduced from 8,064 for memory efficiency)
- **Evaluation**: `score = PF × (1 - maxDD/100) × tradeBonus` — hard filters: WR < 40%, DD > 30%, < 5 trades
- **ML filter**: Logistic regression on 13 features, confidence threshold 0.45
- **Auto-deploy**: Deploys if score improves 5%+ over current config
- **Schedule**: Daily at 01:00 UTC (off-session)
- **Production**: Daily cron, DB persistence, `_loadOptimizerConfig()` on bot startup

### 5. Performance Optimizations
- Suppressed `[DEBUG calcRP]` log spam (360K lines/run → 0 lines)
- Increased Node.js heap to 4GB for grid search
- Reduced optimizer grid from 8,064 to 216 configs (focused on proven ranges)

### 6. Production Readiness
- All Binance WebSocket streams (ticker, 6H/1m/5m kline) connected
- Candle API serves real Binance data (not Bybit)
- Optimizer config loaded from DB on startup
- Auto-start bot on server launch
- Session gate: 06:00-20:00 UTC trading window
- Risk management: daily loss cap, equity floor, cool-off, dynamic sizing

## Key Files Modified
| File | Changes |
|------|---------|
| `backend/brokerSimulation.js` | Slippage 41→42 points |
| `backend/unifiedStrategyV3.js` | Wired SCORE_MARGIN_MIN, BUY_SCORE_MARGIN, EMA_ALIGNMENT_REQUIRED; suppressed debug logs |
| `backend/server.js` | Added `/api/candles` endpoint; wired optimizer params to fast backtest |
| `backend/dataManager.js` | Added `getCandles()` method for SQLite cache query |
| `backend/optimizer/config.js` | Reduced grid to 216 focused configs |
| `frontend/src/services/api.js` | `fetchCandles` now uses backend Binance API instead of Bybit |

## Deployment (Railway)
```bash
# Environment variables for Railway:
CONFLUENCE_THRESHOLD=6.5
TP1_CLOSE_PERCENT=60
MAX_SL_DISTANCE=10
SCORE_MARGIN_MIN=1
BUY_SCORE_MARGIN=2
EMA_ALIGNMENT_REQUIRED=false
NODE_OPTIONS=--max-old-space-size=4096
```

## Known Limitations
1. **50-day Binance data**: XAUUSDT only has ~50 days on Binance Futures — backtest quality limited by data
2. **15m regime detection**: Broken on sub-1H timeframes (pre-existing)
3. **MaxDD in live**: Higher than optimizer suggests due to equity-based position sizing — mitigated by daily loss cap and equity floor
