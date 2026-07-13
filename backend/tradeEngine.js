/**
 * TRADE ENGINE — Unified Trade Evaluation Module
 *
 * Extracts shared trade entry/exit/risk logic from runBacktest() and live
 * _analyzeAndTrade() so both paths use identical code. This eliminates the
 * 18 divergences between backtest and live trading.
 *
 * Usage:
 *   const TradeEngine = require('./tradeEngine');
 *   const engine = new TradeEngine({ strategy, broker, config });
 *
 *   // Entry evaluation
 *   const entryResult = engine.evaluateEntry({
 *     currentCandle, currentWindow, historicalData, index,
 *     equity, consecutiveLossCooloff, dailyLossCount,
 *   });
 *
 *   // Exit evaluation (trailing stop + TP/SL)
 *   const exitResult = engine.evaluateExit(trade, currentCandle);
 *
 *   // Equity curve tracking
 *   engine.markToMarket(trade, currentCandle);
 */

const { isUsdNewsBlocked } = require('./newsFilter');

const CONTRACT_SIZE = 100;

class TradeEngine {
    /**
     * @param {Object} options
     * @param {UnifiedStrategyV3} options.strategy - Strategy instance
     * @param {BrokerSimulation}  options.broker    - Broker simulation instance
     * @param {Object}            options.config    - Runtime overrides
     */
    constructor({ strategy, broker, config = {} }) {
        this.strategy = strategy;
        this.broker = broker;

        // ── Session hours (unified) ────────────────────────────────
        this.SESSION_START_MIN = config.sessionStartMin ?? 0;    // 00:00 UTC (24h trading)
        this.SESSION_END_MIN   = config.sessionEndMin   ?? 23 * 60 + 59; // 23:59 UTC

        // ── Dynamic confluence threshold (equity-based) ─────────────
        // Relaxed: allow more signals to pass for $50 starting capital
        this.EQUITY_THRESHOLDS = config.equityThresholds ?? [
            { minEquity: 100, minScore: 0 },   // Above $100: no threshold
            { minEquity: 50,  minScore: 4.0 }, // $50-100: threshold 4.0
            { minEquity: 30,  minScore: 4.5 }, // $30-50: threshold 4.5
            { minEquity: 15,  minScore: 5.0 }, // $15-30: threshold 5.0
            { minEquity: 0,   minScore: 5.5 },  // Below $15: threshold 5.5
        ];

        // ── Dynamic risk % (equity-based tiers) ────────────────────
        // Scales risk *down* as equity grows to prevent over-leverage:
        //   $0-30:   3%  (conservative recovery)
        //   $30-45:  5%
        //   $45-60:  7.5%
        //   $60-200: 10% (sweet spot for compounding)
        //   $200-400:7.5% (de-risk as equity grows)
        //   $400+:   5%  (preserve capital, steady compounding)
        this.EQUITY_RISK_PCT = config.equityRiskPct ?? [
            { minEquity: 400, riskPct: 5 },
            { minEquity: 200, riskPct: 7.5 },
            { minEquity: 60,  riskPct: 10 },
            { minEquity: 45,  riskPct: 7.5 },
            { minEquity: 30,  riskPct: 5 },
            { minEquity: 0,   riskPct: 3 },
        ];

        // ── Risk management ────────────────────────────────────────
        this.MAX_POSITION_LOTS  = config.maxPositionLots ?? (Number(process.env.MAX_POSITION_LOTS) || 0.1);
        this.FIXED_QUANTITY     = config.fixedQuantity    ?? (Number(process.env.XAU_QUANTITY) || 0.01);
        this.EQUITY_FLOOR       = config.equityFloor      ?? 15;
        this.MAX_DAILY_LOSSES   = config.maxDailyLosses   ?? 2;
        this.COOLOFF_MULTIPLIER = config.cooloffMultiplier ?? 3;
        this.MAX_COOLOFF        = config.maxCooloff        ?? 5;
    }

    // ───────────────────────────────────────────────────────────────
    // ENTRY EVALUATION
    // ───────────────────────────────────────────────────────────────

    /**
     * Evaluate whether to open a new trade on this candle.
     * Returns { open: true, trade } or { open: false, reason }.
     *
     * @param {Object}  params
     * @param {Object}  params.currentCandle  - The current 6H candle
     * @param {Array}   params.currentWindow  - 50-candle sliding window
     * @param {Array}   params.historicalData - Full data array (for next-candle fill)
     * @param {number}  params.index          - Current index in historicalData
     * @param {number}  params.equity         - Current equity
     * @param {number}  params.consecutiveLossCooloff - Current cooloff counter (decremented externally)
     * @param {number}  params.dailyLossCount - Losses today
     * @param {Array|null} params.sub15mData  - 15m candle array for MTF analysis
     * @param {boolean} params.useMTF         - Whether to use multi-timeframe analysis
     * @returns {Object} { open, reason, trade? }
     */
    evaluateEntry({
        currentCandle,
        currentWindow,
        historicalData,
        index,
        equity,
        consecutiveLossCooloff,
        dailyLossCount,
        sub15mData = null,
        useMTF = false,
        mtfData = null,
    }) {
        // 1. Equity floor — skip if equity too low
        if (equity < this.EQUITY_FLOOR) {
            return { open: false, reason: 'equity_floor', analysis: null };
        }

        // 2. Consecutive loss cool-off
        if (consecutiveLossCooloff > 0) {
            return { open: false, reason: 'cooloff', analysis: null };
        }

        // 3. Daily loss limit
        if (dailyLossCount >= this.MAX_DAILY_LOSSES) {
            return { open: false, reason: 'daily_loss_limit', analysis: null };
        }

        // 4. Session hour gate
        const hour = currentCandle.timestamp.getUTCHours();
        const minute = currentCandle.timestamp.getUTCMinutes();
        const timeInMinutes = hour * 60 + minute;
        const isSessionOpen = (timeInMinutes >= this.SESSION_START_MIN && timeInMinutes <= this.SESSION_END_MIN);
        if (!isSessionOpen) {
            return { open: false, reason: 'outside_session', analysis: null };
        }

        // 5. News filter
        const newsFilter = isUsdNewsBlocked(currentCandle.timestamp);
        if (newsFilter.blocked) {
            return { open: false, reason: 'news_blocked', analysis: null };
        }

        // 6. Run analysis (MTF if available, else single-TF)
        // Pass mtfData for 5-TF ZLEMA hard gate if available
        const analysis = useMTF && sub15mData && sub15mData.length >= 4
            ? this.strategy.analyzeMTF(currentWindow, sub15mData, {
                sessionStart: currentCandle.timestamp,
                orbCandles: 2,
              }, mtfData)
            : this.strategy.analyze(currentWindow, mtfData);

        // 7. Skip pending MTF signals
        if (analysis.signal === 'PENDING_BUY' || analysis.signal === 'PENDING_SELL') {
            return { open: false, reason: 'pending_mtf', analysis };
        }

        // 8. Map EXECUTE_BUY/EXECUTE_SELL → BUY/SELL
        const signal = analysis.signal === 'EXECUTE_BUY' ? 'BUY'
                     : analysis.signal === 'EXECUTE_SELL' ? 'SELL'
                     : analysis.signal;

        if (signal !== 'BUY' && signal !== 'SELL') {
            return { open: false, reason: 'no_signal', analysis };
        }

        // 9. Dynamic confluence threshold — equity-based tiers
        const score = analysis.score || 0;
        const minScore = this._getMinScore(equity);
        if (score < minScore) {
            return { open: false, reason: `score_too_low:${score.toFixed(1)}<${minScore}`, analysis };
        }

        // 10. Calculate entry fill price (with spread + slippage)
        const nextCandle = historicalData[index + 1];
        if (!nextCandle) {
            return { open: false, reason: 'no_next_candle', analysis };
        }

        const rp = analysis.details.riskCalculator;
        const entryFillResult = this.broker.calculateEntryFill(
            signal,
            currentCandle,
            nextCandle,
            { atr: rp.atr, quantity: this.FIXED_QUANTITY }
        );
        const entryFill = entryFillResult.fillPrice;

        // 11. Dynamic risk % — position sizing
        const effectiveRiskPct = this._getRiskPct(equity);
        const entryPrice = analysis.details?.mtf?.entryPrice || entryFill;
        const slDistance = Math.abs(entryPrice - (signal === 'BUY' ? rp.stopLoss.long : rp.stopLoss.short));
        const riskAmount = Math.max(1, equity * (effectiveRiskPct / 100));
        const rawQty = slDistance > 0 ? riskAmount / (slDistance * CONTRACT_SIZE) : this.FIXED_QUANTITY;
        const quantity = Math.max(0.01, Math.min(this.MAX_POSITION_LOTS, Math.round(rawQty * 100) / 100));

        // 12. SL-based position limit — skip if min lot risk exceeds equity
        const actualRisk = slDistance * CONTRACT_SIZE * quantity;
        if (actualRisk >= equity) {
            return { open: false, reason: 'risk_exceeds_equity', analysis };
        }

        // 13. Recalculate SL/TP anchored to actual entry fill price
        const finalSlDistance = rp.slDistance;
        const tp1Distance = finalSlDistance * rp.tp1RR;
        const tp2Distance = finalSlDistance * rp.tp2RR;
        let sl, originalSl, tp1, tp2;
        if (signal === 'BUY') {
            sl = entryFill - finalSlDistance;
            tp1 = entryFill + tp1Distance;
            tp2 = entryFill + tp2Distance;
        } else {
            sl = entryFill + finalSlDistance;
            tp1 = entryFill - tp1Distance;
            tp2 = entryFill - tp2Distance;
        }
        originalSl = sl;

        return {
            open: true,
            reason: 'signal_confirmed',
            trade: {
                action: signal,
                entryPrice: entryFill,
                quantity,
                initialQuantity: quantity,
                remainingQuantity: quantity,
                realizedPnl: 0,
                tp1Hit: false,
                sl,
                originalSl,
                tp1,
                tp2,
                atr: rp.atr,
                score: analysis.score,
                confluence: analysis.details.confluenceScorer?.details || '',
                regime: analysis.details?.regime?.regime || 'unknown',
                timestamp: currentCandle.timestamp,
                status: 'OPEN',
                filterBreakdown: analysis.details?.filterBreakdown || null,
                zlema5TFGate: analysis.details?.zlema5TFGate || null,
            },
            costs: {
                spread: entryFillResult.spread,
                slippage: entryFillResult.slippage,
                commission: entryFillResult.commission,
            },
            analysis,  // Full analysis result for regime tracking and diagnostics
        };
    }

    // ───────────────────────────────────────────────────────────────
    // EXIT EVALUATION
    // ───────────────────────────────────────────────────────────────

    /**
     * Evaluate whether an open trade should be closed/managed on this candle.
     * Wraps UnifiedStrategy.checkTradeExit() — identical for live and backtest.
     *
     * @param {Object} trade  - The active trade object
     * @param {Object} candle - The current candle { open, high, low, close }
     * @returns {Object} { closed, partial, exitResult }
     */
    evaluateExit(trade, candle) {
        const exitResult = this.strategy.checkTradeExit(trade, candle);
        return exitResult;
    }

    /**
     * Calculate mark-to-market P&L for equity curve tracking.
     * @param {Object} trade      - Active trade
     * @param {number} exitPrice  - Current price to mark against
     * @returns {number} unrealized P&L in USD
     */
    calculateTradePnl(trade, exitPrice) {
        const remainingQuantity = trade.remainingQuantity ?? trade.remaining_quantity ?? trade.quantity;
        const realizedPnl = trade.realizedPnl ?? trade.realized_pnl ?? 0;
        const positionSize = remainingQuantity * CONTRACT_SIZE;

        // Use broker slippage for realistic mark-to-market
        const slippage = this.broker.calculateSlippage({
            side: trade.action === 'BUY' ? 'SELL' : 'BUY',
            candle: trade,
            atr: trade.atr,
            quantity: remainingQuantity,
        });
        const fillPrice = trade.action === 'BUY'
            ? exitPrice - slippage * this.broker.POINT_VALUE
            : exitPrice + slippage * this.broker.POINT_VALUE;
        const unrealizedPnl = trade.action === 'BUY'
            ? (fillPrice - trade.entryPrice) * positionSize
            : (trade.entryPrice - fillPrice) * positionSize;
        return realizedPnl + unrealizedPnl;
    }

    // ───────────────────────────────────────────────────────────────
    // HELPER: Dynamic threshold lookups
    // ───────────────────────────────────────────────────────────────

    _getMinScore(equity) {
        for (const tier of this.EQUITY_THRESHOLDS) {
            if (equity >= tier.minEquity) return tier.minScore;
        }
        return this.EQUITY_THRESHOLDS[this.EQUITY_THRESHOLDS.length - 1].minScore;
    }

    _getRiskPct(equity) {
        for (const tier of this.EQUITY_RISK_PCT) {
            if (equity >= tier.minEquity) return tier.riskPct;
        }
        return this.EQUITY_RISK_PCT[this.EQUITY_RISK_PCT.length - 1].riskPct;
    }

    /**
     * Check if session is currently open.
     * @param {Date} timestamp
     * @returns {boolean}
     */
    isSessionOpen(timestamp) {
        const hour = timestamp.getUTCHours();
        const minute = timestamp.getUTCMinutes();
        const timeInMinutes = hour * 60 + minute;
        return (timeInMinutes >= this.SESSION_START_MIN && timeInMinutes <= this.SESSION_END_MIN);
    }
}

module.exports = TradeEngine;
