const dotenv = require('dotenv');
const UnifiedStrategy = require('./unifiedStrategyV3');

dotenv.config();

class ExecutionEngine {
    constructor(db, config = {}) {
        this.db = db;
        this.FIXED_QUANTITY = Number(process.env.XAU_QUANTITY) || 0.01;
        this.MAX_LOSS_PERCENT = Number(process.env.MAX_LOSS_PERCENT) || 10;
        this.MAX_POSITION_LOTS = Number(process.env.MAX_POSITION_LOTS) || 0.1;
        this.strategy = new UnifiedStrategy({
            tp1ClosePercent: config.tp1ClosePercent ?? (Number(process.env.TP1_CLOSE_PERCENT) || 50),
            maxSlDistance: config.maxSlDistance ?? (Number(process.env.MAX_SL_DISTANCE) || 15),
            confluenceThreshold: config.confluenceThreshold ?? (Number(process.env.CONFLUENCE_THRESHOLD) || 5.5),
            interval: config.interval ?? 360,
        });

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
                            remainingQuantity: row.remaining_quantity ?? row.quantity,
                            realizedPnl: row.realized_pnl ?? 0,
                            tp1Hit: Boolean(row.tp1_hit),
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
    async executeTrade(signal, quantity = 0.01, userId = 'default', allowMultiple = false) {
        const { action, price } = signal;

        if (action === 'SKIP') {
            return { success: false, reason: 'Signal was to skip trade' };
        }

        // Check user's active trades (skip for manual trades)
        if (!allowMultiple) {
            const userTrades = Array.from(this.activeTrades.values()).filter(t => t.userId === userId);
            if (userTrades.length >= 1) {
                return { success: false, reason: 'Maximum active trades reached (1 trade allowed)' };
            }
        }

        const entryPrice = price;
        if (!entryPrice || !Number.isFinite(entryPrice)) {
            return { success: false, reason: 'No valid price available for trade execution' };
        }
        const timestamp = new Date();
        // Use dynamic SL/TP from the signal
        let sl = signal.sl || (action === 'BUY' ? entryPrice - 10 : entryPrice + 10);
        let originalSl = sl;
        let tp1 = signal.tp1 || (action === 'BUY' ? entryPrice + 30 : entryPrice - 30);
        let tp2 = signal.tp2 || (action === 'BUY' ? entryPrice + 50 : entryPrice - 50);
        const atr = signal.atr || 15; // ATR from analysis — critical for trailing stop
        const score = signal.score || 0;
        const notes = signal.notes || '';

        // Risk-based position sizing (tiered doubling)
        const balanceRow = await new Promise((res) => {
            this.db.get("SELECT usd_balance FROM balance WHERE userId = ? ORDER BY timestamp DESC LIMIT 1", [userId], (err, row) => res(row));
        });
        const currentBalance = balanceRow && balanceRow.usd_balance ? balanceRow.usd_balance : 50;
        let base = 50;
        while (base * 2 <= currentBalance) base *= 2;
        const riskAmount = Math.max(1, base * (this.MAX_LOSS_PERCENT / 100));
        const CONTRACT_SIZE = 100;
        const slDistance = Math.abs(entryPrice - sl);
        const tradeQuantity = slDistance > 0
            ? Math.max(0.01, Math.min(this.MAX_POSITION_LOTS, Math.round((riskAmount / (slDistance * CONTRACT_SIZE)) * 100) / 100))
            : this.FIXED_QUANTITY;

        return new Promise((resolve) => {
            const self = this;
            this.db.run(
                `INSERT INTO trades (userId, action, entry_price, quantity, timestamp, status, sl, tp1, tp2, score, notes, trade_type, atr, original_sl, remaining_quantity, realized_pnl, tp1_hit)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paper', ?, ?, ?, ?, ?)`,
                [userId, action, entryPrice, tradeQuantity, timestamp.toISOString(), 'OPEN', sl, tp1, tp2, score, notes, atr, originalSl, tradeQuantity, 0, 0],
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
                        sl, originalSl, tp1, tp2, atr, score, notes,
                        remainingQuantity: tradeQuantity,
                        realizedPnl: 0,
                        tp1Hit: false
                    };

                    self.activeTrades.set(tradeId, trade);

                    self._sendAlert(`[${userId}] Gold trade executed: ${action} ${tradeQuantity} lot XAU (~1 oz) at $${entryPrice.toFixed(2)} | SL: $${sl.toFixed(2)} | TP1: $${tp1.toFixed(2)} | TP2: $${tp2.toFixed(2)} | ATR: $${atr.toFixed(2)}`);

                    resolve({
                        success: true,
                        trade: trade,
                        message: `Trade executed: ${action} ${tradeQuantity} lot Gold (~1 oz) at $${entryPrice.toFixed(2)}`
                    });
                }
            );
        });
    }

    /**
     * Monitor active trades for SL/TP hits.
     * UNIFIED: Delegates to UnifiedStrategy.checkTradeExit() — same logic as backtest.
     * @param {number} currentPrice - Current market price
     * @param {Object|null} currentCandle - Real OHLC candle { open, high, low, close, timestamp }
     */
    monitorTrades(currentPrice, currentCandle = null) {
        for (const [tradeId, trade] of this.activeTrades.entries()) {
            if (trade.status !== 'OPEN') continue;

            // Use real OHLC candle when available; fall back to synthetic tick candle
            const candle = currentCandle || {
                open: currentPrice,
                high: currentPrice,
                low: currentPrice,
                close: currentPrice,
                price: currentPrice,
            };

            // Normalize trade object for UnifiedStrategy (it expects entryPrice, not entry_price)
            const entryPrice = trade.entry_price || trade.entryPrice;
            const strategyTrade = {
                action: trade.action,
                entryPrice: entryPrice,
                quantity: trade.quantity,
                sl: trade.sl,
                originalSl: trade.originalSl || trade.original_sl || trade.sl,
                tp1: trade.tp1,
                tp2: trade.tp2,
                remainingQuantity: trade.remainingQuantity ?? trade.remaining_quantity ?? trade.quantity,
                realizedPnl: trade.realizedPnl ?? trade.realized_pnl ?? 0,
                tp1Hit: trade.tp1Hit || Boolean(trade.tp1_hit),
                atr: trade.atr || 15 // Fallback ATR for gold 6H
            };

            // Use the SAME trailing stop + exit logic as the backtest
            const previousSl = trade.sl;
            const exitResult = this.strategy.checkTradeExit(strategyTrade, candle);

            // Sync the (possibly trailed) SL back to the live trade
            trade.sl = strategyTrade.sl;
            trade.remainingQuantity = strategyTrade.remainingQuantity;
            trade.remaining_quantity = strategyTrade.remainingQuantity;
            trade.realizedPnl = strategyTrade.realizedPnl;
            trade.realized_pnl = strategyTrade.realizedPnl;
            trade.tp1Hit = strategyTrade.tp1Hit;
            trade.tp1_hit = strategyTrade.tp1Hit ? 1 : 0;

            if (exitResult.partial || (Math.abs((previousSl || 0) - strategyTrade.sl) > 0.000001 && !exitResult.closed)) {
                this.db.run(
                    `UPDATE trades SET sl = ?, remaining_quantity = ?, realized_pnl = ?, tp1_hit = ? WHERE id = ? AND status = 'OPEN'`,
                    [strategyTrade.sl, strategyTrade.remainingQuantity, strategyTrade.realizedPnl, strategyTrade.tp1Hit ? 1 : 0, tradeId],
                    (err) => { if (err) console.error('Error persisting trade management state:', err); }
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
        const remainingQuantity = trade.remainingQuantity ?? trade.remaining_quantity ?? trade.quantity;
        const positionSize = remainingQuantity * CONTRACT_SIZE;
        const realizedPnl = trade.realizedPnl ?? trade.realized_pnl ?? 0;
        
        let pnl = 0;
        if (trade.action === 'BUY') {
            pnl = realizedPnl + ((exitPrice - trade.entry_price) * positionSize);
        } else {
            pnl = realizedPnl + ((trade.entry_price - exitPrice) * positionSize);
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
             sl = ?,
             remaining_quantity = ?,
             realized_pnl = ?,
             tp1_hit = ?
             WHERE id = ?`,
            [exitPrice, pnl, 'CLOSED', reason, new Date().toISOString(), trade.sl, 0, realizedPnl, trade.tp1Hit || trade.tp1_hit ? 1 : 0, tradeId],
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

        console.log(`Gold trade closed: ${trade.action} ${trade.quantity} lot XAU at $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}. Reason: ${reason}`);

        if (this.onTradeClosed) {
            this.onTradeClosed(trade);
        }

        this._sendAlert(`Gold trade closed: ${trade.action} ${trade.quantity} lot XAU at $${exitPrice.toFixed(2)}. PnL: $${pnl.toFixed(2)}. Reason: ${reason}`);

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
        
        const telegramService = require('./telegramService');
        telegramService.sendMessage(message).catch(() => {});


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

    async manualPartialClose(tradeId, exitPrice, closePercent) {
        let trade = this.activeTrades.get(tradeId);

        if (!trade) {
            trade = await new Promise((resolve) => {
                this.db.get("SELECT * FROM trades WHERE id = ? AND status = 'OPEN'", [tradeId], (err, row) => {
                    if (err || !row) resolve(null);
                    else {
                        const t = { ...row, timestamp: new Date(row.timestamp) };
                        this.activeTrades.set(tradeId, t);
                        resolve(t);
                    }
                });
            });
        }

        if (!trade) return { success: false, reason: 'Trade not found or already closed' };

        const CONTRACT_SIZE = 100;
        const totalQuantity = trade.quantity;
        const currentRemaining = trade.remainingQuantity ?? trade.remaining_quantity ?? totalQuantity;
        const closeQty = currentRemaining * (closePercent / 100);

        if (closeQty <= 0) return { success: false, reason: 'Nothing to close' };

        const positionSize = closeQty * CONTRACT_SIZE;
        const realizedPnl = trade.realizedPnl ?? trade.realized_pnl ?? 0;
        let pnl = 0;
        if (trade.action === 'BUY') {
            pnl = realizedPnl + ((exitPrice - trade.entry_price) * positionSize);
        } else {
            pnl = realizedPnl + ((trade.entry_price - exitPrice) * positionSize);
        }

        const newRemaining = Math.max(0, currentRemaining - closeQty);
        const tp1Hit = trade.tp1Hit || trade.tp1_hit;

        if (newRemaining <= 0) {
            return this._closeTrade(tradeId, exitPrice, 'Manual Partial Close (100%)');
        }

        trade.realizedPnl = pnl;
        trade.remainingQuantity = newRemaining;
        trade.remaining_quantity = newRemaining;

        this.db.run(
            `UPDATE trades SET remaining_quantity = ?, realized_pnl = ?, tp1_hit = ? WHERE id = ?`,
            [newRemaining, pnl, tp1Hit ? 1 : 0, tradeId],
            (err) => {
                if (err) console.error('Error updating partial close:', err);
            }
        );

        console.log(`Partial close: ${trade.action} ${closeQty.toFixed(4)} lot XAU at $${exitPrice.toFixed(2)}. Remaining: ${newRemaining.toFixed(4)} lot. PnL: $${pnl.toFixed(2)}`);

        this._sendAlert(`Partial close: ${trade.action} ${closeQty.toFixed(4)} lot XAU at $${exitPrice.toFixed(2)}. Remaining: ${newRemaining.toFixed(4)} lot. PnL: $${pnl.toFixed(2)}`);

        return { success: true, trade, pnl, remainingQuantity: newRemaining, closeQty, reason: 'Manual Partial Close' };
    }
}

module.exports = ExecutionEngine;
