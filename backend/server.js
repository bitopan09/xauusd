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
// BYBIT WEBSOCKET — Real-time XAU/USD Price Feed (NO DELAY)
// Connects to Bybit's public linear perpetual WebSocket
// for XAUUSDT ticker updates in real-time.
// ============================================================
const connectBybitWebSocket = () => {
    const bybitWs = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    let lastDbInsert = Date.now();
    let pingInterval;

    bybitWs.on('open', () => {
        console.log('✅ Connected to Bybit WebSocket — Real-time XAU/USD feed active');
        
        // Subscribe to XAUUSDT ticker for real-time last price
        bybitWs.send(JSON.stringify({
            op: 'subscribe',
            args: ['tickers.XAUUSDT']
        }));

        // Bybit requires ping every 20 seconds to keep connection alive
        pingInterval = setInterval(() => {
            if (bybitWs.readyState === WebSocket.OPEN) {
                bybitWs.send(JSON.stringify({ op: 'ping' }));
            }
        }, 20000);
    });

    bybitWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            // Skip pong responses, subscription confirmations, and non-ticker messages
            if (msg.op === 'pong' || msg.op === 'subscribe' || msg.success !== undefined) return;
            if (!msg.topic || msg.topic !== 'tickers.XAUUSDT' || !msg.data) return;

            const price = parseFloat(msg.data.lastPrice);
            if (!price || isNaN(price)) return;

            const volume = parseFloat(msg.data.volume24h || 0);
            const timestamp = new Date(parseInt(msg.ts || Date.now())).toISOString();
            
            const priceData = {
                symbol: 'XAUUSD',
                price: price,
                volume: volume,
                timestamp: timestamp
            };

            // Broadcast to all connected frontend clients in real-time
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN && client !== bybitWs) {
                    client.send(JSON.stringify({
                        type: 'price',
                        data: priceData
                    }));
                }
            });

            // Throttle database inserts to every 1 second
            if (Date.now() - lastDbInsert >= 1000) {
                db.run(
                    `INSERT INTO prices (symbol, price, volume) VALUES (?, ?, ?)`,
                    ['XAUUSD', price, volume],
                    (err) => { if (err) console.error('Error inserting gold price:', err); }
                );
                lastDbInsert = Date.now();
            }
        } catch (err) {
            // Silently ignore parse errors for non-JSON messages (like pong)
        }
    });

    bybitWs.on('close', () => {
        console.log('Bybit WebSocket closed, reconnecting in 3s...');
        if (pingInterval) clearInterval(pingInterval);
        setTimeout(connectBybitWebSocket, 3000);
    });

    bybitWs.on('error', (err) => {
        console.error('Bybit WebSocket error:', err.message);
    });
};

connectBybitWebSocket();

// REST API endpoints
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.get('/api/price', (req, res) => {
    db.get(`SELECT * FROM prices ORDER BY timestamp DESC LIMIT 1`, [], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(row || {});
    });
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

// Frontend pushes Bybit candle data so the live bot can analyze
// even when Bybit REST API is blocked on Railway
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

        // Parse raw Bybit candle format to the structure the bot expects
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

        // Feed candle data to the bot for analysis
        tradingBot.setPriceData(priceData, 'client_browser');
        await tradingBot._analyzeAndTrade();

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

// Manual Trading — always uses fixed 0.01 lot
app.post('/api/manual-trade', async (req, res) => {
    try {
        const { action, quantity, userId } = req.body;
        const user = userId || 'default';
        
        db.get('SELECT price FROM prices ORDER BY timestamp DESC LIMIT 1', async (err, row) => {
            if (err || !row) {
                return res.status(500).json({ error: 'Could not get current gold price' });
            }
            
            const signal = { action: action.toUpperCase(), price: row.price };
            const result = await tradingBot.executionEngine.executeTrade(signal, 0.01, user, true);
            
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

// CSV Export
app.get('/api/trades/export', (req, res) => {
    const userId = req.query.userId || 'default';
    db.all(`SELECT * FROM trades WHERE userId = ? OR userId = 'default' ORDER BY timestamp DESC`, [userId], (err, rows) => {
        if (err) return res.status(500).send('Error fetching trades');
        if (rows.length === 0) return res.status(404).send('No trades to export');
        
        const headers = ['ID', 'Date', 'Action', 'Entry Price', 'Exit Price', 'Quantity (lots)', 'Stop Loss', 'Take Profit 1', 'Take Profit 2', 'Status', 'P&L', 'Notes'];
        let csv = headers.join(',') + '\n';
        
        rows.forEach(row => {
            const cols = [
                row.id, row.timestamp, row.action,
                row.entry_price || '', row.exit_price || '',
                row.quantity || '', row.sl || '',
                row.tp1 || '', row.tp2 || '',
                row.status || '', row.pnl || '',
                (row.notes || '').replace(/,/g, ' ')
            ];
            csv += cols.join(',') + '\n';
        });
        
        res.setHeader('Content-Type', 'text/csv');
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
    console.log(`Price Feed: Bybit XAUUSDT WebSocket (Real-time)`);
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
