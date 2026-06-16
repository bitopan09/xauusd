/**
 * Analysis Engine — XAU/USD (Gold)
 * Delegates all logic to UnifiedStrategy.
 * This is the wrapper used by the live bot's DecisionEngine and TradingBot.
 */
const UnifiedStrategy = require('./unifiedStrategy');

class AnalysisEngine {
    constructor() {
        this.strategy = new UnifiedStrategy();
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
     * @param {Array} priceData - Historical price data
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
}

module.exports = AnalysisEngine;
