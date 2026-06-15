const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('telegram-bot-api');
const dotenv = require('dotenv');
const UnifiedStrategy = require('./unifiedStrategy');

dotenv.config();

class ExecutionEngine {
    constructor(db) {
        this.db = db;
        this.FIXED_QUANTITY = 0.01; // Fixed lot — never changes
        this.strategy = new UnifiedStrategy(); // Single source of truth for trailing stop + exit logic

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
                            entryPrice: row.entry_price, // alias for UnifiedStrategy compatibility
                            originalSl: row.original_sl || row.sl,
                            atr: row.atr || 15, // fallback ATR for gold 6H
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
        let originalSl = sl;
        let tp1 = signal.tp1 || (action === 'BUY' ? entryPrice + 30 : entryPrice - 30);
        let tp2 = signal.tp2 || (action === 'BUY' ? entryPrice + 50 : entryPrice - 50);
        const atr = signal.atr || 15; // ATR from analysis — critical for trailing stop
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
            originalSl = sl;

            const cappedSlDistance = Math.abs(entryPrice - sl);
            tp1 = action === 'BUY'
                ? entryPrice + (cappedSlDistance * this.strategy.TP1_RR)
                : entryPrice - (cappedSlDistance * this.strategy.TP1_RR);
            tp2 = action === 'BUY'
                ? entryPrice + (cappedSlDistance * this.strategy.TP2_RR)
                : entryPrice - (cappedSlDistance * this.strategy.TP2_RR);
        }

        return new Promise((resolve) => {
            const self = this;
            this.db.run(
                `INSERT INTO trades (userId, action, entry_price, quantity, timestamp, status, sl, tp1, tp2, score, notes, trade_type, atr, original_sl)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paper', ?, ?)`,
                [userId, action, entryPrice, tradeQuantity, timestamp.toISOString(), 'OPEN', sl, tp1, tp2, score, notes, atr, originalSl],
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
                        entryPrice: entryPrice, // alias for UnifiedStrategy compatibility
                        quantity: tradeQuantity,
                        timestamp,
                        status: 'OPEN',
                        sl, originalSl, tp1, tp2, atr, score, notes
                    };

                    self.activeTrades.set(tradeId, trade);

                    self._sendAlert(`[${userId}] Gold trade executed: ${action} ${tradeQuantity} oz XAU at $${entryPrice.toFixed(2)} | SL: $${sl.toFixed(2)} | TP1: $${tp1.toFixed(2)} | TP2: $${tp2.toFixed(2)} | ATR: $${atr.toFixed(2)}`);

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
     * Monitor active trades for SL/TP hits.
     * UNIFIED: Delegates to UnifiedStrategy.checkTradeExit() — same logic as backtest.
     * @param {number} currentPrice - Current market price
     */
    monitorTrades(currentPrice) {
        for (const [tradeId, trade] of this.activeTrades.entries()) {
            if (trade.status !== 'OPEN') continue;

            // Build a synthetic candle from the tick price for UnifiedStrategy compatibility
            const entryPrice = trade.entry_price || trade.entryPrice;
            const currentCandle = {
                open: currentPrice,
                high: currentPrice,
                low: currentPrice,
                close: currentPrice,
                price: currentPrice
            };

            // Normalize trade object for UnifiedStrategy (it expects entryPrice, not entry_price)
            const strategyTrade = {
                action: trade.action,
                entryPrice: entryPrice,
                quantity: trade.quantity,
                sl: trade.sl,
                originalSl: trade.originalSl || trade.original_sl || trade.sl,
                tp1: trade.tp1,
                tp2: trade.tp2,
                atr: trade.atr || 15 // Fallback ATR for gold 6H
            };

            // Use the SAME trailing stop + exit logic as the backtest
            const previousSl = trade.sl;
            const exitResult = this.strategy.checkTradeExit(strategyTrade, currentCandle);

            // Sync the (possibly trailed) SL back to the live trade
            trade.sl = strategyTrade.sl;
            if (Math.abs((previousSl || 0) - strategyTrade.sl) > 0.000001 && !exitResult.closed) {
                this.db.run(
                    `UPDATE trades SET sl = ? WHERE id = ? AND status = 'OPEN'`,
                    [strategyTrade.sl, tradeId],
                    (err) => { if (err) console.error('Error persisting trailing SL:', err); }
                );
            }

            if (exitResult.closed) {
                this._closeTrade(tradeId, exitResult.exitPrice, exitResult.exitReason);
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
             exit_timestamp = ?,
             sl = ?
             WHERE id = ?`,
            [exitPrice, pnl, 'CLOSED', reason, new Date().toISOString(), trade.sl, tradeId],
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
