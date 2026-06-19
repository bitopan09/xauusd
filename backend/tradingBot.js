const DecisionEngine = require('./decisionEngine');
const ExecutionEngine = require('./executionEngine');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { isUsdNewsBlocked } = require('./newsFilter');

class TradingBot {
    constructor(db) {
        this.db = db;
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

        this._initializePriceData();
    }

    /**
     * Initialize price data — starts empty, populated by first successful API call
     */
    _initializePriceData() {
        // No seed data — priceData is populated by _analyzeAndTrade() with real Bybit candles
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
     * Fetches 6H candles from Bybit for XAUUSDT and runs confluence scoring.
     * If priceData was pre-populated (e.g. by /api/bot/candles), skip the fetch.
     */
    async _analyzeAndTrade() {
        try {
            const hasRealCandles = this.priceData.length >= 50 && this.priceData[0].open !== undefined;
            const hasFreshCandles = hasRealCandles && this.isCandleDataFresh(this.priceData);

            if (!hasFreshCandles) {
                this.lastServerFetchFail = this.lastServerFetchFail || 0;
                const hoursSinceLastFail = (Date.now() - this.lastServerFetchFail) / 3600000;

                if (hoursSinceLastFail > 6) {
                    let candleData = null;
                    let candleData15m = null;
                    let source = null;

                    try {
                        const bybitUrl = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=360&limit=200';
                        const json = await this._fetchBybitData(bybitUrl);
                        if (json && json.retCode === 0 && json.result?.list?.length) {
                            candleData = json.result.list;
                            source = 'bybit_rest';
                        }
                    } catch { /* try OKX */ }

                    if (!candleData) {
                        const okx = await this._fetchOKXData();
                        if (okx && okx.data?.length) {
                            candleData = okx.data;
                            source = 'okx';
                        }
                    }

                    // Also fetch 15m candles for MTF
                    try {
                        const bybitUrl15m = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=15&limit=200';
                        const json15m = await this._fetchBybitData(bybitUrl15m);
                        if (json15m && json15m.retCode === 0 && json15m.result?.list?.length) {
                            candleData15m = json15m.result.list;
                        }
                    } catch { /* 15m fetch optional */ }

                    if (candleData && source) {
                        this.lastServerFetchFail = 0;
                        this.setPriceData(this._parseCandleList(candleData), source);
                        if (candleData15m) {
                            this.setPriceData15m(this._parseCandleList(candleData15m));
                        }
                        console.log(`Fetched ${candleData.length} 6H + ${candleData15m ? candleData15m.length : 0} 15m candles from ${source}`);

                    } else {
                        this.lastServerFetchFail = Date.now();
                        if (this._first403Logged) {
                            console.warn('Bybit/OKX blocked — waiting for browser candle relay');
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
     * Run backtest using real-time historical gold data from Bybit
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
            let dataSource = 'bybit_live';

            // Anchor end time to start of current UTC day so all runs within
            // the same day fetch the exact same candle window.
            const now = new Date();
            const anchoredEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
            const dateKey = anchoredEnd.toISOString().split('T')[0]; // e.g. "2026-06-08"
            const cacheFile = path.join(__dirname, `xau_backtest_cache_${dateKey}_${backtestInterval}.json`);

            // Priority 1: Use client-provided candles (fetched by user's browser — not IP-blocked)
            if (clientCandles && Array.isArray(clientCandles) && clientCandles.length > 0) {
                console.log(`Using ${clientCandles.length} candles provided by client browser`);
                // Client sends raw Bybit format: [[timestamp, open, high, low, close, volume, turnover], ...]
                // Reverse to chronological (Bybit returns newest-first)
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

            // Priority 3: Fetch from Bybit server-side (works locally, may 403 on Railway)
            if (!historicalData) {
                console.log('Fetching XAU/USD candles from Bybit API...');
                const symbol = 'XAUUSDT';
                const totalLimit = requiredCandles;
                
                let end = anchoredEnd.getTime();
                let allCandles = [];
                let remaining = totalLimit;
                
                while (remaining > 0) {
                    const chunkLimit = Math.min(remaining, 200);
                    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${backtestInterval}&limit=${chunkLimit}&end=${end}`;
                    
                    const json = await this._fetchBybitData(url);
                    if (!json || json.retCode !== 0 || !json.result?.list || json.result.list.length === 0) break;
                    
                    allCandles = allCandles.concat(json.result.list);
                    
                    // Next chunk: go further back in time
                    const lastTimestamp = parseInt(json.result.list[json.result.list.length - 1][0]);
                    end = lastTimestamp;
                    remaining -= chunkLimit;
                    
                    await new Promise(resolve => setTimeout(resolve, 200));
                }

                if (allCandles.length === 0) {
                    throw new Error('Failed to fetch historical data. Bybit may be blocked on this server. Please try again — the browser will fetch the data directly.');
                }
                
                historicalData = allCandles.reverse().map(k => ({
                    timestamp: new Date(parseInt(k[0])),
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5]),
                    price: parseFloat(k[4])
                }));
                
                console.log(`✓ Fetched ${historicalData.length} XAU candles from Bybit`);

                // Cache to file for reproducibility within the same day
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
                    console.log(`✓ Cached data to ${cacheFile}`);
                } catch (writeErr) {
                    console.warn('Could not write cache file:', writeErr.message);
                }
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

                // Fetch 15m from Bybit if not cached
                if (!historicalData15m) {
                    console.log('Fetching 15m candles for MTF backtest...');
                    let end = anchoredEnd.getTime();
                    let all15m = [];
                    let remaining15 = Math.ceil(requiredCandles * 24); // 24× 15m per 6H
                    while (remaining15 > 0) {
                        const chunk = Math.min(remaining15, 200);
                        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=${btInterval15}&limit=${chunk}&end=${end}`;
                        try {
                            const json = await this._fetchBybitData(url);
                            if (!json || json.retCode !== 0 || !json.result?.list?.length) break;
                            all15m = all15m.concat(json.result.list);
                            const lastTs = parseInt(json.result.list[json.result.list.length - 1][0]);
                            end = lastTs;
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
                        console.log(`✓ Fetched ${historicalData15m.length} 15m candles from Bybit`);
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
                    dailyStartEquity = equity;
                }

                // Decrement consecutive loss cool-off each candle
                if (consecutiveLossCooloff > 0) consecutiveLossCooloff--;

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

                    if (entryResult.open) {
                        // Track entry costs
                        totalSpreadCost += entryResult.costs.spread / 2 * 0.01;
                        totalSlippageCost += entryResult.costs.slippage * 0.01;
                        totalCommission += entryResult.costs.commission;

                        // Assign trade ID and create active trade
                        activeTrade = { ...entryResult.trade, id: trades.length + 1 };
                        lastTradeDate = candleDate;
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
                }))
            };

        } catch (error) {
            console.error('XAU backtest error:', error);
            throw error;
        }
    }

    /**
     * Helper to fetch data from Bybit, with automatic fallback across
     * multiple Bybit API mirrors and CORS proxies for blocked cloud IPs (e.g. Railway).
     */
    async _fetchBybitData(url) {
        const bybitDomains = [
            'api.bybit.com',
            'api.bytick.com',
            'api.bybit.nl'
        ];

        const originalDomain = new URL(url).hostname;
        const errors = [];

        for (const domain of bybitDomains) {
            try {
                const domainUrl = url.replace(originalDomain, domain);
                const response = await fetch(domainUrl, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Sec-Fetch-Dest': 'empty',
                        'Sec-Fetch-Mode': 'cors',
                        'Sec-Fetch-Site': 'same-site',
                        'Origin': 'https://www.bybit.com',
                        'Referer': 'https://www.bybit.com/'
                    },
                    timeout: 10000
                });
                if (response.ok) {
                    const json = await response.json();
                    if (json && json.retCode === 0) {
                        return json;
                    }
                }
                errors.push(`${domain}: status ${response.status}`);
            } catch (err) {
                errors.push(`${domain}: ${err.message}`);
            }
        }

        throw new Error(errors.join(' | '));
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


}

module.exports = TradingBot;
