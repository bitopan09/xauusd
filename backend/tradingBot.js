const DecisionEngine = require('./decisionEngine');
const ExecutionEngine = require('./executionEngine');
const DataManager = require('./dataManager');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { isUsdNewsBlocked } = require('./newsFilter');

class TradingBot {
    constructor(db) {
        this.db = db;
        this.dataManager = new DataManager(db);
        this.decisionEngine = new DecisionEngine(this.db, {
            lossesPerSession: Number(process.env.LOSSES_PER_SESSION) || 1,
            maxDailyLosses: Number(process.env.MAX_DAILY_LOSSES) || 2,
            tp1ClosePercent: Number(process.env.TP1_CLOSE_PERCENT) || 50,
            maxSlDistance: Number(process.env.MAX_SL_DISTANCE) || 15,
            confluenceThreshold: Number(process.env.CONFLUENCE_THRESHOLD) || 5.5,
            interval: Number(process.env.BACKTEST_INTERVAL) || 360,
        });
        this.executionEngine = new ExecutionEngine(this.db, {
            tp1ClosePercent: Number(process.env.TP1_CLOSE_PERCENT) || 50,
            maxSlDistance: Number(process.env.MAX_SL_DISTANCE) || 15,
            confluenceThreshold: Number(process.env.CONFLUENCE_THRESHOLD) || 5.5,
            interval: Number(process.env.BACKTEST_INTERVAL) || 360,
        });
        
        // Link Execution Engine exits to Decision Engine tracking
        this.executionEngine.onTradeClosed = (trade) => {
            if (trade.userId === 'default') {
                this.decisionEngine.recordTradeOutcome(trade);
                // Track volatile trade performance for adaptive cool-off (live path)
                if (trade.regime === 'volatile') {
                    if (trade.netPnl < 0) {
                        this.volatileLossStreak++;
                        if (this.volatileLossStreak >= 2) {
                            this.volatileCooloff = Math.min(this.volatileLossStreak * 2, 5);
                        }
                    } else {
                        this.volatileLossStreak = 0;
                    }
                }
            }
        };

        this.isRunning = false;
        this.analysisInterval = null;
        this.priceData = [];
        this.priceData15m = [];
        this.maxCandleAgeMs = (Number(process.env.MAX_CANDLE_AGE_HOURS) || 8) * 60 * 60 * 1000;
        this.lastCandleSource = null;
        this.lastCandleUpdateTime = null;
        this.lastCandleTimestamp = null;
        this.lastCandleTimestamp15m = null;
        this.candleStale = true;
        this.FIXED_QUANTITY = Number(process.env.XAU_QUANTITY) || 0.01; // Configurable via env
        this.MAX_LOSS_PERCENT = Number(process.env.MAX_LOSS_PERCENT) || 10;
        this.MAX_POSITION_LOTS = Number(process.env.MAX_POSITION_LOTS) || 0.1;
        this.volatileLossStreak = 0;
        this.volatileCooloff = 0;
        this.optimizerParams = null; // Loaded from DB on startup

        // ═══════════════════════════════════════════════════════════════
        // ENHANCED RISK MANAGEMENT (v2 upgrades)
        // ═══════════════════════════════════════════════════════════════
        // Intraday loss cap — stops trading after this many consecutive losses
        this.INTRADAY_LOSS_CAP = Number(process.env.INTRADAY_LOSS_CAP) || 3;
        // Consecutive intraday losses counter
        this.intradayLossStreak = 0;

        // Volatility-based position sizing — scale lot size inverse to ATR
        this.VOLATILITY_SCALING = process.env.VOLATILITY_SCALING !== 'false';
        this.ATR_LOOKBACK = Number(process.env.ATR_LOOKBACK) || 14;
        this.BASE_ATR_PERCENT = Number(process.env.BASE_ATR_PERCENT) || 0.5; // ATR as % of price for "normal" vol
        this.MIN_LOT_MULTIPLIER = Number(process.env.MIN_LOT_MULTIPLIER) || 0.5; // Min 50% of base lot
        this.MAX_LOT_MULTIPLIER = Number(process.env.MAX_LOT_MULTIPLIER) || 2.0; // Max 200% of base lot

        // Black swan protection — emergency exit on extreme moves
        this.BLACK_SWAN_SIGMA = Number(process.env.BLACK_SWAN_SIGMA) || 3; // 3σ move triggers protection
        this.BLACK_SWAN_LOOKBACK = Number(process.env.BLACK_SWAN_LOOKBACK) || 20;
        this.blackSwanActive = false;
        this.blackSwanReason = null;

        this._initializePriceData();
        this._loadOptimizerConfig();
    }

    /**
     * Initialize price data — starts empty, populated by first successful API call
     */
    _initializePriceData() {
        // No seed data — priceData is populated by _analyzeAndTrade() with real candles
    }

    /**
     * Load optimized parameters from DB if available.
     * Overrides env var defaults when an optimizer run has been deployed.
     */
    _loadOptimizerConfig() {
        this.db.get(
            `SELECT value, score, profit_factor, max_dd_pct, win_rate, trades 
             FROM optimizer_config WHERE is_active = 1 
             ORDER BY deployed_at DESC LIMIT 1`,
            (err, row) => {
                if (err || !row) {
                    console.log('[Bot] No optimizer config found — using env var defaults');
                    return;
                }
                try {
                    const config = JSON.parse(row.value);
                    this.optimizerParams = config;
                    console.log(`[Bot] Loaded optimizer config: PF=${row.profit_factor?.toFixed(2)} WR=${(row.win_rate*100)?.toFixed(1)}% Score=${row.score?.toFixed(2)}`);
                    console.log(`[Bot] Optimized params:`, config);
                    this._applyOptimizerParams(config);
                } catch (e) {
                    console.warn('[Bot] Failed to parse optimizer config:', e.message);
                }
            }
        );
    }

    /**
     * Apply loaded optimizer params to process.env and live strategy instances.
     * Ensures DecisionEngine and ExecutionEngine use the DB-deployed config.
     */
    _applyOptimizerParams(config) {
        if (!config) return;

        // Patch process.env for any late consumers
        if (config.confluenceThreshold !== undefined) {
            process.env.CONFLUENCE_THRESHOLD = String(config.confluenceThreshold);
        }
        if (config.tp1ClosePercent !== undefined) {
            process.env.TP1_CLOSE_PERCENT = String(config.tp1ClosePercent);
        }
        if (config.maxSlDistance !== undefined) {
            process.env.MAX_SL_DISTANCE = String(config.maxSlDistance);
        }
        if (config.scoreMarginMin !== undefined) {
            process.env.SCORE_MARGIN_MIN = String(config.scoreMarginMin);
        }
        if (config.buyScoreMargin !== undefined) {
            process.env.BUY_SCORE_MARGIN = String(config.buyScoreMargin);
        }
        if (config.emaAlignmentRequired !== undefined) {
            process.env.EMA_ALIGNMENT_REQUIRED = String(config.emaAlignmentRequired);
        }

        const patchStrategy = (strategy) => {
            if (!strategy) return;
            if (config.confluenceThreshold !== undefined) strategy.CONFLUENCE_THRESHOLD = config.confluenceThreshold;
            if (config.tp1ClosePercent !== undefined) strategy.TP1_CLOSE_PERCENT = config.tp1ClosePercent;
            if (config.maxSlDistance !== undefined) strategy.MAX_SL_DISTANCE = config.maxSlDistance;
            if (config.scoreMarginMin !== undefined) strategy.SCORE_MARGIN_MIN = config.scoreMarginMin;
            if (config.buyScoreMargin !== undefined) strategy.BUY_SCORE_MARGIN = config.buyScoreMargin;
            if (config.emaAlignmentRequired !== undefined) strategy.EMA_ALIGNMENT_REQUIRED = config.emaAlignmentRequired;
            if (config.zlemaRequired !== undefined) strategy.ZLEMA_REQUIRED = config.zlemaRequired;
            if (config.zlemaEntryRequired !== undefined) strategy.ZLEMA_ENTRY_REQUIRED = config.zlemaEntryRequired;
        };

        // Patch decision engine strategy
        if (this.decisionEngine?.analysisEngine?.strategy) {
            patchStrategy(this.decisionEngine.analysisEngine.strategy);
        }
        // Patch execution engine strategy
        if (this.executionEngine?.strategy) {
            patchStrategy(this.executionEngine.strategy);
        }

        console.log(`[Bot] Applied optimizer params to live strategy instances`);
    }

    setPriceData(priceData, source = 'unknown') {
        this.priceData = priceData;
        this.lastCandleSource = source;
        this.lastCandleUpdateTime = new Date().toISOString();
        this.lastCandleTimestamp = priceData.length > 0
            ? new Date(priceData[priceData.length - 1].timestamp).toISOString()
            : null;
        this.candleStale = !this.isCandleDataFresh(priceData);
    }

    setPriceData15m(priceData, source = 'unknown') {
        this.priceData15m = priceData;
        this.lastCandleTimestamp15m = priceData.length > 0
            ? new Date(priceData[priceData.length - 1].timestamp).toISOString()
            : null;
    }

    isCandleDataFresh(priceData) {
        if (!priceData || priceData.length === 0) return false;

        const latest = new Date(priceData[priceData.length - 1].timestamp).getTime();
        if (!Number.isFinite(latest)) return false;

        const now = Date.now();
        const maxFutureDriftMs = 5 * 60 * 1000;
        return latest <= now + maxFutureDriftMs && now - latest <= this.maxCandleAgeMs;
    }

    start() {
        if (this.isRunning) {
            console.log('Gold trading bot is already running');
            return;
        }

        console.log('Starting XAU/USD trading bot...');
        this.isRunning = true;

        // Analyze every minute
        this.analysisInterval = setInterval(() => {
            this._analyzeAndTrade();
        }, 60000);

        // Immediately run first analysis
        this._analyzeAndTrade();

        console.log('XAU/USD trading bot started successfully');
    }

    stop() {
        if (!this.isRunning) {
            console.log('Gold trading bot is not running');
            return;
        }

        console.log('Stopping XAU/USD trading bot...');
        this.isRunning = false;

        if (this.analysisInterval) {
            clearInterval(this.analysisInterval);
            this.analysisInterval = null;
        }

        console.log('XAU/USD trading bot stopped');
    }

    /**
     * Main analysis and trading loop
     * Fetches 6H candles from Binance/OKX for XAUUSDT and runs confluence scoring.
     * If priceData was pre-populated (e.g. by /api/bot/candles), skip the fetch.
     */
    async _analyzeAndTrade() {
        try {
            const hasRealCandles = this.priceData.length >= 50 && this.priceData[0].open !== undefined;
            const hasFreshCandles = hasRealCandles && this.isCandleDataFresh(this.priceData);

            if (!hasFreshCandles) {
                this.lastServerFetchFail = this.lastServerFetchFail || 0;
                this.candleConsecutiveFails = this.candleConsecutiveFails || 0;
                const minsSinceLastFail = (Date.now() - this.lastServerFetchFail) / 60000;
                const backoffMins = Math.min(30, 1 * Math.pow(2, this.candleConsecutiveFails));

                if (minsSinceLastFail >= backoffMins) {
                    let candleData = null;
                    let candleData15m = null;
                    let source = null;

                    // Try Binance Futures first (works from cloud servers)
                    try {
                        const json = await this._fetchBinanceKlines('6h', 200);
                        if (json && json.length) {
                            candleData = json;
                            source = 'binance';
                        }
                    } catch { /* try OKX */ }

                    // Fallback to OKX
                    if (!candleData) {
                        const okx = await this._fetchOKXData();
                        if (okx && okx.data?.length) {
                            candleData = okx.data;
                            source = 'okx';
                        }
                    }

                    // Fetch 15m candles for MTF
                    try {
                        const json15m = await this._fetchBinanceKlines('15m', 200);
                        if (json15m && json15m.length) {
                            candleData15m = json15m;
                        }
                    } catch { /* 15m fetch optional */ }

                    if (candleData && source) {
                        this.lastServerFetchFail = 0;
                        this.candleConsecutiveFails = 0;
                        if (source === 'binance') {
                            this.setPriceData(this._parseBinanceKlines(candleData), source);
                            if (candleData15m) {
                                this.setPriceData15m(this._parseBinanceKlines(candleData15m));
                            }
                        } else {
                            this.setPriceData(this._parseCandleList(candleData), source);
                            if (candleData15m) {
                                this.setPriceData15m(this._parseCandleList(candleData15m));
                            }
                        }
                        console.log(`Fetched ${candleData.length} 6H + ${candleData15m ? candleData15m.length : 0} 15m candles from ${source}`);

                    } else {
                        this.lastServerFetchFail = Date.now();
                        this.candleConsecutiveFails = (this.candleConsecutiveFails || 0) + 1;
                        if (this._first403Logged) {
                            console.warn('All candle sources blocked — waiting for browser candle relay');
                        } else {
                            console.error('Cannot fetch XAU candles from server — browser relay will supply them');
                            this._first403Logged = true;
                        }
                        return;
                    }
                }

            }

            if (!this.isCandleDataFresh(this.priceData)) {
                this.candleStale = true;
                this.lastAnalysisTime = new Date().toISOString();
                this.lastScore = 0;
                this.lastSignal = 'NEUTRAL';
                if (this._first403Logged) {
                    console.log('Waiting for browser candle relay...');
                } else {
                    console.warn('No fresh candle data available — waiting for browser relay');
                }
                return;
            }

            // Ensure optimizer config is applied to live strategy instances
            if (this.optimizerParams) {
                this._applyOptimizerParams(this.optimizerParams);
            }

            // Perform analysis and make decision (MTF if 15m data available)
            const has15m = this.priceData15m.length >= 50;
            const decision = has15m
                ? await this.decisionEngine.makeDecisionMTF(this.priceData, this.priceData15m)
                : await this.decisionEngine.makeDecision(this.priceData);
            this.lastAnalysisTime = new Date().toISOString();

            console.log(`[${this.lastAnalysisTime}] XAU Decision: ${decision.action} - ${decision.reason}`);

            // Save current live score for frontend dashboard
            this.lastScore = decision.details ? decision.details.score : 0;
            this.lastSignal = decision.action;
            this.lastFilterBreakdown = decision.details?.filterBreakdown || decision.details?.analysis?.filterBreakdown || null;

            // Handle pending MTF entries (log them, don't execute)
            if (decision.action === 'PENDING_BUY' || decision.action === 'PENDING_SELL') {
                console.log(`[MTF] ${decision.reason}`);
                await this.executionEngine.monitorTrades(this.priceData[this.priceData.length - 1]?.price);
                return;
            }

            // If decision is to trade, execute it
            if (decision.action === 'BUY' || decision.action === 'SELL') {
                // PAPER TRADING MODE — simulate without real execution
                if (process.env.PAPER_TRADING === 'true') {
                    const currentPrice = this.priceData[this.priceData.length - 1].price;
                    console.log(`[PAPER] ${decision.action} signal at $${currentPrice.toFixed(2)} — NOT executing (paper mode)`);
                    console.log(`[PAPER] Would execute: qty=${quantity}, SL=$${decision.action === 'BUY' ? riskParams.stopLoss.long : riskParams.stopLoss.short}`);
                    this.decisionEngine.dailyTradeTaken = true; // Count as trade for rate limiting
                    return;
                }

                const currentPrice = this.priceData[this.priceData.length - 1].price;
                const riskParams = decision.details.analysis.riskCalculator;
                const sl = decision.action === 'BUY' ? riskParams.stopLoss.long : riskParams.stopLoss.short;
                const tp1 = decision.action === 'BUY' ? riskParams.takeProfit.tp1Long : riskParams.takeProfit.tp1Short;
                const tp2 = decision.action === 'BUY' ? riskParams.takeProfit.tp2Long : riskParams.takeProfit.tp2Short;

                // Risk-based position sizing (targets MAX_LOSS_PERCENT of equity per trade)
                const slDistance = Math.abs(currentPrice - sl);
                const balanceRow = await new Promise((res) => {
                    this.db.get("SELECT usd_balance FROM balance WHERE userId = 'default' ORDER BY timestamp DESC LIMIT 1", (err, row) => res(row));
                });
                const currentEquity = balanceRow && balanceRow.usd_balance ? balanceRow.usd_balance : 50;
                const regimeName = riskParams?.regime || 'ranging';

                // Pre-trade equity safety: skip volatile trades when equity is too low
                // to survive the per-trade loss at 0.01 minimum lots.
                const minLotRisk = 0.01 * slDistance * 100;
                const riskEqRatio = minLotRisk / currentEquity;
                if (riskEqRatio > 0.35) {
                    console.log(`[SAFETY SKIP] minLot risk $${minLotRisk.toFixed(2)}=${(riskEqRatio*100).toFixed(0)}% equity (cap 35%) | eq=$${currentEquity} regime=${regimeName} slDist=${slDistance}`);
                    return;
                }
                // Block volatile regime trades when cool-off is active (consecutive volatile losses)
                if (regimeName === 'volatile' && this.volatileCooloff > 0) {
                    console.log(`[SAFETY SKIP] volatile cool-off (${this.volatileCooloff} bars) — volatility=${this.volatileLossStreak} consecutive losses`);
                    return;
                }

                const riskAmount = Math.max(1, currentEquity * (this.MAX_LOSS_PERCENT / 100));
                const CONTRACT_SIZE = 100;
                const quantity = slDistance > 0
                    ? Math.max(0.01, Math.min(this.MAX_POSITION_LOTS, Math.round((riskAmount / (slDistance * CONTRACT_SIZE)) * 100) / 100))
                    : this.FIXED_QUANTITY;

                const signal = {
                    action: decision.action,
                    price: currentPrice,
                    quantity: quantity,
                    sl: sl,
                    originalSl: sl,
                    tp1: tp1,
                    tp2: tp2,
                    atr: riskParams.atr, // Pass ATR so ExecutionEngine uses correct trailing stop thresholds
                    score: decision.details.score,
                    regime: regimeName,
                    notes: decision.details.analysis.confluenceScorer?.details || ''
                };

                const result = await this.executionEngine.executeTrade(signal);

                if (result.success) {
                    console.log(`Gold trade executed: ${result.message}`);
                    this.decisionEngine.dailyTradeTaken = true;
                } else {
                    console.log(`Gold trade execution failed: ${result.reason}`);
                }
            }

            // Monitor active trades for SL/TP hits using real OHLC candle data
            const latestCandle = this.priceData[this.priceData.length - 1];
            this.db.get('SELECT price FROM prices ORDER BY timestamp DESC LIMIT 1', (err, row) => {
                const currentPrice = row ? row.price : (latestCandle ? latestCandle.price : null);
                if (currentPrice) {
                    this.executionEngine.monitorTrades(currentPrice, latestCandle);
                }
            });
            
        } catch (error) {
            console.error('Error in XAU trading loop:', error);
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            priceDataPoints: this.priceData.length,
            activeTrades: this.executionEngine.activeTrades.size,
            lastAnalysisTime: this.lastAnalysisTime,
            currentScore: this.lastScore || 0,
            currentSignal: this.lastSignal || 'NEUTRAL',
            dailyTradeTaken: this.decisionEngine.dailyTradeTaken,
            dailyLossCount: this.decisionEngine.dailyLossCount,
            circuitBreakerActive: this.decisionEngine.circuitBreakerActive,
            candleSource: this.lastCandleSource,
            lastCandleUpdateTime: this.lastCandleUpdateTime,
            lastCandleTimestamp: this.lastCandleTimestamp,
            candleStale: this.candleStale,
            filterBreakdown: this.lastFilterBreakdown
        };
    }

    async getRecentTrades(limit = 10) {
        return await this.executionEngine.getTrades(limit);
    }

    /**
     * Run backtest using real-time historical gold data
     * @param {number} days - Lookback period
     * @param {string} strategy - Strategy name
     * @param {Array|null} clientCandles - Raw candle arrays from frontend (bypasses server-side fetch)
     */
    async runBacktest(days = 90, strategy = 'default', clientCandles = null, interval = null, startingCapital = 50) {
        const backtestDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 90;
        const backtestInterval = interval || '360';
        const intervalMin = parseInt(backtestInterval);
        const candlesPerDay = intervalMin >= 360 ? 4 : Math.floor(24 * 60 / intervalMin);
        const warmupCandles = intervalMin <= 30 ? 256 : 150;
        const requiredCandles = Math.ceil(backtestDays * candlesPerDay) + warmupCandles;

        console.log(`Starting XAU/USD backtest for ${backtestDays} days...`);
        
        try {
            let historicalData = null;
            let dataSource = 'binance';

            // Anchor end time to start of current UTC day so all runs within
            // the same day fetch the exact same candle window.
            const now = new Date();
            const anchoredEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
            const dateKey = anchoredEnd.toISOString().split('T')[0]; // e.g. "2026-06-08"
            const cacheFile = path.join(__dirname, `xau_backtest_cache_${dateKey}_${backtestInterval}.json`);

            // Priority 1: Use client-provided candles (fetched by user's browser — not IP-blocked)
            if (clientCandles && Array.isArray(clientCandles) && clientCandles.length > 0) {
                console.log(`Using ${clientCandles.length} candles provided by client browser`);
                // Client sends raw candle format: [[timestamp, open, high, low, close, volume, turnover], ...]
                // Reverse to chronological
                const sorted = [...clientCandles].sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
                historicalData = sorted.map(k => ({
                    timestamp: new Date(parseInt(k[0])),
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5]),
                    price: parseFloat(k[4])
                }));
                dataSource = 'client_browser';
                console.log(`✓ Parsed ${historicalData.length} client candles`);

                // Cache client data for subsequent server-side runs
                try {
                    const files = fs.readdirSync(__dirname).filter(f => f.startsWith('xau_backtest_cache_') && f.endsWith('.json'));
                    files.forEach(f => {
                        if (!f.includes(dateKey) || !f.includes(backtestInterval)) {
                            try { fs.unlinkSync(path.join(__dirname, f)); } catch (e) {}
                        }
                    });
                    fs.writeFileSync(cacheFile, JSON.stringify(historicalData.map(d => ({
                        ...d,
                        timestamp: d.timestamp.toISOString()
                    }))));
                    console.log(`✓ Cached client data to ${cacheFile}`);
                } catch (writeErr) {
                    console.warn('Could not write cache file:', writeErr.message);
                }
            }

            // Priority 2: Try to load from today's cache
            if (!historicalData && fs.existsSync(cacheFile)) {
                try {
                    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                    if (cached && cached.length > 0) {
                        historicalData = cached.map(k => ({
                            ...k,
                            timestamp: new Date(k.timestamp)
                        }));
                        dataSource = 'cache';
                        console.log(`✓ Loaded ${historicalData.length} cached XAU candles for ${dateKey}`);
                    }
                } catch (cacheErr) {
                    console.warn('Cache read failed, will fetch fresh:', cacheErr.message);
                }
            }

            // Use DataManager for multi-source fetching (Binance → OKX → cache)
            if (!historicalData) {
                console.log('Fetching XAU/USD candles via DataManager (Binance → OKX → cache)...');
                historicalData = await this.dataManager.getHistoricalData(requiredCandles, backtestInterval, anchoredEnd.getTime(), clientCandles);

                if (historicalData && historicalData.length > 0) {
                    dataSource = historicalData[0]?.source || 'datamanager';
                    console.log(`✓ DataManager returned ${historicalData.length} candles (source: ${dataSource})`);

                    // Validate data quality
                    const validation = this.dataManager.validateData(historicalData);
                    if (!validation.valid) {
                        console.warn(`[DataManager] Quality issues detected: ${validation.issues.join('; ')}`);
                    } else {
                        console.log(`[DataManager] Data quality OK: ${validation.count} candles, ${validation.firstDate} → ${validation.lastDate}`);
                    }
                } else {
                    console.error('DataManager returned no data — all sources failed');
                }
            }

            if (!historicalData || historicalData.length === 0) {
                throw new Error('Failed to fetch historical data from all sources (Binance, OKX, cache).');
            }

            if (historicalData.length > requiredCandles) {
                historicalData = historicalData.slice(-requiredCandles);
            }

            // Build hash
            const firstTs = historicalData[0].timestamp.toISOString();
            const lastTs = historicalData[historicalData.length - 1].timestamp.toISOString();
            const dataHash = `${firstTs.slice(0,10)}_${lastTs.slice(0,10)}_${historicalData.length}`;

            // ── MTF: 15m data only when running 6H primary ─────────────────
            let historicalData15m = null;
            const _15mBy6h = new Map();
            if (backtestInterval === '360') {
                const btInterval15 = '15';
                const cacheFile15 = path.join(__dirname, `xau_backtest_cache_${dateKey}_${btInterval15}.json`);

                // Try cached 15m data first
                if (fs.existsSync(cacheFile15)) {
                    try {
                        const cached = JSON.parse(fs.readFileSync(cacheFile15, 'utf8'));
                        if (cached && cached.length > 0) {
                            historicalData15m = cached.map(k => ({ ...k, timestamp: new Date(k.timestamp) }));
                            console.log(`✓ Loaded ${historicalData15m.length} cached 15m candles`);
                        }
                    } catch (e) { console.warn('15m cache read failed:', e.message); }
                }

                // Fetch 15m from Binance if not cached
                if (!historicalData15m) {
                    console.log('Fetching 15m candles for MTF backtest...');
                    let end = anchoredEnd.getTime();
                    let all15m = [];
                    let remaining15 = Math.ceil(requiredCandles * 24); // 24× 15m per 6H
                    while (remaining15 > 0) {
                        const chunk = Math.min(remaining15, 200);
                        try {
                            const url = `https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=15m&limit=${chunk}&endTime=${end}`;
                            const response = await fetch(url, {
                                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                                timeout: 15000
                            });
                            if (!response.ok) throw new Error(`Binance 15m: ${response.status}`);
                            const data = await response.json();
                            if (!Array.isArray(data) || data.length === 0) break;
                            all15m = all15m.concat(data);
                            end = parseInt(data[data.length - 1][0]);
                            remaining15 -= chunk;
                            await new Promise(resolve => setTimeout(resolve, 200));
                        } catch { break; }
                    }
                    if (all15m.length > 0) {
                        historicalData15m = all15m.reverse().map(k => ({
                            timestamp: new Date(parseInt(k[0])),
                            open: parseFloat(k[1]), high: parseFloat(k[2]),
                            low: parseFloat(k[3]), close: parseFloat(k[4]),
                            volume: parseFloat(k[5] || 0), price: parseFloat(k[4])
                        }));
                        console.log(`✓ Fetched ${historicalData15m.length} 15m candles from Binance`);
                        try { fs.writeFileSync(cacheFile15, JSON.stringify(historicalData15m.map(d => ({ ...d, timestamp: d.timestamp.toISOString() })))); } catch (e) {}
                    }
                }

                // Group 15m candles by 6H window
                if (historicalData15m) {
                    for (let i6 = 0; i6 < historicalData.length; i6++) {
                        const c6 = historicalData[i6];
                        const start6 = c6.timestamp.getTime();
                        const end6 = start6 + 6 * 3600000;
                        const sub15 = historicalData15m.filter(c15 =>
                            c15.timestamp.getTime() >= start6 && c15.timestamp.getTime() < end6
                        );
                        if (sub15.length > 0) _15mBy6h.set(i6, sub15);
                    }
                    console.log(`✓ Grouped 15m data into ${_15mBy6h.size} 6H windows`);
                }
            }

            // Initialize simulation — unified TradeEngine
            const UnifiedStrategy = require('./unifiedStrategyV3');
            const BrokerSimulation = require('./brokerSimulation');
            const TradeEngine = require('./tradeEngine');

            const uStrategy = new UnifiedStrategy({
                tp1RR: Number(process.env.TP1_RR) || undefined,
                tp2RR: Number(process.env.TP2_RR) || undefined,
                confluenceThreshold: Number(process.env.CONFLUENCE_THRESHOLD) || undefined,
                tp1ClosePercent: Number(process.env.TP1_CLOSE_PERCENT) || undefined,
                maxSlDistance: Number(process.env.MAX_SL_DISTANCE) || undefined,
                scoreMarginMin: Number(process.env.SCORE_MARGIN_MIN) || undefined,
                buyScoreMargin: Number(process.env.BUY_SCORE_MARGIN) || undefined,
                emaAlignmentRequired: process.env.EMA_ALIGNMENT_REQUIRED === 'true' || undefined,
                zlemaRequired: process.env.ZLEMA_REQUIRED === 'true' || undefined,
                zlemaEntryRequired: process.env.ZLEMA_ENTRY_REQUIRED !== 'false',
                zlemaLength: Number(process.env.ZLEMA_LENGTH) || undefined,
                zlemaMult: Number(process.env.ZLEMA_MULT) || undefined,
                interval: backtestInterval || 360,
            });
            const broker = new BrokerSimulation();
            const tradeEngine = new TradeEngine({ strategy: uStrategy, broker, config: {
                sessionStartMin: 6 * 60,   // 06:00 UTC
                sessionEndMin: 20 * 60,    // 20:00 UTC
                maxPositionLots: this.MAX_POSITION_LOTS,
                fixedQuantity: this.FIXED_QUANTITY,
            }});

            const trades = [];
            let equity = startingCapital;
            const initialEquity = startingCapital;
            const equityCurve = [];
            let activeTrade = null;
            let currentTradeDate = null;
            let dailyLossCount = 0;
            let dailyStartEquity = equity;
            let lastTradeDate = null;
            let consecutiveLosses = 0;
            let consecutiveLossCooloff = 0;
            let volatileLossStreak = 0;
            let volatileCooloff = 0;
            let dailyTradeCount = 0;

            // Track regime distribution
            const regimeCounts = { trending: 0, volatile: 0, ranging: 0, unknown: 0 };

            // Track realistic costs
            let totalSpreadCost = 0;
            let totalSlippageCost = 0;
            let totalCommission = 0;

            // Loop through data using TradeEngine (unified entry/exit/risk logic)
            for (let i = 50; i < historicalData.length; i++) {
                const currentWindow = historicalData.slice(i - 49, i + 1);
                const currentCandle = historicalData[i];

                // Daily reset
                const candleDate = currentCandle.timestamp.toISOString().split('T')[0];
                if (currentTradeDate !== candleDate) {
                    currentTradeDate = candleDate;
                    dailyLossCount = 0;
                    dailyTradeCount = 0;
                    dailyStartEquity = equity;
                }

                // Decrement consecutive loss cool-off each candle
                if (consecutiveLossCooloff > 0) consecutiveLossCooloff--;
                if (volatileCooloff > 0) volatileCooloff--;

                // ── EXIT: Check active trade (shared trailing stop) ──
                if (activeTrade) {
                    const exitResult = tradeEngine.evaluateExit(activeTrade, currentCandle);
                    if (exitResult.closed) {
                        equity += exitResult.pnl;
                        if (exitResult.pnl < 0) {
                            dailyLossCount++;
                            consecutiveLosses++;
                            if (consecutiveLosses >= 2) {
                                consecutiveLossCooloff = Math.min(consecutiveLosses * tradeEngine.COOLOFF_MULTIPLIER, tradeEngine.MAX_COOLOFF);
                            }
                        } else {
                            consecutiveLosses = 0;
                        }
                        // Track volatile trade performance for adaptive cool-off
                        if (activeTrade?.regime === 'volatile' && exitResult.pnl < 0) {
                            volatileLossStreak++;
                            if (volatileLossStreak >= 2) {
                                volatileCooloff = Math.min(volatileLossStreak * 2, 5);
                            }
                        } else if (activeTrade?.regime === 'volatile' && exitResult.pnl > 0) {
                            volatileLossStreak = 0;
                        }
                        // Track exit costs (slippage baked into exitResult by checkTradeExit)
                        const exitSlippage = broker.calculateSlippage({
                            side: activeTrade.action === 'BUY' ? 'SELL' : 'BUY',
                            candle: currentCandle,
                            atr: activeTrade.atr,
                            quantity: activeTrade.remainingQuantity ?? activeTrade.quantity,
                        });
                        totalSlippageCost += exitSlippage * 0.01;
                        const commission = broker.commissionPerLot * activeTrade.quantity;
                        totalCommission += commission;

                        activeTrade.pnl = exitResult.pnl;
                        activeTrade.exitTimestamp = currentCandle.timestamp;
                        activeTrade.exitReason = exitResult.exitReason;
                        activeTrade.exitPrice = exitResult.exitPrice;
                        activeTrade.status = 'CLOSED';
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    }
                }

                // ── ENTRY: Evaluate new trade (unified 10-step evaluation) ──
                if (!activeTrade) {
                    const sub15 = _15mBy6h.get(i);
                    const entryResult = tradeEngine.evaluateEntry({
                        currentCandle,
                        currentWindow,
                        historicalData,
                        index: i,
                        equity,
                        consecutiveLossCooloff,
                        dailyLossCount,
                        sub15mData: sub15 || null,
                        useMTF: !!(sub15 && sub15.length >= 4),
                    });

                    // Track regime classification for ALL evaluated candles
                    const regimeName = entryResult.analysis?.details?.regime?.regime || 'unknown';
                    regimeCounts[regimeName] = (regimeCounts[regimeName] || 0) + 1;

                    // Guard: volatile cool-off after consecutive volatile losses
                    if (entryResult.open && regimeName === 'volatile' && volatileCooloff > 0) {
                        entryResult.open = false;
                        console.log(`  ⏳ [candle ${i}] VOLATILE COOLOFF (${volatileCooloff} bars) — blocking`);
                    }
                    // Guard: max 3 trades per day
                    if (entryResult.open && dailyTradeCount >= 3) {
                        entryResult.open = false;
                        console.log(`  ⏳ [candle ${i}] DAILY CAP (${dailyTradeCount}/3) — blocking`);
                    }

                    if (entryResult.open) {
                        // Track entry costs
                        totalSpreadCost += entryResult.costs.spread / 2 * 0.01;
                        totalSlippageCost += entryResult.costs.slippage * 0.01;
                        totalCommission += entryResult.costs.commission;

                        // Assign trade ID and create active trade
                        activeTrade = { ...entryResult.trade, id: trades.length + 1 };
                        lastTradeDate = candleDate;
                        dailyTradeCount++;
                    }
                }

                // Mark to market for equity curve
                const markedEquity = activeTrade
                    ? equity + tradeEngine.calculateTradePnl(activeTrade, currentCandle.close)
                    : equity;
                equityCurve.push({ day: equityCurve.length + 1, equity: markedEquity });
            }

            // Force-close any remaining open trade at backtest end
            if (activeTrade) {
                const finalCandle = historicalData[historicalData.length - 1];
                const pnl = tradeEngine.calculateTradePnl(activeTrade, finalCandle.close);
                equity += pnl;
                activeTrade.pnl = pnl;
                activeTrade.exitTimestamp = finalCandle.timestamp;
                activeTrade.exitReason = 'Backtest End';
                activeTrade.exitPrice = finalCandle.close;
                activeTrade.status = 'CLOSED';
                trades.push({ ...activeTrade });
                activeTrade = null;
                equityCurve.push({ day: equityCurve.length + 1, equity });
            }

            // Calculate final metrics
            const completedTrades = trades.filter(t => t.status === 'CLOSED');
            const wins = completedTrades.filter(t => t.pnl > 0);
            const winRate = completedTrades.length > 0 ? wins.length / completedTrades.length : 0;
            const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
            const losses = completedTrades.filter(t => t.pnl <= 0);
            const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
            const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 5 : 0;
            
            let maxEquity = initialEquity, maxDD = 0;
            equityCurve.forEach(p => {
                if (p.equity > maxEquity) maxEquity = p.equity;
                const dd = (maxEquity - p.equity) / maxEquity;
                if (dd > maxDD) maxDD = dd;
            });

            // Compute real Sharpe Ratio from equity curve returns
            let sharpeRatio = 0;
            if (equityCurve.length > 2) {
                const returns = [];
                for (let i = 1; i < equityCurve.length; i++) {
                    if (equityCurve[i - 1].equity !== 0) {
                        returns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
                    }
                }
                if (returns.length > 1) {
                    const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
                    const variance = returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1);
                    const stdDev = Math.sqrt(variance);
                    // Annualize per-candle mark-to-market equity samples.
                    const annualizationFactor = Math.sqrt((equityCurve.length / Math.max(backtestDays, 1)) * 365);
                    sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * annualizationFactor : 0;
                }
            }

            return {
                totalTrades: completedTrades.length,
                winRate,
                profitFactor: Math.min(profitFactor, 10),
                maxDrawdown: maxDD,
                sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
                totalReturn: (equity - initialEquity) / initialEquity,
                equityCurve,
                costs: {
                    totalSpreadCost: parseFloat(totalSpreadCost.toFixed(2)),
                    totalSlippageCost: parseFloat(totalSlippageCost.toFixed(2)),
                    totalCommission: parseFloat(totalCommission.toFixed(2)),
                    totalCosts: parseFloat((totalSpreadCost + totalSlippageCost + totalCommission).toFixed(2)),
                },
                dataInfo: {
                    hash: dataHash,
                    source: dataSource,
                    candleCount: historicalData.length,
                    dateRange: `${firstTs.slice(0,10)} to ${lastTs.slice(0,10)}`,
                    anchoredTo: dateKey,
                    requestedDays: backtestDays,
                    brokerModel: 'OctaFX Standard (40pt spread, 41pt slippage, $0 commission)'
                },
                regimeCounts,
                trades: completedTrades.map(t => ({
                    id: t.id,
                    entryTimestamp: t.timestamp.toISOString(),
                    exitTimestamp: t.exitTimestamp ? t.exitTimestamp.toISOString() : null,
                    action: t.action, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
                    quantity: t.quantity, pnl: t.pnl,
                    sl: t.originalSl || t.sl,
                    originalSl: t.originalSl,
                    exitSl: t.sl,
                    tp1: t.tp1, tp2: t.tp2, remainingQuantity: t.remainingQuantity,
                    realizedPnl: t.realizedPnl, tp1Hit: t.tp1Hit, score: t.score, confluence: t.confluence,
                    exitReason: t.exitReason, regime: t.regime
                })),
                // Raw price data for optimizer reuse
                rawPriceData: historicalData,
            };

        } catch (error) {
            console.error('XAU backtest error:', error);
            throw error;
        }
    }

    /**
     * Fetch XAUUSDT klines from Binance Futures API.
     * Binance does not block cloud server IPs like Bybit does.
     */
    async _fetchBinanceKlines(interval, limit) {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${interval}&limit=${limit}`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });
        if (!response.ok) throw new Error(`Binance: status ${response.status}`);
        const json = await response.json();
        if (!Array.isArray(json) || json.length === 0) throw new Error('Binance: empty response');
        return json;
    }

    /**
     * Parse Binance Futures kline format into our standard candle format.
     * Binance format: [openTime, open, high, low, close, volume, closeTime, ...]
     */
    _parseBinanceKlines(klines) {
        return klines.map(k => ({
            timestamp: new Date(parseInt(k[0])),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5] || 0),
            price: parseFloat(k[4])
        }));
    }

    async _fetchOKXData() {
        const url = 'https://www.okx.com/api/v5/market/candles?instId=XAU-USDT-SWAP&bar=6H&limit=200';
        try {
            const response = await fetch(url, {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                },
                timeout: 15000
            });
            if (!response.ok) return null;
            const json = await response.json();
            if (json.code !== '0' || !json.data || json.data.length === 0) return null;
            return json;
        } catch {
            return null;
        }
    }



    _parseCandleList(list) {
        return list.reverse().map(k => ({
            timestamp: new Date(parseInt(k[0])),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5] || 0),
            price: parseFloat(k[4])
        }));
    }

    // ═══════════════════════════════════════════════════════════════
    // ENHANCED RISK MANAGEMENT METHODS (v2)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Calculate volatility-based lot multiplier
     * @param {Array} priceData - Recent price data for ATR calculation
     * @returns {number} Lot multiplier (0.5 - 2.0)
     */
    getVolatilityMultiplier(priceData) {
        if (!this.VOLATILITY_SCALING || !priceData || priceData.length < this.ATR_LOOKBACK + 1) {
            return 1.0;
        }
        try {
            // Calculate ATR
            const closes = priceData.map(p => p.close || p.price);
            const atr = this._calculateATR(closes, this.ATR_LOOKBACK);
            const currentPrice = closes[closes.length - 1];
            const atrPercent = (atr / currentPrice) * 100;

            // Lower volatility = larger lot (inverse)
            // If ATR% is 0.5% (base), multiplier = 1.0
            // If ATR% is 1.0% (high), multiplier = 0.5
            // If ATR% is 0.25% (low), multiplier = 2.0
            const ratio = this.BASE_ATR_PERCENT / atrPercent;
            let multiplier = Math.max(this.MIN_LOT_MULTIPLIER, Math.min(this.MAX_LOT_MULTIPLIER, ratio));

            console.log(`[Risk] ATR: ${atr.toFixed(2)} (${atrPercent.toFixed(3)}%) → Lot multiplier: ${multiplier.toFixed(2)}`);
            return multiplier;
        } catch (e) {
            console.warn('[Risk] Volatility calculation failed:', e.message);
            return 1.0;
        }
    }

    /**
     * Calculate ATR for a series of closing prices
     */
    _calculateATR(closes, period = 14) {
        if (!closes || closes.length < period + 1) return 0;
        const trs = [];
        for (let i = 1; i < closes.length; i++) {
            const tr = Math.abs(closes[i] - closes[i - 1]);
            trs.push(tr);
        }
        if (trs.length < period) return 0;
        const recentTRs = trs.slice(-period);
        return recentTRs.reduce((a, b) => a + b, 0) / period;
    }

    /**
     * Check for black swan conditions — extreme moves that warrant skipping trades
     * @param {Array} priceData - Recent price data
     * @param {number} currentPrice - Current price
     * @returns {Object} { isBlackSwan: boolean, reason: string|null }
     */
    checkBlackSwan(priceData, currentPrice) {
        if (!priceData || priceData.length < this.BLACK_SWAN_LOOKBACK + 1) {
            return { isBlackSwan: false, reason: null };
        }

        try {
            const closes = priceData.slice(-this.BLACK_SWAN_LOOKBACK).map(p => p.close || p.price);
            const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
            const variance = closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / closes.length;
            const stdDev = Math.sqrt(variance);

            if (stdDev === 0) return { isBlackSwan: false, reason: null };

            const zScore = Math.abs((currentPrice - mean) / stdDev);

            if (zScore > this.BLACK_SWAN_SIGMA) {
                const direction = currentPrice > mean ? 'SPIKE_UP' : 'SPIKE_DOWN';
                const reason = `Black swan detected: ${zScore.toFixed(1)}σ move (${direction})`;
                console.warn(`[Risk] ⚠️ ${reason}`);
                return { isBlackSwan: true, reason };
            }

            return { isBlackSwan: false, reason: null };
        } catch (e) {
            return { isBlackSwan: false, reason: null };
        }
    }

    /**
     * Update intraday loss streak — call after each losing trade
     */
    recordIntradayLoss() {
        this.intradayLossStreak++;
        console.log(`[Risk] Intraday loss #${this.intradayLossStreak} (cap: ${this.INTRADAY_LOSS_CAP})`);

        if (this.intradayLossStreak >= this.INTRADAY_LOSS_CAP) {
            console.warn(`[Risk] 🚫 INTRADAY LOSS CAP REACHED — Stopping trading for today`);
        }
    }

    /**
     * Reset intraday loss streak — call after each winning trade
     */
    recordIntradayWin() {
        if (this.intradayLossStreak > 0) {
            console.log(`[Risk] Intraday win — resetting loss streak from ${this.intradayLossStreak} to 0`);
            this.intradayLossStreak = 0;
        }
    }

    /**
     * Check if trading should be allowed based on all risk rules
     */
    canTrade() {
        // Intraday loss cap check
        if (this.intradayLossStreak >= this.INTRADAY_LOSS_CAP) {
            return { allowed: false, reason: `Intraday loss cap reached (${this.intradayLossStreak}/${this.INTRADAY_LOSS_CAP})` };
        }

        // Black swan check
        if (this.blackSwanActive) {
            return { allowed: false, reason: `Black swan active: ${this.blackSwanReason}` };
        }

        return { allowed: true, reason: null };
    }


}

module.exports = TradingBot;
