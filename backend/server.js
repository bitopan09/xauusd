const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const TradingBot = require('./tradingBot');
const ExcelExport = require('./excelExport');
const DailyOptimizer = require('./optimizer/dailyOptimizer');
const optimizerConfig = require('./optimizer/config');
const telegramService = require('./telegramService');

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// SQLite database setup
const db = new sqlite3.Database('./trading.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    // Enable WAL mode for better concurrent read/write performance
    db.run('PRAGMA journal_mode=WAL', (err) => {
        if (err) console.error('Failed to enable WAL mode:', err.message);
        else console.log('SQLite WAL mode enabled');
    });
    console.log('Connected to the XAU/USD SQLite database.');
});

// Initialize trading bot and pass DB instance
const tradingBot = new TradingBot(db);

// Initialize daily optimizer
const dailyOptimizer = new DailyOptimizer(db, {
    trainWindowDays: optimizerConfig.ML_FILTER.trainWindowDays,
    validationWindowDays: optimizerConfig.ML_FILTER.validationWindowDays,
    confidenceThreshold: optimizerConfig.ML_FILTER.confidenceThreshold,
    minSamples: optimizerConfig.ML_FILTER.minSamples,
});

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    symbol TEXT,
    price REAL,
    volume REAL
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT DEFAULT 'default',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    action TEXT,
    entry_price REAL,
    exit_price REAL,
    quantity REAL,
    pnl REAL,
    score INTEGER,
    notes TEXT,
    status TEXT DEFAULT 'OPEN',
    sl REAL,
    tp1 REAL,
    tp2 REAL,
    exit_reason TEXT,
    exit_timestamp DATETIME,
    trade_type TEXT DEFAULT 'live',
    atr REAL,
    original_sl REAL,
    remaining_quantity REAL,
    realized_pnl REAL DEFAULT 0,
    tp1_hit INTEGER DEFAULT 0
  )`);

    // Migrate existing databases: add new columns if they don't exist
    db.run(`ALTER TABLE trades ADD COLUMN tp2 REAL`, () => {});
    db.run(`ALTER TABLE trades ADD COLUMN atr REAL`, () => {});
    db.run(`ALTER TABLE trades ADD COLUMN original_sl REAL`, () => {});
    db.run(`ALTER TABLE trades ADD COLUMN remaining_quantity REAL`, () => {});
    db.run(`ALTER TABLE trades ADD COLUMN realized_pnl REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE trades ADD COLUMN tp1_hit INTEGER DEFAULT 0`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    state_json TEXT,
    updated_at DATETIME
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS balance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT DEFAULT 'default',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    usd_balance REAL,
    xau_balance REAL
  )`);

    // Initialize balance for default user if needed
    db.get(`SELECT COUNT(*) as count FROM balance WHERE userId = 'default'`, [], (err, row) => {
        if (!err && row.count === 0) {
            db.run(`INSERT INTO balance (userId, usd_balance, xau_balance) VALUES ('default', 50, 0)`);
        }
    });

    // Performance indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_prices_timestamp ON prices(timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_userId ON trades(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp)`);

    // DataManager persistent candle cache table
    db.run(`CREATE TABLE IF NOT EXISTS candles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL DEFAULT 'XAUUSDT',
        interval TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        source TEXT DEFAULT 'binance',
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, interval, timestamp)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_candles_symbol_interval ON candles(symbol, interval, timestamp)`);

    // Optimizer tables
    db.run(`CREATE TABLE IF NOT EXISTS optimizer_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        score REAL,
        profit_factor REAL,
        max_dd_pct REAL,
        win_rate REAL,
        trades INTEGER,
        deployed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active INTEGER DEFAULT 1
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS optimizer_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_configs INTEGER,
        best_pf REAL,
        best_config TEXT,
        best_score REAL,
        ml_accuracy REAL,
        ml_samples INTEGER,
        deployed INTEGER DEFAULT 0,
        improvement_pct REAL,
        duration_seconds REAL
    )`);

    // Load active trades into memory
    tradingBot.executionEngine.loadOpenTrades();
});

// WebSocket connection handling (frontend clients)
wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'get_price') {
                db.get(`SELECT * FROM prices ORDER BY timestamp DESC LIMIT 1`, [], (err, row) => {
                    if (!err && row) {
                        ws.send(JSON.stringify({ type: 'price_update', data: row }));
                    }
                });
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
    });
});

// ============================================================
// BINANCE WEBSOCKET — Real-time XAU/USD Price Feed + Kline Streams
// Price ticker for live price updates.
// Kline streams for real-time candlestick chart updates (6H, 1m, 5m).
// ============================================================
let binanceKlineWs6h = null;
let binanceKlineWs1m = null;
let binanceKlineWs5m = null;
let latestTickerPrice = null; // Real-time Binance ticker price

const connectKlineStream = (interval, label) => {
    const wsUrl = `wss://fstream.binance.com/ws/xauusdt@kline_${interval}`;
    let pingInterval;
    let reconnectTimeout;

    const connect = () => {
        console.log(`[KLINE-${label}] Connecting to ${wsUrl}...`);
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log(`✅ [KLINE-${label}] Connected — Real-time ${label} candle updates active`);
            pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try { ws.ping(); } catch {}
                }
            }, 25000);
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (!msg.k) return;

                const kline = msg.k;
                const candle = {
                    time: Math.floor(kline.t / 1000),
                    open: parseFloat(kline.o),
                    high: parseFloat(kline.h),
                    low: parseFloat(kline.l),
                    close: parseFloat(kline.c),
                    volume: parseFloat(kline.v),
                    interval: interval,
                    isFinal: kline.x, // true = candle closed, false = still forming
                };

                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'kline',
                            data: candle,
                        }));
                    }
                });
            } catch {}
        });

        ws.on('close', () => {
            console.log(`[KLINE-${label}] Disconnected, reconnecting in 3s...`);
            if (pingInterval) clearInterval(pingInterval);
            reconnectTimeout = setTimeout(connect, 3000);
        });

        ws.on('error', (err) => {
            console.error(`[KLINE-${label}] Error:`, err.message);
            if (pingInterval) clearInterval(pingInterval);
        });

        return ws;
    };

    return connect();
};

const connectBybitWebSocket = () => {
    // Binance WebSocket — works from cloud servers (unlike Bybit)
    const wsUrl = 'wss://fstream.binance.com/ws/xauusdt@ticker';
    let lastDbInsert = Date.now();
    let pingInterval;
    let reconnectTimeout;

    const connect = () => {
        console.log(`[WS] Connecting to ${wsUrl}...`);
        
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log('✅ Connected to Binance WebSocket — Real-time XAU/USD feed active');
            
            // Binance requires pong frame keepalive, handled automatically by ws library
            // But we send ping every 25s for safety
            pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try { ws.ping(); } catch {}
                }
            }, 25000);
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                
                // Binance ticker format: {"e":"24hrTicker","s":"XAUUSDT","c":"4160.50",...}
                if (!msg.s || msg.s !== 'XAUUSDT') return;

                const price = parseFloat(msg.c);
                if (!price || isNaN(price)) return;

                const volume = parseFloat(msg.v || 0);
                const timestamp = new Date().toISOString();
                
                const priceData = {
                    symbol: 'XAUUSD',
                    price: price,
                    volume: volume,
                    timestamp: timestamp,
                    _ts: Date.now()
                };

                latestTickerPrice = priceData; // Store latest for bot status (with _ts for freshness check)

                // Broadcast to all frontend clients
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'price',
                            data: priceData
                        }));
                    }
                });

                if (Date.now() - lastDbInsert >= 1000) {
                    db.run(
                        `INSERT INTO prices (symbol, price, volume) VALUES (?, ?, ?)`,
                        ['XAUUSD', price, volume],
                        (err) => { if (err) console.error('Error inserting gold price:', err); }
                    );
                    lastDbInsert = Date.now();
                }
            } catch (err) {
                // Silently ignore parse errors
            }
        });

        ws.on('close', () => {
            console.log('[WS] Binance WebSocket closed, reconnecting in 3s...');
            if (pingInterval) clearInterval(pingInterval);
            reconnectTimeout = setTimeout(connect, 3000);
        });

        ws.on('error', (err) => {
            console.error('[WS] Binance WebSocket error:', err.message);
            if (pingInterval) clearInterval(pingInterval);
        });

        return ws;
    };

    return connect();
};

connectBybitWebSocket();

// Start kline streams for real-time charts
binanceKlineWs6h = connectKlineStream('6h', '6H');
binanceKlineWs1m = connectKlineStream('1m', '1m');
binanceKlineWs5m = connectKlineStream('5m', '5m');

// ══════════════════════════════════════════════════════════════════
// SHARED FETCH HELPERS — Binance primary, OKX fallback (Railway blocks Binance IPs)
// ══════════════════════════════════════════════════════════════════
const UA = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchPriceWithFallback() {
    try {
        const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAUUSDT', { headers: UA, timeout: 8000 });
        if (r.ok) { const j = await r.json(); const p = parseFloat(j.price); if (isFinite(p)) return p; }
    } catch {}
    try {
        const r = await fetch('https://www.okx.com/api/v5/market/ticker?instId=XAU-USDT-SWAP', { headers: UA, timeout: 8000 });
        if (r.ok) { const j = await r.json(); if (j.code === '0' && j.data?.[0]) { const p = parseFloat(j.data[0].last); if (isFinite(p)) return p; } }
    } catch {}
    return null;
}

async function fetchCandlesWithFallback(interval, limit) {
    const binMap = { '6H': '6h', '5min': '5m', '1min': '1m' };
    const binInt = binMap[interval] || '6h';
    const okxMap = { '6H': '6H', '5min': '5m', '1min': '1m' };
    const okxInt = okxMap[interval] || '6H';
    try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${binInt}&limit=${limit}`, { headers: UA, timeout: 8000 });
        if (r.ok) { const d = await r.json(); if (Array.isArray(d) && d.length) return d.map(c => ({ time: Math.floor(parseInt(c[0])/1000), open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) })).sort((a,b) => a.time - b.time); }
    } catch {}
    try {
        const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=XAU-USDT-SWAP&bar=${okxInt}&limit=${limit}`, { headers: UA, timeout: 8000 });
        if (r.ok) { const d = await r.json(); if (d.code === '0' && d.data?.length) return d.data.reverse().map(c => ({ time: Math.floor(parseInt(c[0])/1000), open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]||0) })).sort((a,b) => a.time - b.time); }
    } catch {}
    return null;
}

// REST price poller — broadcasts real-time price to frontend clients every 2s
setInterval(async () => {
    try {
        const price = await fetchPriceWithFallback();
        if (price && isFinite(price)) {
            const now = Date.now();
            const priceData = {
                symbol: 'XAUUSD', price, volume: 0,
                timestamp: new Date().toISOString(), _ts: now
            };
            latestTickerPrice = priceData;
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'price', data: priceData }));
                }
            });
        }
    } catch {}
}, 2000);

async function fetchLivePrice() {
    if (latestTickerPrice && latestTickerPrice._ts && (Date.now() - latestTickerPrice._ts) < 5000) {
        return latestTickerPrice;
    }
    const price = await fetchPriceWithFallback();
    if (price && isFinite(price)) {
        const priceData = {
            symbol: 'XAUUSD', price, volume: 0,
            timestamp: new Date().toISOString(), _ts: Date.now()
        };
        latestTickerPrice = priceData;
        db.run('INSERT INTO prices (symbol, price, volume) VALUES (?, ?, ?)', ['XAUUSD', priceData.price, 0]);
        return priceData;
    }
    return latestTickerPrice || { price: null };
}

// REST API endpoints
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Candle API — fetch candles from Binance/OKX with fallback
app.get('/api/candles', async (req, res) => {
    try {
        const interval = req.query.interval || '6H';
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500);

        let candles = await fetchCandlesWithFallback(interval, limit);
        if (!candles || candles.length === 0) {
            return res.json([]);
        }

        // Add forming candle for real-time feel
        const now = Date.now() / 1000;
        const maxAge = interval === '1min' ? 120 : interval === '5min' ? 600 : 1800;
        const last = candles[candles.length - 1];
        const lastAge = now - last.time;
        if (lastAge > maxAge) {
            const binIntervalSec = { '6h': 21600, '5m': 300, '1m': 60 };
            const binMap = { '6H': '6h', '5min': '5m', '1min': '1m' };
            const intervalSec = binIntervalSec[binMap[interval]] || 21600;
            const currentCandleTime = Math.floor(now / intervalSec) * intervalSec;
            if (currentCandleTime > last.time) {
                const live = await fetchLivePrice().catch(() => null);
                if (live && live.price) {
                    candles.push({
                        time: currentCandleTime, open: last.close,
                        high: live.price, low: live.price, close: live.price, volume: 0
                    });
                }
            }
        }

        res.json(candles);
    } catch (error) {
        console.error('[Candles] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/price', async (req, res) => {
    const priceData = await fetchLivePrice();
    if (priceData && priceData.price) {
        res.json(priceData);
    } else {
        db.get(`SELECT * FROM prices ORDER BY timestamp DESC LIMIT 1`, [], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(row || {});
        });
    }
});

app.get('/api/prices', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
    db.all(`SELECT * FROM prices ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.get('/api/balance', (req, res) => {
    const userId = req.query.userId || 'default';
    db.get(`SELECT * FROM balance WHERE userId = ? ORDER BY timestamp DESC LIMIT 1`, [userId], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!row) {
            db.run(`INSERT INTO balance (userId, usd_balance, xau_balance) VALUES (?, 50, 0)`, [userId], function() {
                res.json({ userId, usd_balance: 50, xau_balance: 0, id: this.lastID });
            });
        } else {
            res.json(row || {});
        }
    });
});

app.get('/api/trades', (req, res) => {
    const limit = req.query.limit || 50;
    const userId = req.query.userId || 'default';
    db.all(`SELECT * FROM trades WHERE userId = ? OR userId = 'default' ORDER BY timestamp DESC LIMIT ?`, [userId, limit], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.get('/api/trades/active', (req, res) => {
    const userId = req.query.userId || 'default';
    db.all(`SELECT * FROM trades WHERE (userId = ? OR userId = 'default') AND status = 'OPEN' ORDER BY timestamp DESC`, [userId], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/trades', (req, res) => {
    const { action, entry_price, exit_price, quantity, pnl, score, notes, userId } = req.body;
    const user = userId || 'default';

    db.run(
        `INSERT INTO trades (userId, action, entry_price, exit_price, quantity, pnl, score, notes, trade_type) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paper')`,
        [user, action, entry_price, exit_price, quantity, pnl, score, notes],
        function (err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            db.get(`SELECT * FROM balance WHERE userId = ? ORDER BY timestamp DESC LIMIT 1`, [user], (err, balance) => {
                if (!err && balance) {
                    const newBalance = balance.usd_balance + (pnl || 0);
                    db.run(`INSERT INTO balance (userId, usd_balance, xau_balance) VALUES (?, ?, ?)`, 
                        [user, newBalance, balance.xau_balance]);
                }
            });
            res.json({ id: this.lastID, message: 'Trade recorded successfully' });
        }
    );
});

// Bot control
app.post('/api/bot/start', (req, res) => {
    tradingBot.start();
    res.json({ message: 'Gold trading bot started' });
});

app.post('/api/bot/stop', (req, res) => {
    tradingBot.stop();
    res.json({ message: 'Gold trading bot stopped' });
});

app.get('/api/bot/status', async (req, res) => {
    try {
        const status = tradingBot.getStatus();
        const recentTrades = await tradingBot.getRecentTrades(5);

        // Always fetch fresh live price
        const livePrice = await fetchLivePrice();
        status.livePrice = livePrice ? livePrice.price : null;
        status.livePriceTime = livePrice ? livePrice.timestamp : null;
        status.currentFormingCandle = livePrice
            ? { price: livePrice.price, time: livePrice.timestamp }
            : null;
        
        const today = new Date().toISOString().split('T')[0];
        db.get("SELECT * FROM trades WHERE timestamp LIKE ? LIMIT 1", [`${today}%`], (err, row) => {
            res.json({
                bot: status,
                recentTrades: recentTrades,
                todayTrade: row || null
            });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Frontend pushes candle data so the live bot can analyze
// even when candle APIs are blocked on cloud servers
app.post('/api/bot/candles', async (req, res) => {
    try {
        const { candles } = req.body;
        if (!candles || !Array.isArray(candles) || candles.length === 0) {
            return res.status(400).json({ error: 'No candle data provided' });
        }

        const isValidCandle = (k) => {
            if (!Array.isArray(k) || k.length < 6) return false;
            const timestamp = Number(k[0]);
            const open = Number(k[1]);
            const high = Number(k[2]);
            const low = Number(k[3]);
            const close = Number(k[4]);
            const volume = Number(k[5]);
            return [timestamp, open, high, low, close, volume].every(Number.isFinite)
                && timestamp > 0
                && high >= low
                && open > 0
                && close > 0
                && volume >= 0;
        };

        if (!candles.every(isValidCandle)) {
            return res.status(400).json({ error: 'Malformed candle data provided' });
        }

        // Parse raw candle format to the structure the bot expects
        const sorted = [...candles].sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
        const priceData = sorted.map(k => ({
            timestamp: new Date(parseInt(k[0])),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            price: parseFloat(k[4])
        }));

        if (!tradingBot.isCandleDataFresh(priceData)) {
            return res.status(400).json({ error: 'Candle data is stale or has an invalid timestamp' });
        }

        // Feed candle data to the bot (no analysis trigger — bot runs on its own timer)
        tradingBot.setPriceData(priceData, 'browser_relay');
        // Do NOT trigger _analyzeAndTrade — the bot's internal 60s timer handles that

        const status = tradingBot.getStatus();
        res.json({
            success: true,
            message: `Processed ${priceData.length} candles`,
            score: status.currentScore,
            signal: status.currentSignal
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Backtest
app.post('/api/backtest', async (req, res) => {
    try {
        const { days, strategy, userId, candles } = req.body;
        console.log(`Running XAU/USD backtest for ${days} days using ${strategy} strategy...`);
        const results = await tradingBot.runBacktest(days, strategy, candles || null);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Full Backtest with DD Risk Management (Progressive Position Sizing)
app.post('/api/full-backtest', async (req, res) => {
    try {
        const { days, strategy, userId, candles } = req.body;
        const backtestDays = days || 90;
        console.log(`Running FULL V4-Plus backtest for ${backtestDays} days with DD risk management...`);
        console.log(`Client candles received: ${candles ? candles.length : 'none'}`);

        // Set strategy parameters
                    process.env.CONFLUENCE_THRESHOLD = '5.5';
                    process.env.MAX_SL_DISTANCE = '15';
                    process.env.TP1_CLOSE_PERCENT = '50';

        // Clear module cache to pick up env changes
        Object.keys(require.cache).forEach(key => {
            if (key.includes('unifiedStrategy') || key.includes('tradingBot') || key.includes('brokerSimulation')) {
                delete require.cache[key];
            }
        });

        const TradingBot = require('./tradingBot');
        const bot = new TradingBot(db);

        // Run base backtest
        const baseResult = await bot.runBacktest(backtestDays, strategy || 'default', candles || null);
        const rawTrades = baseResult.trades || [];

        // ── Progressive Position Sizing (80/60/35) ──
        const CIRCUIT_BREAKER = 15;
        const STARTING_BALANCE = 50;
        let equity = STARTING_BALANCE;
        let peak = STARTING_BALANCE;
        const trades = [];

        for (const t of rawTrades) {
            if (equity < CIRCUIT_BREAKER) break;

            const ddPct = (peak - equity) / peak;
            let sizeMultiplier;
            if (ddPct < 0.10)      sizeMultiplier = 1.0;
            else if (ddPct < 0.20) sizeMultiplier = 0.80;
            else if (ddPct < 0.30) sizeMultiplier = 0.60;
            else                    sizeMultiplier = 0.35;

            const adjustedPnl = t.pnl * sizeMultiplier;
            const adjustedTrade = { ...t, pnl: adjustedPnl, sizeMultiplier };
            trades.push(adjustedTrade);

            equity += adjustedPnl;
            if (equity > peak) peak = equity;
        }

        // ── Equity Curve ──
        equity = STARTING_BALANCE;
        const equityCurve = [{ day: 0, equity: STARTING_BALANCE }];
        trades.forEach((t, i) => {
            equity += t.pnl;
            equityCurve.push({ day: i + 1, equity: Number(equity.toFixed(2)) });
        });

        // ── Statistics ──
        const wins = trades.filter(t => t.pnl > 0);
        const losses = trades.filter(t => t.pnl <= 0);
        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
        const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
        const avgWin = wins.length ? grossWins / wins.length : 0;
        const avgLoss = losses.length ? grossLosses / losses.length : 0;
        const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

        // Max drawdown
        let maxDD = 0, maxDDPct = 0;
        peak = STARTING_BALANCE;
        equityCurve.forEach(pt => {
            if (pt.equity > peak) peak = pt.equity;
            const dd = peak - pt.equity;
            const ddPct = (dd / peak) * 100;
            if (ddPct > maxDDPct) { maxDD = dd; maxDDPct = ddPct; }
        });

        // Consecutive streaks
        let maxConsecWin = 0, maxConsecLoss = 0, curWin = 0, curLoss = 0;
        trades.forEach(t => {
            if (t.pnl > 0) { curWin++; curLoss = 0; maxConsecWin = Math.max(maxConsecWin, curWin); }
            else { curLoss++; curWin = 0; maxConsecLoss = Math.max(maxConsecLoss, curLoss); }
        });

        // Exit reason breakdown
        const exitReasons = {};
        trades.forEach(t => {
            const r = t.exitReason || 'Unknown';
            if (!exitReasons[r]) exitReasons[r] = { count: 0, pnl: 0 };
            exitReasons[r].count++;
            exitReasons[r].pnl += t.pnl;
        });

        // Regime breakdown
        const regimeStats = {};
        trades.forEach(t => {
            const r = t.regime || 'unknown';
            if (!regimeStats[r]) regimeStats[r] = { count: 0, wins: 0, pnl: 0 };
            regimeStats[r].count++;
            if (t.pnl > 0) regimeStats[r].wins++;
            regimeStats[r].pnl += t.pnl;
        });

        // Action breakdown
        const actionStats = {};
        trades.forEach(t => {
            const a = t.action || 'unknown';
            if (!actionStats[a]) actionStats[a] = { count: 0, wins: 0, pnl: 0 };
            actionStats[a].count++;
            if (t.pnl > 0) actionStats[a].wins++;
            actionStats[a].pnl += t.pnl;
        });

        // Sharpe ratio (simplified)
        const returns = trades.map(t => t.pnl / STARTING_BALANCE);
        const avgReturn = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
        const stdReturn = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1)) : 0;
        const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

        res.json({
            startingBalance: STARTING_BALANCE,
            finalBalance: Number(equity.toFixed(2)),
            totalPnl: Number(totalPnl.toFixed(2)),
            totalReturn: Number((totalPnl / STARTING_BALANCE).toFixed(4)),
            maxDrawdown: Number(maxDD.toFixed(2)),
            maxDrawdownPct: Number(maxDDPct.toFixed(2)),
            profitFactor: pf === Infinity ? 999 : Number(pf.toFixed(2)),
            winRate: trades.length > 0 ? Number((wins.length / trades.length).toFixed(4)) : 0,
            winCount: wins.length,
            lossCount: losses.length,
            avgWin: Number(avgWin.toFixed(2)),
            avgLoss: Number(avgLoss.toFixed(2)),
            winLossRatio: Number(winLossRatio.toFixed(2)),
            totalTrades: trades.length,
            maxConsecWins: maxConsecWin,
            maxConsecLosses: maxConsecLoss,
            tradesPerDay: Number((trades.length / backtestDays).toFixed(2)),
            sharpeRatio: Number(sharpeRatio.toFixed(2)),
            trades,
            equityCurve,
            exitReasons,
            regimeStats,
            actionStats,
            costs: baseResult.costs || null,
            config: {
                confluenceThreshold: 5.5,
                maxSlDistance: 15,
                tp1ClosePercent: 50,
                circuitBreaker: CIRCUIT_BREAKER,
                sizingTiers: [1.0, 0.80, 0.60, 0.35]
            },
            dataInfo: baseResult.dataInfo || null
        });
    } catch (error) {
        console.error('Full backtest error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Generate Excel report from backtest results
app.post('/api/backtest/excel', async (req, res) => {
    try {
        const { days, strategy, candles } = req.body;
        console.log(`Generating Excel report for ${days || 90}-day backtest...`);

        Object.keys(require.cache).forEach(key => {
            if (key.includes('unifiedStrategy') || key.includes('tradingBot') || key.includes('brokerSimulation')) {
                delete require.cache[key];
            }
        });
        const FreshTradingBot = require('./tradingBot');
        const freshBot = new FreshTradingBot(db);

        const results = await freshBot.runBacktest(days || 90, strategy || 'default', candles || null);
        const outputPath = ExcelExport.generate(results, {
            filename: `xauusd_backtest_${new Date().toISOString().split('T')[0]}.xlsx`
        });
        res.download(outputPath, path.basename(outputPath), (err) => {
            if (err) {
                console.error('Download error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Failed to download file' });
                }
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── Daily Optimizer API ──────────────────────────────────────────

// Run optimizer manually
app.post('/api/optimizer/run', async (req, res) => {
    try {
        console.log('[Optimizer] Manual optimization run triggered...');

        // Fetch data via tradingBot's data pipeline
        const backtestDays = req.body.days || 30;
        const backtestResult = await tradingBot.runBacktest(backtestDays, 'default', null);

        if (!backtestResult || !backtestResult.rawPriceData || backtestResult.rawPriceData.length < 50) {
            return res.status(400).json({ error: 'Insufficient data for optimization' });
        }

        const priceData = backtestResult.rawPriceData || [];

        // Fast backtest wrapper for optimizer
        const runFastBacktest = async (data, params) => {
            // Set env vars temporarily for this config
            const origThreshold = process.env.CONFLUENCE_THRESHOLD;
            const origSL = process.env.MAX_SL_DISTANCE;
            const origTP1 = process.env.TP1_CLOSE_PERCENT;
            const origScoreMargin = process.env.SCORE_MARGIN_MIN;
            const origBuyMargin = process.env.BUY_SCORE_MARGIN;
            const origEmaAlign = process.env.EMA_ALIGNMENT_REQUIRED;

            process.env.CONFLUENCE_THRESHOLD = String(params.confluenceThreshold || 5.5);
            process.env.MAX_SL_DISTANCE = String(params.maxSlDistance || 15);
            process.env.TP1_CLOSE_PERCENT = String(params.tp1ClosePercent || 60);
            process.env.SCORE_MARGIN_MIN = String(params.scoreMarginMin ?? 1.0);
            process.env.BUY_SCORE_MARGIN = String(params.buyScoreMargin ?? 2.0);
            process.env.EMA_ALIGNMENT_REQUIRED = String(params.emaAlignmentRequired ?? false);

            // Clear module cache
            Object.keys(require.cache).forEach(key => {
                if (key.includes('unifiedStrategy') || key.includes('tradingBot') || key.includes('brokerSimulation') || key.includes('tradeEngine')) {
                    delete require.cache[key];
                }
            });

            const TradingBot = require('./tradingBot');
            const bot = new TradingBot(db);
            const result = await bot.runBacktest(backtestDays, 'default', null);

            // Restore env
            process.env.CONFLUENCE_THRESHOLD = origThreshold;
            process.env.MAX_SL_DISTANCE = origSL;
            process.env.TP1_CLOSE_PERCENT = origTP1;
            process.env.SCORE_MARGIN_MIN = origScoreMargin;
            process.env.BUY_SCORE_MARGIN = origBuyMargin;
            process.env.EMA_ALIGNMENT_REQUIRED = origEmaAlign;

            const trades = result.trades || [];
            const wins = trades.filter(t => t.pnl > 0);
            const losses = trades.filter(t => t.pnl <= 0);
            const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
            const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
            const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;
            const wr = trades.length > 0 ? wins.length / trades.length : 0;
            const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

            let peak = 50, maxDD = 0, eq = 50;
            for (const t of trades) {
                eq += t.pnl;
                if (eq > peak) peak = eq;
                const dd = (peak - eq) / peak * 100;
                if (dd > maxDD) maxDD = dd;
            }

            return {
                trades,
                equityCurve: result.equityCurve || [],
                stats: {
                    totalTrades: trades.length,
                    winRate: wr,
                    profitFactor: pf,
                    totalPnl,
                    maxDDPct: maxDD,
                }
            };
        };

        const result = await dailyOptimizer.optimize({
            priceData,
            runFastBacktest,
            paramSpace: optimizerConfig,
        });

        res.json(result);
    } catch (error) {
        console.error('[Optimizer] Run error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get optimizer run history
app.get('/api/optimizer/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const history = await dailyOptimizer.getHistory(limit);
        const activeConfig = await dailyOptimizer.getActiveConfig();
        res.json({ history, activeConfig });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get current active optimizer config
app.get('/api/optimizer/config', async (req, res) => {
    try {
        const config = await dailyOptimizer.getActiveConfig();
        res.json(config || { message: 'No optimized config deployed yet — using defaults' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/manual-trade', async (req, res) => {
    try {
        const { action, quantity, userId } = req.body;
        const user = userId || 'default';

        // Use live Binance price instead of stale DB
        const live = await fetchLivePrice();
        if (!live || !live.price) {
            return res.status(500).json({ error: 'Could not get current gold price' });
        }

        const signal = { action: action.toUpperCase(), price: live.price };
        const result = await tradingBot.executionEngine.executeTrade(signal, 0.01, user, true);

        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Close Trade
app.post('/api/trades/:id/close', async (req, res) => {
    try {
        const tradeId = parseInt(req.params.id);
        if (!Number.isFinite(tradeId) || tradeId <= 0) {
            return res.status(400).json({ error: 'Invalid trade ID' });
        }
        
        db.get('SELECT price FROM prices ORDER BY timestamp DESC LIMIT 1', async (err, row) => {
            if (err || !row) {
                return res.status(500).json({ error: 'Could not get current gold price' });
            }
            
            const result = await tradingBot.executionEngine.manualExitTrade(tradeId, row.price);
            
            if (result.success) {
                res.json(result);
            } else {
                res.status(400).json(result);
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Partial Close Trade
app.post('/api/trades/:id/partial-close', async (req, res) => {
    try {
        const tradeId = parseInt(req.params.id);
        if (!Number.isFinite(tradeId) || tradeId <= 0) {
            return res.status(400).json({ error: 'Invalid trade ID' });
        }

        const { closePercent } = req.body;
        if (!closePercent || closePercent <= 0 || closePercent > 100) {
            return res.status(400).json({ error: 'closePercent must be between 1 and 100' });
        }

        db.get('SELECT price FROM prices ORDER BY timestamp DESC LIMIT 1', async (err, row) => {
            if (err || !row) {
                return res.status(500).json({ error: 'Could not get current gold price' });
            }

            const result = await tradingBot.executionEngine.manualPartialClose(tradeId, row.price, closePercent);

            if (result.success) {
                res.json(result);
            } else {
                res.status(400).json(result);
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function csvEscape(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// CSV Export
app.get('/api/trades/export', (req, res) => {
    const userId = req.query.userId || 'default';
    db.all(`SELECT * FROM trades WHERE userId = ? OR userId = 'default' ORDER BY timestamp DESC`, [userId], (err, rows) => {
        if (err) return res.status(500).send('Error fetching trades');
        
        const headers = ['ID', 'Date', 'Action', 'Entry Price', 'Exit Price', 'Quantity (lots)', 'Stop Loss', 'Take Profit 1', 'Take Profit 2', 'Status', 'P&L', 'Notes'];
        const BOM = '\ufeff';
        let csv = BOM + headers.join(',') + '\n';
        
        if (rows.length === 0) {
            csv += 'No trades found,,,,,,,,,,,\n';
        } else {
            rows.forEach(row => {
                const cols = [
                    csvEscape(row.id), csvEscape(row.timestamp), csvEscape(row.action),
                    csvEscape(row.entry_price), csvEscape(row.exit_price),
                    csvEscape(row.quantity), csvEscape(row.sl),
                    csvEscape(row.tp1), csvEscape(row.tp2),
                    csvEscape(row.status), csvEscape(row.pnl),
                    csvEscape(row.notes)
                ];
                csv += cols.join(',') + '\n';
            });
        }
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=xauusd_trade_journal.csv');
        res.send(csv);
    });
});

// Telegram bot setup
const sendTelegramAlert = (message) => {
    telegramService.sendMessage(message).catch(() => {});
};

// Schedule daily tasks
schedule.scheduleJob('0 0 * * *', () => {
    console.log('[' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + '] Daily trade lock reset');
    
    sendTelegramAlert('Gold bot: Daily trade lock reset — new trading day started');
});

// Daily optimizer auto-run at 01:00 UTC (off-session, quiet period)
schedule.scheduleJob('0 1 * * *', async () => {
    console.log('[Optimizer] Daily auto-optimization starting...');
    try {
        // Fetch fresh data
        const backtestResult = await tradingBot.runBacktest(30, 'default', null);
        if (!backtestResult || !backtestResult.rawPriceData || backtestResult.rawPriceData.length < 50) {
            console.log('[Optimizer] Skipped — insufficient data');
            return;
        }

        const priceData = backtestResult.rawPriceData || [];

        const runFastBacktest = async (data, params) => {
            const origThreshold = process.env.CONFLUENCE_THRESHOLD;
            const origSL = process.env.MAX_SL_DISTANCE;
            const origTP1 = process.env.TP1_CLOSE_PERCENT;

            process.env.CONFLUENCE_THRESHOLD = String(params.confluenceThreshold || 5.5);
            process.env.MAX_SL_DISTANCE = String(params.maxSlDistance || 15);
            process.env.TP1_CLOSE_PERCENT = String(params.tp1ClosePercent || 60);

            Object.keys(require.cache).forEach(key => {
                if (key.includes('unifiedStrategy') || key.includes('tradingBot') || key.includes('brokerSimulation') || key.includes('tradeEngine')) {
                    delete require.cache[key];
                }
            });

            const TradingBot = require('./tradingBot');
            const bot = new TradingBot(db);
            const result = await bot.runBacktest(30, 'default', null);

            process.env.CONFLUENCE_THRESHOLD = origThreshold;
            process.env.MAX_SL_DISTANCE = origSL;
            process.env.TP1_CLOSE_PERCENT = origTP1;

            const trades = result.trades || [];
            const wins = trades.filter(t => t.pnl > 0);
            const losses = trades.filter(t => t.pnl <= 0);
            const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
            const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
            const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;
            const wr = trades.length > 0 ? wins.length / trades.length : 0;

            let peak = 50, maxDD = 0, eq = 50;
            for (const t of trades) {
                eq += t.pnl;
                if (eq > peak) peak = eq;
                const dd = (peak - eq) / peak * 100;
                if (dd > maxDD) maxDD = dd;
            }

            return {
                trades,
                equityCurve: result.equityCurve || [],
                stats: { totalTrades: trades.length, winRate: wr, profitFactor: pf, totalPnl: trades.reduce((s, t) => s + t.pnl, 0), maxDDPct: maxDD }
            };
        };

        const result = await dailyOptimizer.optimize({ priceData, runFastBacktest, paramSpace: optimizerConfig });

        if (result.success && result.deployed) {
            console.log(`[Optimizer] Deployed new config: PF=${result.bestStats.profitFactor.toFixed(2)} WR=${(result.bestStats.winRate*100).toFixed(1)}% Score=${result.bestScore.toFixed(2)}`);
            sendTelegramAlert(`Daily Optimizer: New config deployed\nPF: ${result.bestStats.profitFactor.toFixed(2)}\nWR: ${(result.bestStats.winRate*100).toFixed(1)}%\nImprovement: ${result.improvementOverCurrent}`);
        } else if (result.success) {
            console.log(`[Optimizer] No improvement over current config (${result.improvementOverCurrent})`);
        } else {
            console.log(`[Optimizer] Optimization failed: ${result.error}`);
        }
    } catch (err) {
        console.error('[Optimizer] Auto-run error:', err.message);
    }
});

// Telegram endpoints
app.post('/api/telegram/test', async (req, res) => {
    try {
        const result = await telegramService.verifyConnection();
        if (result.success) {
            await telegramService.sendMessage('\u2705 GoldForge Telegram notification test successful!');
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/telegram/verify', async (req, res) => {
    try {
        const result = await telegramService.verifyConnection();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/telegram/status', (req, res) => {
    res.json(telegramService.getStatus());
});

// Fallback to serve React's index.html for client-side routing
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

const PORT = process.env.PORT || 5002;

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

const server_instance = server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🥇 GoldForge — XAU/USD Trading Bot Server Started`);
    console.log(`Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
    console.log(`Port: ${PORT}`);
    console.log(`Price Feed: Binance XAUUSDT WebSocket (Real-time)`);
    console.log(`Lot Size: FIXED 0.01 lot (~1 oz)`);
    console.log(`Session: 07:00-17:00 UTC (12:30 PM-10:30 PM IST)`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Telegram Service: ${telegramService.configured ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Verify Telegram connection on startup
    if (telegramService.configured) {
        telegramService.verifyConnection().then((result) => {
            if (result.success) {
                console.log(`[TELEGRAM] ${result.message}`);
            } else {
                console.error(`[TELEGRAM] Verification failed: ${result.error}`);
            }
        }).catch(() => {});
    }

    // Auto-start the trading bot
    if (process.env.BOT_ENABLED !== 'false') {
        setTimeout(() => {
            console.log('[AUTO-START] Starting XAU/USD trading bot for 24-hour operation...');
            tradingBot.start();
            console.log('[AUTO-START] Gold trading bot is now running!');
            
            const startupMsg = `GoldForge Bot Started\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\nSession: 07:00-17:00 UTC\nLot Size: Fixed 0.01 lot`;
            telegramService.sendMessage(`\u{1F680} ${startupMsg}`);
        }, 2000);
    }

    // Keep-alive self-ping
    if (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE === 'true') {
        const pingUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        setInterval(() => {
            fetch(`${pingUrl}/api/price`).catch(() => {});
        }, 14 * 60 * 1000);
        console.log('[KEEP-ALIVE] Self-ping enabled (every 14 min)');
    }
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
    console.log(`\n[SHUTDOWN] ${signal} received — shutting down gracefully...`);
    tradingBot.stop();
    server_instance.close(() => {
        console.log('[SHUTDOWN] Server closed');
        process.exit(0);
    });
    setTimeout(() => {
        console.error('[SHUTDOWN] Forced exit due to timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

module.exports = { app, server, wss };
