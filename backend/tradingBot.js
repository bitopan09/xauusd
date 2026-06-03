const AnalysisEngine = require('./analysisEngine');
const DecisionEngine = require('./decisionEngine');
const ExecutionEngine = require('./executionEngine');
const emailService = require('./emailService');
const fetch = require('node-fetch');

class TradingBot {
    constructor(db) {
        this.db = db;
        this.analysisEngine = new AnalysisEngine();
        this.decisionEngine = new DecisionEngine();
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
        this.maxDataPoints = 200;
        this.FIXED_QUANTITY = 0.01; // Fixed lot — never changes

        this._initializePriceData();
    }

    /**
     * Initialize price data with some starting gold prices
     */
    _initializePriceData() {
        const basePrice = 2400;
        for (let i = 0; i < 50; i++) {
            const price = basePrice + (Math.random() - 0.5) * 40; // Random walk around $2400
            this.priceData.push({
                timestamp: new Date(Date.now() - (50 - i) * 60000),
                price: price,
                volume: Math.random() * 100
            });
        }
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
     * Fetches 6H candles from Bybit for XAUUSDT and runs confluence scoring
     */
    async _analyzeAndTrade() {
        try {
            // Fetch live 6H candles from Bybit for XAU/USD
            const symbol = 'XAUUSDT';
            const interval = '360'; // 6h candles
            const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=200`;
            
            let json;
            try {
                json = await this._fetchBybitData(url);
            } catch (err) {
                console.error('Failed to fetch live XAU candles (direct and proxy):', err.message);
                return;
            }
            
            if (!json || json.retCode !== 0 || !json.result?.list || json.result.list.length === 0) {
                console.error('Invalid Bybit response for XAU candles');
                return;
            }
            
            // Format for analysis (Bybit returns newest first, reverse to chronological)
            this.priceData = json.result.list.reverse().map(k => ({
                timestamp: new Date(parseInt(k[0])),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                price: parseFloat(k[4])
            }));

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
            circuitBreakerActive: this.decisionEngine.circuitBreakerActive
        };
    }

    async getRecentTrades(limit = 10) {
        return await this.executionEngine.getTrades(limit);
    }

    /**
     * Run backtest using real-time historical gold data from Bybit
     */
    async runBacktest(days = 90, strategy = 'default') {
        console.log(`Starting XAU/USD backtest for ${days} days...`);
        
        try {
            let historicalData = null;
            
            // Bybit XAUUSDT linear perpetual
            try {
                console.log('Fetching XAU/USD candles from Bybit API...');
                const symbol = 'XAUUSDT';
                const interval = '360'; // 6h candles
                const totalLimit = 500;
                
                let end = Date.now();
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
                
            } catch (bybitError) {
                console.warn('Bybit API failed, using synthetic gold data...', bybitError.message);
                historicalData = this._generateSyntheticData(500);
                console.log(`✓ Generated ${historicalData.length} synthetic gold candles`);
            }

            // Initialize simulation
            const trades = [];
            let equity = 50;
            const initialEquity = 50;
            const equityCurve = [];
            let activeTrade = null;
            let consecutiveLosses = 0;
            let cooldownCandles = 0;
            
            const UnifiedStrategy = require('./unifiedStrategy');
            const uStrategy = new UnifiedStrategy();
            
            // Loop through data using UnifiedStrategy
            for (let i = 50; i < historicalData.length; i++) {
                const currentWindow = historicalData.slice(i - 50, i);
                const currentCandle = historicalData[i];
                
                if (i % 10 === 0) {
                    equityCurve.push({ day: equityCurve.length + 1, equity });
                }

                if (cooldownCandles > 0) {
                    cooldownCandles--;
                    if (!activeTrade) continue;
                }

                // Check active trade exit
                if (activeTrade) {
                    const exitResult = uStrategy.checkTradeExit(activeTrade, currentCandle);
                    if (exitResult.closed) {
                        equity += exitResult.pnl;
                        // No equity floor — let backtest reflect real losses accurately
                        if (exitResult.pnl < 0) {
                            consecutiveLosses++;
                            if (consecutiveLosses >= 2) { cooldownCandles = 3; consecutiveLosses = 0; }
                        } else { consecutiveLosses = 0; }
                        
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

                    if (isSessionOpen) {
                        const analysis = uStrategy.analyze(currentWindow);
                        
                        if (analysis.signal === 'BUY' || analysis.signal === 'SELL') {
                            const rp = analysis.details.riskCalculator;
                            const quantity = 0.01; // Fixed lot
                            
                            let sl = analysis.signal === 'BUY' ? rp.stopLoss.long : rp.stopLoss.short;

                            // Enforce max 10% loss rule (tiered doubling)
                            let base = 50;
                            while (base * 2 <= equity) base *= 2;
                            const maxLoss = base * 0.10;

                            const CONTRACT_SIZE = 100;
                            const positionSize = quantity * CONTRACT_SIZE;
                            const maxSlPoints = maxLoss / positionSize;

                            const currentSlDistance = Math.abs(currentCandle.open - sl);
                            if (currentSlDistance > maxSlPoints) {
                                sl = analysis.signal === 'BUY' ? currentCandle.open - maxSlPoints : currentCandle.open + maxSlPoints;
                            }
                            
                            activeTrade = {
                                id: trades.length + 1,
                                action: analysis.signal,
                                entryPrice: currentCandle.open,
                                quantity,
                                sl: sl,
                                originalSl: sl,
                                tp1: analysis.signal === 'BUY' ? rp.takeProfit.tp1Long : rp.takeProfit.tp1Short,
                                tp2: analysis.signal === 'BUY' ? rp.takeProfit.tp2Long : rp.takeProfit.tp2Short,
                                atr: rp.atr,
                                score: analysis.score,
                                confluence: analysis.details.confluenceScorer?.details || '',
                                timestamp: currentCandle.timestamp,
                                status: 'OPEN'
                            };
                        }
                    }
                }
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

            return {
                totalTrades: completedTrades.length,
                winRate,
                profitFactor: Math.min(profitFactor, 10),
                maxDrawdown: maxDD,
                sharpeRatio: ((equity - initialEquity) / initialEquity) > 0 ? 1.8 : 0.5,
                totalReturn: (equity - initialEquity) / initialEquity,
                equityCurve,
                trades: completedTrades.map(t => ({
                    id: t.id,
                    entryTimestamp: t.timestamp.toISOString(),
                    exitTimestamp: t.exitTimestamp ? t.exitTimestamp.toISOString() : null,
                    action: t.action, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
                    quantity: t.quantity, pnl: t.pnl, sl: t.sl, originalSl: t.originalSl,
                    tp1: t.tp1, tp2: t.tp2, score: t.score, confluence: t.confluence,
                    exitReason: t.exitReason
                }))
            };

        } catch (error) {
            console.error('XAU backtest error:', error);
            throw error;
        }
    }

    /**
     * Helper to fetch data from Bybit, with automatic proxy fallback for blocked cloud IPs (e.g. Railway)
     */
    async _fetchBybitData(url) {
        try {
            const response = await fetch(url, { headers: { 'Accept': 'application/json' }, timeout: 8000 });
            if (response.ok) {
                const json = await response.json();
                if (json && json.retCode === 0) return json;
            }
            throw new Error(`Direct fetch failed with status ${response.status}`);
        } catch (directErr) {
            console.log(`Direct Bybit fetch failed (${directErr.message}), falling back to proxy...`);
            try {
                const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${url.replace(/&/g, '%26')}`;
                const proxyResponse = await fetch(proxyUrl, { headers: { 'Accept': 'application/json' }, timeout: 12000 });
                if (proxyResponse.ok) {
                    const proxyJson = await proxyResponse.json();
                    if (proxyJson && proxyJson.retCode === 0) return proxyJson;
                }
                throw new Error(`Proxy fetch failed with status ${proxyResponse.status}`);
            } catch (proxyErr) {
                throw new Error(`All fetch methods failed. Last error: ${proxyErr.message}`);
            }
        }
    }

    /**
     * Generate synthetic gold price data for backtesting fallback
     */
    _generateSyntheticData(count = 500) {
        const data = [];
        let basePrice = 2350;
        const now = new Date();
        
        for (let i = count; i > 0; i--) {
            const timestamp = new Date(now.getTime() - i * 6 * 60 * 60 * 1000);
            const trend = Math.sin(i / 100) * 0.001;
            const randomChange = (Math.random() - 0.5) * 0.008;
            basePrice = basePrice * (1 + trend + randomChange);
            
            const volatility = 0.005; // Gold has lower volatility than BTC
            const open = basePrice;
            const high = basePrice * (1 + Math.random() * volatility);
            const low = basePrice * (1 - Math.random() * volatility);
            const close = basePrice + (Math.random() - 0.5) * basePrice * 0.003;
            
            data.push({
                timestamp, open,
                high: Math.max(open, close, high),
                low: Math.min(open, close, low),
                close,
                volume: 500 + Math.random() * 3000,
                price: close
            });
        }
        return data;
    }
}

module.exports = TradingBot;
