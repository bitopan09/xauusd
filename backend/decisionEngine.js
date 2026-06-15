const AnalysisEngine = require('./analysisEngine');

class DecisionEngine {
    constructor() {
        this.analysisEngine = new AnalysisEngine();
        this.dailyTradeTaken = false;
        this.dailyLossCount = 0;
        this.lastTradeDate = null;
        this.circuitBreakerActive = false;

        // Load persistent state
        this._loadState();
    }

    /**
     * Make a trading decision based on market analysis
     * @param {Array} priceData - Historical price data
     * @returns {Object} Decision result with action and reasoning
     */
    async makeDecision(priceData) {
        // Reset daily stats if new day
        const today = new Date().toDateString();
        if (this.lastTradeDate !== today) {
            this.dailyTradeTaken = false;
            this.dailyLossCount = 0;
            this.lastTradeDate = today;
            this.circuitBreakerActive = false;
            this._saveState();
        }

        // Always perform technical analysis first so the live dashboard has real-time score & indicators
        const analysis = this.analysisEngine.analyze(priceData);

        // Check circuit breaker (2-loss rule)
        if (this.dailyLossCount >= 2) {
            this.circuitBreakerActive = true;
            return {
                action: 'SKIP',
                reason: '2-loss circuit breaker activated',
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    dailyLossCount: this.dailyLossCount,
                    circuitBreakerActive: true
                }
            };
        }

        // Check daily trade lock (only 1 trade per session)
        if (this.dailyTradeTaken) {
            return {
                action: 'SKIP',
                reason: 'Daily trade limit reached (1 trade per session)',
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    dailyTradeTaken: this.dailyTradeTaken
                }
            };
        }

        // Session time gate: 07:00 AM to 17:00 PM UTC
        // = London Open (07:00) through NY Afternoon (17:00)
        // = 12:30 PM to 10:30 PM IST
        // This captures London session + London-NY overlap + early NY — the best gold trading window
        const now = new Date();
        const hour = now.getUTCHours();
        const minute = now.getUTCMinutes();
        const timeInMinutes = hour * 60 + minute;
        const isSessionOpen = (timeInMinutes >= 7 * 60 && timeInMinutes <= 17 * 60); // 07:00 AM - 5:00 PM UTC

        if (!isSessionOpen) {
            return {
                action: 'SKIP',
                reason: 'Outside gold trading session (07:00-17:00 UTC / 12:30 PM-10:30 PM IST)',
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    currentHourUTC: hour,
                    sessionOpen: isSessionOpen
                }
            };
        }

        // News filter placeholder
        const newsFilterPassed = true;

        if (!newsFilterPassed) {
            return {
                action: 'SKIP',
                reason: 'News filter blocked trade',
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    newsFilterPassed: false
                }
            };
        }

        // Check if score meets the configured strategy threshold
        const threshold = analysis.details?.confluenceScorer?.threshold ?? 7;
        if (analysis.score < threshold) {
            return {
                action: 'SKIP',
                reason: `Confluence score too low: ${analysis.score}/${threshold}`,
                details: {
                    score: analysis.score,
                    threshold,
                    analysis: analysis.details
                }
            };
        }

        if (analysis.signal !== 'BUY' && analysis.signal !== 'SELL') {
            return {
                action: 'SKIP',
                reason: 'Confluence passed, but EMA/direction filter did not confirm a trade signal',
                details: {
                    score: analysis.score,
                    signal: analysis.signal,
                    analysis: analysis.details
                }
            };
        }

        // All checks passed - generate trade signal
        return {
            action: analysis.signal,
            reason: 'All checks passed, trade signal generated',
            details: {
                score: analysis.score,
                analysis: analysis.details,
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Record a trade outcome for tracking daily stats
     * @param {Object} tradeResult - Result of the trade
     */
    recordTradeOutcome(tradeResult) {
        const entryDate = new Date(tradeResult.timestamp).toDateString();
        const today = new Date().toDateString();

        // Only count towards today's stats if the trade was opened today
        if (entryDate === today) {
            const { pnl } = tradeResult;

            if (pnl < 0) {
                this.dailyLossCount++;
            }

            this.dailyTradeTaken = true;
            this._saveState();

            if (this.dailyLossCount >= 2) {
                this.circuitBreakerActive = true;
            }
        } else {
            console.log(`[DecisionEngine] Trade ID ${tradeResult.id} entered on ${entryDate} (not today: ${today}). Skipping daily session lock update.`);
        }
    }

    _loadState() {
        try {
            const state = null;
            if (state) {
                const parsed = JSON.parse(state);
                this.dailyTradeTaken = parsed.dailyTradeTaken || false;
                this.dailyLossCount = parsed.dailyLossCount || 0;
                this.lastTradeDate = parsed.lastTradeDate || null;
                this.circuitBreakerActive = parsed.circuitBreakerActive || false;
            }
        } catch (error) {
            console.error('Error loading state:', error);
        }
    }

    _saveState() {
        try {
            // In production, save to database
        } catch (error) {
            console.error('Error saving state:', error);
        }
    }
}

module.exports = DecisionEngine;
