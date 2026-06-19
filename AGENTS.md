# XAU/USD Backtest Project — Session Summary

## Goal
Make `V4-Plus` trading strategy profitable on XAU/USD at $50 starting capital with 0.01 minimum lots (broker constraint: any lots < 0.01 round to 0.01).

## Strategy Stack
- **Entry**: V4-Plus with 6.5 confluence threshold (8 indicators: DMI, Trend Index/Outlook, Oscillator, SMA, EMA, EMA2, PSAR, Stochastic)
- **Exit**: Multi-TP + trailing stop (50% at TP1, 25% at TP2, 25% trailing)
- **Risk**: Smart risk management — equity-aware position sizing, cool-off, daily loss cap, equity floor
- **Data**: 2024-08-29 to 2026-06-18 (90 days forward), XAU/USD 1H, cached

## Progress & Key Decisions

### Done
1. **Volume Factor (VOF) filter added to confluence** — 50% weight, with `volumeConfirm` flag
2. **VOF ATR filter** — filters low-volume high-volatility noise
3. **VOF breakout detection** — volume-prefixed breakouts
4. **VOF wick/reversal detection** — exhaustion patterns on high volume
5. **VOF Climax detection** — trend exhaustion volume spikes
6. **Min/Max SL guards** — SL clamped to `[ATR*0.5, ATR*2]` and capped by `MAX_SL_DISTANCE`
7. **Smart risk management in tradingBot.js** — equity floor ($15), cool-off (5 bars), daily loss cap (2/day), dynamic risk % (10→3% as equity drops), dynamic score threshold (8.0 for eq<$25, 9.0 for eq<$20)
8. **MAX_SL_DISTANCE env var** — passed through `fullBacktest.js` → `tradingBot.js` → `unifiedStrategyV3.js` calculateRiskParameters
9. **SL Distance Cap simulation** — tested maxSL=10,12,15,18,20,22,25 across capitals $50-$500:

### Simulation Results (simple model, 90 days)
| SL Cap | $50 → | $100 → | $200 → | WR | DD |
|--------|------|--------|--------|-----|----|
| 10pt | $135 | $207 | $310 | 55% | 31% |
| 12pt | $138 | $208 | $295 | 55% | 31% |
| 15pt | $140 | $210 | $310 | 55% | 31% |
| 20pt | $181 | $299 | $448 | 58% | 25% |

### 6H Backtest — Final Result (with session filtering + progressive sizing)
| Metric | Value |
|--------|-------|
| Trades | 41 |
| WR | 64.3% |
| PF | 1.83 |
| Final | **$651.83** |
| Return | **+1203.7%** |
| Max DD | $233.80 (32.4%) |

Key findings:
- **Session filtering** (07:00-17:00 UTC) reduced overtrading and improved WR
- **Progressive position sizing** (80/60/35 based on DD%) improved PF from 1.50 to 1.83
- SELL dominant (41/42 trades) with 63.4% WR; BUY (1 trade) won
- Exit reasons: TP2 (15 trades, all wins, +$1025), Stop Loss (15 trades, -$723), Trailing SL BE+ (12 trades, +$299)
- Volatile regime: 25 trades, 68% WR, +$380
- Ranging regime: 16 trades, 56% WR, +$104
- Trending regime: 1 trade, 100% WR, +$118
- **Costs now tracked**: spread $8.76, slippage $49.15, total $57.91

## Remaining Issues
1. **Max DD 32.4%** — acceptable but could be improved
2. **SELL bias** — 41/42 trades are SELL; strategy misses bullish moves
3. **15m/30m still broken** — regime detection always "unknown" on sub-1H

## Latest Session Work
### Batch Operations (API)
- Implemented batch endpoints: `/api/batch/approve`, `/api/batch/delete`, `/api/batch/create`, `/api/batch/update`, `/api/batch/find`
- Added validation for batch sizes (max 100 items)
- Updated OpenAPI spec with batch endpoint definitions

### Costs & Regime Display Fix
- Fixed server endpoint to forward `costs` from `baseResult` to API response
- Regime data was already present as `regimeStats` (computed from individual trades' `regime` field)
- Trade engine returns `regime` in analysis object (line 224 in tradeEngine.js)
