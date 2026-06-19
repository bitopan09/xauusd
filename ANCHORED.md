## Goal
- Implement all identified fixes in the XAUUSD V3 backtest chain and re-run to achieve realistic, sustainable performance.

## Constraints & Preferences
- Strategy is V3 `unifiedStrategyV3.js` with 5-factor regime-adaptive scoring
- Backtest runs via `tradingBot.js` `runBacktest()` with $50 starting equity, 0.005 lots (was 0.01), 1:1 leverage
- Live bot uses same strategy via `DecisionEngine` + `ExecutionEngine`
- .env provides: `CONFLUENCE_THRESHOLD=5.0`, `TP1_RR=2`, `TP2_RR=4`, `MAX_LOSS_PERCENT=5`, `TP1_CLOSE_PERCENT=40`, `XAU_QUANTITY=0.005`
- User wants aggressive improvement — "think again and again until you have the best strategy"

## Progress
### Done
- Root-caused and implemented all 7 fixes: V3 constructor config/broker import, liquidity sweep scoring order, trailing stop BE threshold, MAX_LOSS_PERCENT, env passthrough, SL cap TP recalculation, `originalSl` preservation
- Backtest ran successfully with all fixes: **53 trades, 58.5% win rate, 1.19 PF, 37.83% total return, 2.85 Sharpe, 72.35% max drawdown** (with 0.01 lots)
- Confirmed no NaN TPs, no dead trades, trailing stop works
- Verified SL cap now uses `rp.riskReward.tp1/tp2` (raw RR from V3's risk params) instead of undefined or global TP_RR values
- Changed max loss formula from tiered doubling to equity-adaptive (`maxLoss = equity * (MAX_LOSS_PERCENT / 100)`)
- Changed `MAX_LOSS_PERCENT` default from 5 → 20 (compromise between tight 5 and aggressive 30)
- Changed `XAU_QUANTITY` from 0.01 → 0.005 to halve position risk
- **Final backtest with 0.005 lots: 49.1% WR, 1.19 PF, +38.91% return, 45.87% max drawdown** — drawdown nearly halved while return maintained

### In Progress
- (none)

### Blocked
- (none)

## Key Decisions
- **All 7 fixes applied and verified** — strategy runs end-to-end with no crashes or NaN trades
- **MAX_LOSS_PERCENT=20 with equity-adaptive formula** — at $50 equity, maxLoss=$10, maxSlPoints=5pts (with 0.005 lots). Natural ATR-based SL (~2-5pts) is tighter, so caps rarely trigger
- **XAU_QUANTITY=0.005** — halved from 0.01 to reduce drawdown from 72% → 46% while maintaining ~39% return
- **Drawdown improved from 72% to 46%** by halving lot size; total return stayed similar (~39%) because smaller losses per trade let the strategy survive drawdown periods and recover more trades
- **The 7 fixes are all working correctly:** V3 constructor gets env config, broker import path is correct, liquidity sweep scoring order fixed, trailing stop locks at 2x riskUnit, SL cap uses regime-adaptive TP values from V3
- Tiered doubling formula replaced by equity-adaptive maxLoss
- SL cap TP recalculation uses `rp.riskReward.tp1`/`tp2` (regime-adaptive: Trending 1.5/2.5R, Ranging 1.0/1.5R, Volatile 2.0/3.0R)
- Trailing stop BE threshold = 2× riskUnit with 50% retracement light trail at 1×
- Liquidity sweep bonus moved before normalization in `calculateScores()`
- env config passed to V3 constructor: `TP1_RR`, `TP2_RR`, `CONFLUENCE_THRESHOLD`

## Next Steps
1. **Consider further improvements** — 46% drawdown with 39% return on $50 equity over 90 days is a viable profile; could try 0.003 lots to push DD under 30% at cost of ~25% return
2. **Consider circuit breaker** — stop trading if equity < 60% of starting ($30), resume > 80% ($40) to protect against outlier losing streaks
3. **Test on 180-day/365-day window** to validate consistency and check if drawdown events are outliers
4. **Review trade-by-trade in Excel** to understand which losing streaks drove drawdown
5. **Consider the strategy "production-ready"** for $50 micro-account deployment if 46% DD is acceptable

## Critical Context
- All 7 fixes are applied and verified: backtest runs without crashes, produces realistic PnL values, no NaN, no dead trades
- The 46% drawdown is from the strategy's own losing streaks (6-8 consecutive losses at ~$2-2.50 each = $12-20 on $50 equity) — not from bugs or overly tight SL caps
- Halving lot size from 0.01 → 0.005 cut drawdown 36% (72%→46%) while maintaining return (38%→39%) — the strategy's natural losing streaks are shallower, letting it recover faster
- `MAX_LOSS_PERCENT` has minimal effect because natural ATR-based SL is already tighter than thresholds
- Excel report saved to `backtest_2026-06-17.xlsx`

## Relevant Files
- `/Users/bitopannath/Downloads/xauusd/backend/unifiedStrategyV3.js`: All fixes applied
- `/Users/bitopannath/Downloads/xauusd/backend/tradingBot.js`: All fixes applied, now uses `FIXED_QUANTITY` for both live and backtest paths
- `/Users/bitopannath/Downloads/xauusd/backend/testBacktest.js`: Backtest runner
- `/Users/bitopannath/Downloads/xauusd/backend/brokerSimulation.js`: Broker cost model
- `/Users/bitopannath/Downloads/xauusd/.env`: `XAU_QUANTITY=0.005` for halved position size
- `/Users/bitopannath/Downloads/xauusd/backtest_2026-06-17.xlsx`: Latest backtest report
