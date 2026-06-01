const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('telegram-bot-api');
const dotenv = require('dotenv');

dotenv.config();

class ExecutionEngine {
    constructor(db) {
        this.db = db;
        this.FIXED_QUANTITY = 0.01; // Fixed lot — never changes

        // Initialize Telegram bot (placeholder)
        this.bot = null;
        if (process.env.TELEGRAM_BOT_TOKEN) {
            try {
                this.bot = new TelegramBot({ token: process.env.TELEGRAM_BOT_TOKEN });
                console.log('Telegram bot initialized');
            } catch (error) {
                console.error('Error initializing Telegram bot:', error);
            }
        }

        // Active trades tracking
        this.activeTrades = new Map();
    }

    /**
     * Load open trades from database into memory
     */
    async loadOpenTrades() {
        return new Promise((resolve, reject) => {
            this.db.all("SELECT * FROM trades WHERE status = 'OPEN'", [], (err, rows) => {
                if (err) {
                    console.error('Error loading open trades:', err);
                    reject(err);
                } else {
                    rows.forEach(row => {
                        this.activeTrades.set(row.id, {
                            ...row,
                            timestamp: new Date(row.timestamp)
                        });
                    });
                    console.log(`Loaded ${rows.length} open XAU/USD trades into memory.`);
                    resolve(rows);
                }
            });
        });
    }

    /**
     * Execute a trade based on signal — always uses fixed 0.01 lot
     * @param {Object} signal - Trading signal from decision engine
     * @param {number} quantity - Ignored, always uses FIXED_QUANTITY
     * @param {string} userId - User ID for the trade
     * @returns {Promise<Object>} Execution result
     */
    async executeTrade(signal, quantity = 0.01, userId = 'default') {
        const { action, price } = signal;

        if (action === 'SKIP') {
            return { success: false, reason: 'Signal was to skip trade' };
        }

        // Check user's active trades (only 1 active trade at a time)
        const userTrades = Array.from(this.activeTrades.values()).filter(t => t.userId === userId);
        if (userTrades.length >= 1) {
            return { success: false, reason: 'Maximum active trades reached (1 trade allowed)' };
        }

        const entryPrice = price || 2400;
        const timestamp = new Date();
        const tradeQuantity = this.FIXED_QUANTITY; // Always 0.01

        // Use dynamic SL/TP from the signal
        let sl = signal.sl || (action === 'BUY' ? entryPrice - 10 : entryPrice + 10);
        const tp1 = signal.tp1 || (action === 'BUY' ? entryPrice + 30 : entryPrice - 30);
        const score = signal.score || 0;
        const notes = signal.notes || '';

        // Enforce max 10% loss rule (tiered doubling)
        const balanceRow = await new Promise((res) => {
            this.db.get("SELECT usd_balance FROM balance WHERE userId = ? ORDER BY timestamp DESC LIMIT 1", [userId], (err, row) => res(row));
        });
        const currentBalance = balanceRow && balanceRow.usd_balance ? balanceRow.usd_balance : 50;
        let base = 50;
        while (base * 2 <= currentBalance) base *= 2;
        const maxLoss = base * 0.10;

        const CONTRACT_SIZE = 100;
        const positionSize = tradeQuantity * CONTRACT_SIZE;
        const maxSlPoints = maxLoss / positionSize;

        const currentSlDistance = Math.abs(entryPrice - sl);
        if (currentSlDistance > maxSlPoints) {
            sl = action === 'BUY' ? entryPrice - maxSlPoints : entryPrice + maxSlPoints;
        }

        return new Promise((resolve) => {
            const self = this;
            this.db.run(
                `INSERT INTO trades (userId, action, entry_price, quantity, timestamp, status, sl, tp1, score, notes, trade_type) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paper')`,
                [userId, action, entryPrice, tradeQuantity, timestamp.toISOString(), 'OPEN', sl, tp1, score, notes],
                function (err) {
                    if (err) {
                        console.error('Error logging trade to database:', err);
                        resolve({ success: false, error: err.message });
                        return;
                    }
                    
                    const tradeId = this.lastID;
                    const trade = {
                        id: tradeId,
                        userId,
                        action,
                        entry_price: entryPrice,
                        quantity: tradeQuantity,
                        timestamp,
                        status: 'OPEN',
                        sl, tp1, score, notes
                    };

                    self.activeTrades.set(tradeId, trade);

                    self._sendAlert(`[${userId}] Gold trade executed: ${action} ${tradeQuantity} oz XAU at $${entryPrice.toFixed(2)}`);

                    resolve({
                        success: true,
                        trade: trade,
                        message: `Trade executed: ${action} ${tradeQuantity} oz Gold at $${entryPrice.toFixed(2)}`
                    });
                }
            );
        });
    }

    /**
     * Monitor active trades for SL/TP hits
     * @param {number} currentPrice - Current market price
     */
    monitorTrades(currentPrice) {
        for (const [tradeId, trade] of this.activeTrades.entries()) {
            if (trade.status !== 'OPEN') continue;

            let exitPrice = null;
            let exitReason = '';

            // === TRAILING STOP LOSS LOGIC (tuned for gold) ===
            const CONTRACT_SIZE = 100;
            const positionSize = trade.quantity * CONTRACT_SIZE;

            if (trade.action === 'BUY') {
                const unrealizedPnl = (currentPrice - trade.entry_price) * positionSize;
                
                // Trail SL as profit grows (gold thresholds: 2R, 3.5R, 5R)
                if (unrealizedPnl > 0.15 * 5) {
                    const trailed = trade.entry_price + (currentPrice - trade.entry_price) * 0.8;
                    trade.sl = Math.max(trade.sl, trailed);
                } else if (unrealizedPnl > 0.15 * 3.5) {
                    const trailed = trade.entry_price + (currentPrice - trade.entry_price) * 0.6;
                    trade.sl = Math.max(trade.sl, trailed);
                } else if (unrealizedPnl > 0.15 * 2) {
                    const breakevenPlus = trade.entry_price + (currentPrice - trade.entry_price) * 0.1;
                    trade.sl = Math.max(trade.sl, breakevenPlus);
                }

                if (currentPrice <= trade.sl) {
                    exitPrice = trade.sl;
                    exitReason = trade.sl >= trade.entry_price ? 'Trailing SL (Breakeven+)' : 'Stop Loss';
                } else if (currentPrice >= trade.tp1) {
                    exitPrice = currentPrice;
                    exitReason = 'Take Profit (Max)';
                }
            } else if (trade.action === 'SELL') {
                const unrealizedPnl = (trade.entry_price - currentPrice) * positionSize;
                
                if (unrealizedPnl > 0.15 * 5) {
                    const trailed = trade.entry_price - (trade.entry_price - currentPrice) * 0.8;
                    trade.sl = Math.min(trade.sl, trailed);
                } else if (unrealizedPnl > 0.15 * 3.5) {
                    const trailed = trade.entry_price - (trade.entry_price - currentPrice) * 0.6;
                    trade.sl = Math.min(trade.sl, trailed);
                } else if (unrealizedPnl > 0.15 * 2) {
                    const breakevenPlus = trade.entry_price - (trade.entry_price - currentPrice) * 0.1;
                    trade.sl = Math.min(trade.sl, breakevenPlus);
                }

                if (currentPrice >= trade.sl) {
                    exitPrice = trade.sl;
                    exitReason = trade.sl <= trade.entry_price ? 'Trailing SL (Breakeven+)' : 'Stop Loss';
                } else if (currentPrice <= trade.tp1) {
                    exitPrice = currentPrice;
                    exitReason = 'Take Profit (Max)';
                }
            }

            if (exitPrice !== null) {
                this._closeTrade(tradeId, exitPrice, exitReason);
            }
        }
    }

    /**
     * Close a trade and calculate PnL
     */
    _closeTrade(tradeId, exitPrice, reason) {
        const trade = this.activeTrades.get(tradeId);
        if (!trade) return { success: false, reason: 'Trade not in memory' };

        const CONTRACT_SIZE = 100;
        const positionSize = trade.quantity * CONTRACT_SIZE;
        
        let pnl = 0;
        if (trade.action === 'BUY') {
            pnl = (exitPrice - trade.entry_price) * positionSize;
        } else {
            pnl = (trade.entry_price - exitPrice) * positionSize;
        }

        trade.exit_price = exitPrice;
        trade.pnl = pnl;
        trade.status = 'CLOSED';
        trade.exit_reason = reason;
        trade.exit_timestamp = new Date();

        const userId = trade.userId || 'default';

        this.db.run(
            `UPDATE trades SET 
             exit_price = ?, 
             pnl = ?, 
             status = ?, 
             exit_reason = ?, 
             exit_timestamp = ?
             WHERE id = ?`,
            [exitPrice, pnl, 'CLOSED', reason, new Date().toISOString(), tradeId],
            (err) => {
                if (err) {
                    console.error('Error updating trade in database:', err);
                } else {
                    this.db.get(`SELECT * FROM balance WHERE userId = ? ORDER BY timestamp DESC LIMIT 1`, [userId], (err, balance) => {
                        if (!err && balance) {
                            const newBalance = balance.usd_balance + pnl;
                            this.db.run(`INSERT INTO balance (userId, usd_balance, xau_balance) VALUES (?, ?, ?)`, 
                                [userId, newBalance, balance.xau_balance]);
                        } else if (!err && !balance) {
                            const initialBalance = 50 + pnl;
                            this.db.run(`INSERT INTO balance (userId, usd_balance, xau_balance) VALUES (?, ?, ?)`, 
                                [userId, initialBalance, 0]);
                        }
                    });
                }
            }
        );

        this.activeTrades.delete(tradeId);

        console.log(`Gold trade closed: ${trade.action} ${trade.quantity} oz XAU at $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}. Reason: ${reason}`);

        if (this.onTradeClosed) {
            this.onTradeClosed(trade);
        }

        this._sendAlert(`Gold trade closed: ${trade.action} ${trade.quantity} oz XAU at $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}. Reason: ${reason}`);

        return { success: true, trade, pnl, reason };
    }

    getTrades(limit = 50) {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`, [limit], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    getActiveTrades() {
        return Array.from(this.activeTrades.values());
    }

    async _sendAlert(message) {
        console.log(`ALERT: ${message}`);
        
        if (this.bot && process.env.TELEGRAM_CHAT_ID) {
            try {
                await this.bot.sendMessage({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message });
            } catch (error) {
                console.error('Telegram error:', error);
            }
        }

        const EmailService = require('./emailService');
        if (EmailService && (process.env.EMAIL_RECIPIENT || process.env.NOTIFY_EMAIL)) {
            try {
                const trade = {
                    action: message.includes('BUY') ? 'BUY' : (message.includes('SELL') ? 'SELL' : 'INFO'),
                    entry_price: null,
                    quantity: 0.01,
                    timestamp: new Date()
                };
                await EmailService.sendTradeNotification(trade, message);
            } catch (error) {
                console.error('Email error:', error);
            }
        }
    }

    async manualExitTrade(tradeId, exitPrice) {
        if (!this.activeTrades.has(tradeId)) {
            return new Promise((resolve) => {
                this.db.get("SELECT * FROM trades WHERE id = ? AND status = 'OPEN'", [tradeId], (err, row) => {
                    if (err || !row) {
                        resolve({ success: false, reason: 'Trade not found or already closed' });
                    } else {
                        const trade = { ...row, timestamp: new Date(row.timestamp) };
                        this.activeTrades.set(tradeId, trade);
                        resolve(this._closeTrade(tradeId, exitPrice, 'Manual Exit'));
                    }
                });
            });
        }
        return this._closeTrade(tradeId, exitPrice, 'Manual Exit');
    }
}

module.exports = ExecutionEngine;
