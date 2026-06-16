const DecisionEngine = require('./decisionEngine');
const ExecutionEngine = require('./executionEngine');
const emailService = require('./emailService');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { isUsdNewsBlocked } = require('./newsFilter');

class TradingBot {
    constructor(db) {
        this.db = db;
        this.decisionEngine = new DecisionEngine(this.db);
        this.executionEngine = new ExecutionEngine(this.db);
        
        // Link Execution Engine exits to Decision Engine tracking
        this.executionEngine.onTradeClosed = (trade) => {
            if (trade.userId === 'default') {
                this.decisionEngine.recordTradeOutcome(trade);
            }
        };

        this.isRunning = false;
        this.analysisInterval = null;
        this.priceData = [];
        this.maxCandleAgeMs = (Number(process.env.MAX_CANDLE_AGE_HOURS) || 8) * 60 * 60 * 1000;
        this.lastCandleSource = null;
        this.lastCandleUpdateTime = null;
        this.lastCandleTimestamp = null;
        this.candleStale = true;
        this.FIXED_QUANTITY = Number(process.env.XAU_QUANTITY) || 0.01; // Configurable via env
        this.MAX_LOSS_PERCENT = Number(process.env.MAX_LOSS_PERCENT) || 5;

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
                    let source = null;

                    try {
                        const json = await this._fetchBybitData(url);
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

                    if (candleData && source) {
                        this.lastServerFetchFail = 0;
                        this.setPriceData(this._parseCandleList(candleData), source);
                        console.log(`Fetched ${candleData.length} candles from ${source}`);
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

            // Perform analysis and make decision
            const decision = await this.decisionEngine.makeDecision(this.priceData);
            this.lastAnalysisTime = new Date().toISOString();

            console.log(`[${this.lastAnalysisTime}] XAU Decision: ${decision.action} - ${decision.reason}`);

            // Save current live score for frontend dashboard
            this.lastScore = decision.details ? decision.details.score : 0;
            this.lastSignal = decision.action;

            // If decision is to trade, execute it
            if (decision.action === 'BUY' || decision.action === 'SELL') {
                const currentPrice = this.priceData[this.priceData.length - 1].price;
                const riskParams = decision.details.analysis.riskCalculator;
                const sl = decision.action === 'BUY' ? riskParams.stopLoss.long : riskParams.stopLoss.short;
                const tp1 = decision.action === 'BUY' ? riskParams.takeProfit.tp1Long : riskParams.takeProfit.tp1Short;
                const tp2 = decision.action === 'BUY' ? riskParams.takeProfit.tp2Long : riskParams.takeProfit.tp2Short;

                // Fixed lot size — always 0.01
                const quantity = this.FIXED_QUANTITY;

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
                    if (process.env.SEND_EMAIL_ON_TRADE === 'true') {
                        emailService.sendTradeNotification(result.trade, `AUTO ${result.trade.action}`);
                    }
                } else {
                    console.log(`Gold trade execution failed: ${result.reason}`);
                }
            }

            // Monitor active trades for SL/TP hits using the latest real-time tick price
            this.db.get('SELECT price FROM prices ORDER BY timestamp DESC LIMIT 1', (err, row) => {
                if (!err && row) {
                    this.executionEngine.monitorTrades(row.price);
                } else {
                    this.executionEngine.monitorTrades(this.priceData[this.priceData.length - 1].price);
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
            candleStale: this.candleStale
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
    async runBacktest(days = 90, strategy = 'default', clientCandles = null) {
        const backtestDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 90;
        const candlesPerDay = 4; // 6H candles
        const warmupCandles = 50;
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
            const cacheFile = path.join(__dirname, `xau_backtest_cache_${dateKey}.json`);

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
                        if (!f.includes(dateKey)) {
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
                const interval = '360'; // 6h candles
                const totalLimit = requiredCandles;
                
                let end = anchoredEnd.getTime();
                let allCandles = [];
                let remaining = totalLimit;
                
                while (remaining > 0) {
                    const chunkLimit = Math.min(remaining, 200);
                    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${chunkLimit}&end=${end}`;
                    
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
                        if (!f.includes(dateKey)) {
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

            // Build data hash for verification (first candle ts + last candle ts + count)
            const firstTs = historicalData[0].timestamp.toISOString();
            const lastTs = historicalData[historicalData.length - 1].timestamp.toISOString();
            const dataHash = `${firstTs.slice(0,10)}_${lastTs.slice(0,10)}_${historicalData.length}`;

            // Initialize simulation
            const trades = [];
            let equity = 50;
            const initialEquity = 50;
            const equityCurve = [];
            let activeTrade = null;
            let currentTradeDate = null;
            let dailyLossCount = 0;
            let lastTradeDate = null;
            
            const UnifiedStrategy = require('./unifiedStrategy');
            const uStrategy = new UnifiedStrategy();

            const calculateTradePnl = (trade, exitPrice) => {
                const CONTRACT_SIZE = 100;
                const remainingQuantity = trade.remainingQuantity ?? trade.remaining_quantity ?? trade.quantity;
                const realizedPnl = trade.realizedPnl ?? trade.realized_pnl ?? 0;
                const positionSize = remainingQuantity * CONTRACT_SIZE;
                const unrealizedPnl = trade.action === 'BUY'
                    ? (exitPrice - trade.entryPrice) * positionSize
                    : (trade.entryPrice - exitPrice) * positionSize;
                return realizedPnl + unrealizedPnl;
            };
            
            // Loop through data using UnifiedStrategy
            for (let i = 50; i < historicalData.length; i++) {
                const currentWindow = historicalData.slice(i - 50, i);
                const currentCandle = historicalData[i];

                const candleDate = currentCandle.timestamp.toISOString().split('T')[0];
                if (currentTradeDate !== candleDate) {
                    currentTradeDate = candleDate;
                    dailyLossCount = 0;
                }

                // Check active trade exit
                if (activeTrade) {
                    const exitResult = uStrategy.checkTradeExit(activeTrade, currentCandle);
                    if (exitResult.closed) {
                        equity += exitResult.pnl;
                        // No equity floor — let backtest reflect real losses accurately
                        if (exitResult.pnl < 0) {
                            dailyLossCount++;
                        }
                        
                        activeTrade.pnl = exitResult.pnl;
                        activeTrade.exitTimestamp = currentCandle.timestamp;
                        activeTrade.exitReason = exitResult.exitReason;
                        activeTrade.exitPrice = exitResult.exitPrice;
                        activeTrade.status = 'CLOSED';
                        trades.push({ ...activeTrade });
                        activeTrade = null;
                    }
                }

                // New entry with session hour gate (07:00 AM - 5:00 PM UTC = gold session)
                if (!activeTrade) {
                    const hour = currentCandle.timestamp.getUTCHours();
                    const minute = currentCandle.timestamp.getUTCMinutes();
                    const timeInMinutes = hour * 60 + minute;
                    const isSessionOpen = (timeInMinutes >= 7 * 60 && timeInMinutes <= 17 * 60);

                    if (isSessionOpen && lastTradeDate !== candleDate && dailyLossCount < 2) {
                        const analysis = uStrategy.analyze(currentWindow);
                        
                        if (analysis.signal === 'BUY' || analysis.signal === 'SELL') {
                            const rp = analysis.details.riskCalculator;
                            const quantity = 0.01; // Fixed lot
                            
                            let sl = analysis.signal === 'BUY' ? rp.stopLoss.long : rp.stopLoss.short;
                            let originalSl = sl;
                            let tp1 = analysis.signal === 'BUY' ? rp.takeProfit.tp1Long : rp.takeProfit.tp1Short;
                            let tp2 = analysis.signal === 'BUY' ? rp.takeProfit.tp2Long : rp.takeProfit.tp2Short;

                            // Enforce max loss rule (tiered doubling)
                            let base = 50;
                            while (base * 2 <= equity) base *= 2;
                            const maxLoss = base * (this.MAX_LOSS_PERCENT / 100);

                            const CONTRACT_SIZE = 100;
                            const positionSize = quantity * CONTRACT_SIZE;
                            const maxSlPoints = maxLoss / positionSize;

                            const currentSlDistance = Math.abs(currentCandle.open - sl);
                            if (currentSlDistance > maxSlPoints) {
                                sl = analysis.signal === 'BUY' ? currentCandle.open - maxSlPoints : currentCandle.open + maxSlPoints;
                                originalSl = sl;

                                const cappedSlDistance = Math.abs(currentCandle.open - sl);
                                tp1 = analysis.signal === 'BUY'
                                    ? currentCandle.open + (cappedSlDistance * uStrategy.TP1_RR)
                                    : currentCandle.open - (cappedSlDistance * uStrategy.TP1_RR);
                                tp2 = analysis.signal === 'BUY'
                                    ? currentCandle.open + (cappedSlDistance * uStrategy.TP2_RR)
                                    : currentCandle.open - (cappedSlDistance * uStrategy.TP2_RR);
                            }

                            const newsFilter = isUsdNewsBlocked(currentCandle.timestamp);
                            if (newsFilter.blocked) {
                                continue;
                            }
                            
                            activeTrade = {
                                id: trades.length + 1,
                                action: analysis.signal,
                                entryPrice: currentCandle.open,
                                quantity,
                                initialQuantity: quantity,
                                remainingQuantity: quantity,
                                realizedPnl: 0,
                                tp1Hit: false,
                                sl: sl,
                                originalSl,
                                tp1,
                                tp2,
                                atr: rp.atr,
                                score: analysis.score,
                                confluence: analysis.details.confluenceScorer?.details || '',
                                timestamp: currentCandle.timestamp,
                                status: 'OPEN'
                            };
                            lastTradeDate = candleDate;

                            const sameCandleExit = uStrategy.checkTradeExit(activeTrade, currentCandle);
                            if (sameCandleExit.closed) {
                                equity += sameCandleExit.pnl;
                                if (sameCandleExit.pnl < 0) {
                                    dailyLossCount++;
                                }

                                activeTrade.pnl = sameCandleExit.pnl;
                                activeTrade.exitTimestamp = currentCandle.timestamp;
                                activeTrade.exitReason = sameCandleExit.exitReason;
                                activeTrade.exitPrice = sameCandleExit.exitPrice;
                                activeTrade.status = 'CLOSED';
                                trades.push({ ...activeTrade });
                                activeTrade = null;
                            }
                        }
                    }
                }

                const markedEquity = activeTrade
                    ? equity + calculateTradePnl(activeTrade, currentCandle.close)
                    : equity;
                equityCurve.push({ day: equityCurve.length + 1, equity: markedEquity });
            }

            if (activeTrade) {
                const finalCandle = historicalData[historicalData.length - 1];
                const pnl = calculateTradePnl(activeTrade, finalCandle.close);
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
                dataInfo: {
                    hash: dataHash,
                    source: dataSource,
                    candleCount: historicalData.length,
                    dateRange: `${firstTs.slice(0,10)} to ${lastTs.slice(0,10)}`,
                    anchoredTo: dateKey,
                    requestedDays: backtestDays
                },
                trades: completedTrades.map(t => ({
                    id: t.id,
                    entryTimestamp: t.timestamp.toISOString(),
                    exitTimestamp: t.exitTimestamp ? t.exitTimestamp.toISOString() : null,
                    action: t.action, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
                    quantity: t.quantity, pnl: t.pnl, sl: t.sl, originalSl: t.originalSl,
                    tp1: t.tp1, tp2: t.tp2, remainingQuantity: t.remainingQuantity,
                    realizedPnl: t.realizedPnl, tp1Hit: t.tp1Hit, score: t.score, confluence: t.confluence,
                    exitReason: t.exitReason
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
                    headers: { 'Accept': 'application/json', 'User-Agent': 'GoldForge/1.0' },
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
                headers: { 'Accept': 'application/json' },
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
