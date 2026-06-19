const AnalysisEngine = require('./analysisEngine');
const { isUsdNewsBlocked } = require('./newsFilter');

class DecisionEngine {
    constructor(db = null, config = {}) {
        this.db = db;
        this.analysisEngine = new AnalysisEngine({
            tp1ClosePercent: config.tp1ClosePercent ?? (Number(process.env.TP1_CLOSE_PERCENT) || 50),
            maxSlDistance: config.maxSlDistance ?? (Number(process.env.MAX_SL_DISTANCE) || 15),
            confluenceThreshold: config.confluenceThreshold ?? (Number(process.env.CONFLUENCE_THRESHOLD) || 5.5),
            interval: config.interval ?? (Number(process.env.BACKTEST_INTERVAL) || 360),
        });
        this.dailyTradeTaken = false;
        this.dailyLossCount = 0;
        this.lastTradeDate = null;
        this.circuitBreakerActive = false;
        this.sessionLossCount = 0;
        this.lastSessionLabel = null;
        this.LOSSES_PER_SESSION = config.lossesPerSession ?? 1;
        this.MAX_DAILY_LOSSES = config.maxDailyLosses ?? 2;

        // Load persistent state
        this._ensureStateTable();
        this._loadState();
    }

    /**
     * Get current session label based on UTC hour.
     */
    _getSessionLabel(hour) {
        if (hour >= 7 && hour < 12) return 'LONDON';
        if (hour >= 12 && hour < 17) return 'NY';
        return 'OUTSIDE';
    }

    /**
     * Make a trading decision based on market analysis
     * @param {Array} priceData - Historical price data (6H candles)
     * @returns {Object} Decision result with action and reasoning
     */
    async makeDecision(priceData) {
        return this._makeDecisionInternal(priceData, null, false);
    }

    /**
     * Multi-timeframe decision: 6H confluence × 15m ORB retest.
     * @param {Array} priceData6h  - 6H candles
     * @param {Array} priceData15m - 15m candles
     * @returns {Promise<{action: string, reason: string, details: object}>}
     */
    async makeDecisionMTF(priceData6h, priceData15m) {
        return this._makeDecisionInternal(priceData6h, priceData15m, true);
    }

    /**
     * Internal decision logic (shared between single-TF and MTF).
     */
    async _makeDecisionInternal(priceData6h, priceData15m = null, useMTF = false) {
        // Reset daily stats if new day
        const today = new Date().toDateString();
        if (this.lastTradeDate !== today) {
            this.dailyTradeTaken = false;
            this.dailyLossCount = 0;
            this.lastTradeDate = today;
            this.sessionLossCount = 0;
            this.lastSessionLabel = null;
            this.circuitBreakerActive = false;
            this._saveState();
        }

        // Always perform technical analysis first
        const analysis = useMTF
            ? this.analysisEngine.analyzeMTF(priceData6h, priceData15m)
            : this.analysisEngine.analyze(priceData6h);

        // Check circuit breaker (session + daily limits)
        if (this.dailyLossCount >= this.MAX_DAILY_LOSSES) {
            this.circuitBreakerActive = true;
            return {
                action: 'SKIP',
                reason: `Daily circuit breaker activated (${this.dailyLossCount}/${this.MAX_DAILY_LOSSES} losses)`,
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
        const now = new Date();
        const hour = now.getUTCHours();
        const minute = now.getUTCMinutes();
        const timeInMinutes = hour * 60 + minute;
        const isSessionOpen = (timeInMinutes >= 6 * 60 && timeInMinutes <= 20 * 60);

        if (!isSessionOpen) {
            // Allow PENDING signals through even outside hours (they were created during session)
            if (analysis.signal && analysis.signal.startsWith('PENDING_')) {
                return {
                    action: analysis.signal === 'PENDING_BUY' ? 'PENDING_BUY' : 'PENDING_SELL',
                    reason: analysis.details?.mtf?.mode === 'pending'
                        ? `Waiting for ORB retest confirmation (expires in ~${analysis.details.mtf.expiresIn}m)`
                        : 'Pending entry awaiting confirmation',
                    details: {
                        score: analysis.score,
                        analysis: analysis.details,
                        currentHourUTC: hour,
                        isMTF: true
                    }
                };
            }

            return {
                action: 'SKIP',
                reason: 'Outside gold trading session (06:00-20:00 UTC)',
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    currentHourUTC: hour,
                    sessionOpen: isSessionOpen
                }
            };
        }

        // Per-session circuit breaker
        const sessionLabel = this._getSessionLabel(hour);
        if (sessionLabel !== this.lastSessionLabel) {
            this.sessionLossCount = 0;
            this.lastSessionLabel = sessionLabel;
        }
        if (this.sessionLossCount >= this.LOSSES_PER_SESSION) {
            return {
                action: 'SKIP',
                reason: `Session circuit breaker: ${sessionLabel} session limit reached (${this.sessionLossCount}/${this.LOSSES_PER_SESSION})`,
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    sessionLossCount: this.sessionLossCount,
                    sessionLabel,
                }
            };
        }

        const newsFilter = isUsdNewsBlocked(now);

        if (newsFilter.blocked) {
            return {
                action: 'SKIP',
                reason: `News filter blocked trade: ${newsFilter.reason}`,
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    newsFilterPassed: false,
                    newsReason: newsFilter.reason
                }
            };
        }

        // Check if score meets the configured strategy threshold
        const threshold = this.analysisEngine.strategy.CONFLUENCE_THRESHOLD;
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

        // Handle MTF signals
        if (analysis.signal && analysis.signal.startsWith('PENDING_')) {
            return {
                action: analysis.signal === 'PENDING_BUY' ? 'PENDING_BUY' : 'PENDING_SELL',
                reason: analysis.details?.mtf?.mode === 'pending'
                    ? `Waiting for ORB retest confirmation (expires in ~${analysis.details.mtf.expiresIn}m)`
                    : 'Pending entry awaiting confirmation',
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    isMTF: true
                }
            };
        }

        if (analysis.signal === 'EXECUTE_BUY' || analysis.signal === 'EXECUTE_SELL') {
            return {
                action: analysis.signal === 'EXECUTE_BUY' ? 'BUY' : 'SELL',
                reason: 'ORB retest confirmed — executing trade',
                details: {
                    score: analysis.score,
                    analysis: analysis.details,
                    mtf: analysis.details?.mtf,
                    entryPrice: analysis.details?.mtf?.entryPrice,
                    timestamp: new Date().toISOString()
                }
            };
        }

        if (analysis.signal !== 'BUY' && analysis.signal !== 'SELL') {
            const fb = analysis.details?.filterBreakdown;
            const reason = fb?.rejectedReason
                ? `Filter rejected: ${fb.rejectedReason}`
                : 'Confluence passed, but EMA/direction filter did not confirm a trade signal';
            return {
                action: 'SKIP',
                reason,
                details: {
                    score: analysis.score,
                    signal: analysis.signal,
                    filterBreakdown: fb,
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

        if (entryDate === today) {
            const { pnl } = tradeResult;

            if (pnl < 0) {
                this.dailyLossCount++;
                this.sessionLossCount++;
            }

            this.dailyTradeTaken = true;
            this._saveState();

            if (this.dailyLossCount >= this.MAX_DAILY_LOSSES) {
                this.circuitBreakerActive = true;
            }
        }
    }

    _loadState() {
        try {
            if (!this.db) return;

            this.db.get(`SELECT state_json FROM bot_state WHERE key = 'decision_engine'`, [], (err, row) => {
                if (err || !row?.state_json) return;

                const parsed = JSON.parse(row.state_json);
                this.dailyTradeTaken = parsed.dailyTradeTaken || false;
                this.dailyLossCount = parsed.dailyLossCount || 0;
                this.lastTradeDate = parsed.lastTradeDate || null;
                this.circuitBreakerActive = parsed.circuitBreakerActive || false;
                this.sessionLossCount = parsed.sessionLossCount || 0;
                this.lastSessionLabel = parsed.lastSessionLabel || null;
            });
        } catch (error) {
            console.error('Error loading state:', error);
        }
    }

    _saveState() {
        try {
            if (!this.db) return;

            const state = JSON.stringify({
                dailyTradeTaken: this.dailyTradeTaken,
                dailyLossCount: this.dailyLossCount,
                lastTradeDate: this.lastTradeDate,
                circuitBreakerActive: this.circuitBreakerActive,
                sessionLossCount: this.sessionLossCount,
                lastSessionLabel: this.lastSessionLabel,
            });

            this.db.run(
                `INSERT OR REPLACE INTO bot_state (key, state_json, updated_at) VALUES ('decision_engine', ?, ?)`,
                [state, new Date().toISOString()]
            );
        } catch (error) {
            console.error('Error saving state:', error);
        }
    }

    _ensureStateTable() {
        if (!this.db) return;

        this.db.run(`CREATE TABLE IF NOT EXISTS bot_state (
            key TEXT PRIMARY KEY,
            state_json TEXT,
            updated_at DATETIME
        )`);
    }
}

module.exports = DecisionEngine;
