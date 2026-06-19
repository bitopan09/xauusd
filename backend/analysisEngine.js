/**
 * Analysis Engine — XAU/USD (Gold)
 * Delegates all logic to UnifiedStrategy.
 * This is the wrapper used by the live bot's DecisionEngine and TradingBot.
 */
const UnifiedStrategy = require('./unifiedStrategyV3');

class AnalysisEngine {
    constructor(config = {}) {
        const strategyConfig = {
            tp1ClosePercent: config.tp1ClosePercent ?? (Number(process.env.TP1_CLOSE_PERCENT) || 50),
            maxSlDistance: config.maxSlDistance ?? (Number(process.env.MAX_SL_DISTANCE) || 15),
            confluenceThreshold: config.confluenceThreshold ?? (Number(process.env.CONFLUENCE_THRESHOLD) || 5.5),
            tp1RR: config.tp1RR ?? (Number(process.env.TP1_RR) || undefined),
            tp2RR: config.tp2RR ?? (Number(process.env.TP2_RR) || undefined),
            interval: config.interval ?? 360,
        };
        this.strategy = new UnifiedStrategy(strategyConfig);
        this.indicators = {
            trendFilter: { enabled: true, timeframe: '6H', emaPeriod: 50 },
            srDetector: { enabled: true, lookbackPeriods: 100 },
            obFvGScanner: { enabled: true, minObSize: 0.01 },
            chochBosDetector: { enabled: true, timeframe: '6H' },
            confluenceScorer: { enabled: true, threshold: this.strategy.CONFLUENCE_THRESHOLD },
            riskCalculator: { enabled: true, riskPerTrade: 0.05 }
        };
    }

    /**
     * Analyze market data and generate trading signals
     * Delegates entirely to UnifiedStrategy for identical results everywhere.
     * @param {Array} priceData - Historical price data (6H candles)
     * @returns {Object} Analysis results with signal and score
     */
    analyze(priceData) {
        // Delegate to UnifiedStrategy which enforces its own minimum data check (50 candles)
        if (!priceData || priceData.length < 20) {
            return { signal: 'NEUTRAL', score: 0, details: 'Insufficient data' };
        }

        const result = this.strategy.analyze(priceData);

        // Wrap in the format expected by DecisionEngine and TradingBot
        return {
            signal: result.signal,
            score: result.score,
            details: {
                confluenceScorer: result.details.confluenceScorer,
                filterBreakdown: result.details.filterBreakdown,
                riskCalculator: result.details.riskCalculator,
                analysis: {
                    confluenceScorer: result.details.confluenceScorer,
                    filterBreakdown: result.details.filterBreakdown,
                    riskCalculator: result.details.riskCalculator
                },
                timestamp: result.details.timestamp
            }
        };
    }

    /**
     * Multi-timeframe analysis: 6H confluence × 15m ORB retest gating.
     * @param {Array} priceData6h  - 6H candles for V4 confluence scoring
     * @param {Array} priceData15m - 15m candles for ORB retest detection
     * @param {object} [options={}] - { sessionStart, pendingExpiryHrs, orbCandles }
     * @returns {{ signal: string, score: number, details: object }}
     */
    analyzeMTF(priceData6h, priceData15m, options = {}) {
        if (!priceData6h || priceData6h.length < 20) {
            return { signal: 'NEUTRAL', score: 0, details: 'Insufficient 6H data' };
        }

        const result = this.strategy.analyzeMTF(priceData6h, priceData15m, options);

        return {
            signal: result.signal,
            score: result.score,
            details: result.details,
        };
    }

    /**
     * Reset pending entry state (e.g. new day / session).
     */
    resetPendingEntries() {
        this.strategy.resetPendingEntries();
    }
}

module.exports = AnalysisEngine;
