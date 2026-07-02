/**
 * BROKER SIMULATION MODULE — XAU/USD
 *
 * Models realistic broker costs and fill behavior for backtesting.
 * Centralizes spread, slippage, commission, and swap logic.
 *
 * Spread model (based on IC Markets / OANDA research):
 *   - ECN: 10-15 pts (London/NY), 20-30 pts (Asia), 50-100+ pts (news)
 *   - Standard: 25-40 pts base, 50-100+ pts Asia/news
 *
 * Slippage: 0.5-1 pip base, scaled by volatility and position size.
 * Commission: $7/lot round-turn (ECN), $0 (Standard — baked into spread).
 * Swap: daily carry ~$5-15/lot for gold (long-positive, short-negative).
 */

class BrokerSimulation {
    constructor(config = {}) {
        this.accountType = config.accountType || 'standard'; // 'ecn' or 'standard' — OctaFX is standard
        this.slippageModel = config.slippageModel || 'normal'; // 'normal', 'conservative', 'aggressive'

        // Spread in points (1 point = $0.01 on XAU/USD)
        this.POINT_VALUE = 0.01; // 1 point = $0.01 (must match XAU/USD pip/point convention)
        this.baseSpread = config.baseSpread || 40; // OctaFX XAU/USD: 4.0 pips × 10 points/pip = 40 points
        this.spreadMultiplier = config.spreadMultiplier || {
            sessionDefault: 1.0,
            london: 0.9,       // Tighter during London
            newYork: 0.9,      // Tighter during NY
            overlap: 0.85,     // Tightest during London-NY overlap
            asia: 1.5,         // Wider during Asia
            preMarket: 1.3,    // Wider before session open
            news: 3.0,         // Spike during news
        };

        // Slippage in points — OctaFX: 4.2 pips × 10 = 42 points
        this.baseSlippage = config.baseSlippage || 42; // User-reported OctaFX slippage (4.2 pips)
        this.maxSlippage = config.maxSlippage || 60;

        // Commission in USD per lot round-turn — OctaFX standard account has NO commission
        this.commissionPerLot = config.commissionPerLot || 0.0;

        // Swap in USD per lot per day
        this.swapLongPerLot = config.swapLongPerLot || 8.5;
        this.swapShortPerLot = config.swapShortPerLot || -12.5;

        // Contract size for XAU/USD
        this.contractSize = 100;
    }

    /**
     * Safely convert any timestamp to a Date object.
     * Handles Date objects, ISO strings, and epoch milliseconds.
     */
    static toDate(ts) {
        if (ts instanceof Date) return ts;
        if (typeof ts === 'number') return new Date(ts);
        return new Date(ts);
    }

    /**
     * Get the session name for a given UTC hour.
     * Sessions:
     *   Asia:  00:00 - 07:00 UTC
     *   London: 07:00 - 13:00 UTC
     *   Overlap: 13:00 - 16:00 UTC (London + New York)
     *   New York: 16:00 - 21:00 UTC
     *   Pre-Market: 05:00 - 07:00 UTC
     */
    getSession(utcHour, utcMinute = 0) {
        const time = utcHour + utcMinute / 60;
        if (time >= 0 && time < 5) return 'asia';
        if (time >= 5 && time < 7) return 'preMarket';
        if (time >= 7 && time < 13) return 'london';
        if (time >= 13 && time < 16) return 'overlap';
        if (time >= 16 && time < 21) return 'newYork';
        return 'offSession'; // 21:00 - 00:00
    }

    /**
     * Calculate the spread for a given candle.
     * @param {Object} candle - { timestamp, open, high, low, close, volume }
     * @param {Object} options - { isNewsEvent, atr, prevAtr }
     * @returns {number} Spread in price points (e.g., 12 = $0.12)
     */
    calculateSpread(candle, options = {}) {
        const ts = BrokerSimulation.toDate(candle.timestamp);
        const hour = ts.getUTCHours();
        const minute = ts.getUTCMinutes();
        const session = this.getSession(hour, minute);

        let spread = this.baseSpread;
        let sessionKey = session;

        // Apply session multiplier
        if (session === 'overlap') sessionKey = 'overlap';
        else if (session === 'london') sessionKey = 'london';
        else if (session === 'newYork') sessionKey = 'newYork';
        else if (session === 'asia') sessionKey = 'asia';
        else if (session === 'preMarket') sessionKey = 'preMarket';
        else sessionKey = 'sessionDefault';

        const mult = this.spreadMultiplier[sessionKey] || this.spreadMultiplier.sessionDefault;
        spread *= mult;

        // News event spread widening
        if (options.isNewsEvent) {
            spread *= this.spreadMultiplier.news;
        }

        // Volatility-based widening: if ATR spikes, widen spread
        if (options.atr && options.prevAtr && options.prevAtr > 0) {
            const volRatio = options.atr / options.prevAtr;
            if (volRatio > 1.5) {
                spread *= 1 + (volRatio - 1.5) * 0.5; // Up to 50% wider for 2x ATR
            }
        }

        return Math.round(spread * 10) / 10; // Round to 1 decimal
    }

    /**
     * Calculate slippage for a given order.
     * @param {Object} options - { side, candle, atr, quantity, session }
     * @returns {number} Slippage in price points (positive = adverse)
     */
    calculateSlippage(options = {}) {
        const { side, candle, atr, quantity = 0.01, session } = options;

        let slippage = this.baseSlippage;

        // Volatility scaling: higher ATR = more slippage
        if (atr && atr > 10) {
            const volFactor = Math.min((atr - 10) / 20, 1.5); // Cap at 1.5x
            slippage += volFactor * 0.5;
        }

        // Session-based: Asia and off-session have worse fills
        const sess = session || this.getSession(
            BrokerSimulation.toDate(candle.timestamp).getUTCHours(),
            BrokerSimulation.toDate(candle.timestamp).getUTCMinutes()
        );
        if (sess === 'asia' || sess === 'offSession') {
            slippage *= 2.0;
        } else if (sess === 'preMarket') {
            slippage *= 1.5;
        } else if (sess === 'overlap') {
            slippage *= 0.7; // Tightest during overlap
        }

        // Position size impact: larger positions have more slippage
        if (quantity >= 0.1) {
            slippage += 0.3;
        }
        if (quantity >= 1.0) {
            slippage += 0.5;
        }

        // Random component (seeded by candle timestamp for reproducibility)
        const seed = BrokerSimulation.toDate(candle.timestamp).getTime();
        const pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;
        const randomSlip = pseudoRandom * this.baseSlippage * 1.5;

        slippage += randomSlip;

        // Cap at maximum
        slippage = Math.min(slippage, this.maxSlippage);

        // Model selection
        if (this.slippageModel === 'conservative') {
            slippage *= 1.5;
        } else if (this.slippageModel === 'aggressive') {
            slippage *= 0.5;
        }

        return Math.round(slippage * 100) / 100;
    }

    /**
     * Calculate commission for a given trade.
     * @param {number} quantity - Lot size
     * @returns {number} Commission in USD
     */
    calculateCommission(quantity) {
        return this.commissionPerLot * quantity;
    }

    /**
     * Calculate swap (overnight financing) for a held position.
     * @param {string} side - 'BUY' or 'SELL'
     * @param {number} quantity - Lot size
     * @param {number} daysHeld - Number of days held (can be fractional for intraday)
     * @returns {number} Swap cost in USD (positive = cost)
     */
    calculateSwap(side, quantity, daysHeld) {
        if (daysHeld <= 0) return 0;
        const ratePerLot = side === 'BUY' ? this.swapLongPerLot : this.swapShortPerLot;
        return ratePerLot * quantity * daysHeld;
    }

    /**
     * Calculate realistic entry fill price for a new order.
     * Entry is at the NEXT candle's open (conservative), plus spread and slippage.
     *
     * @param {string} side - 'BUY' or 'SELL'
     * @param {Object} signalCandle - The candle where signal was generated
     * @param {Object} nextCandle - The NEXT candle (used for fill)
     * @param {Object} options - { atr, quantity, isNewsEvent }
     * @returns {Object} { fillPrice, spread, slippage, commission, totalCost }
     */
    calculateEntryFill(side, signalCandle, nextCandle, options = {}) {
        const spread = this.calculateSpread(signalCandle, {
            isNewsEvent: options.isNewsEvent,
            atr: options.atr,
        });

        const slippage = this.calculateSlippage({
            side,
            candle: signalCandle,
            atr: options.atr,
            quantity: options.quantity || 0.01,
        });

        const commission = this.calculateCommission(options.quantity || 0.01);

        // Fill at next candle open, adjusted for spread and slippage
        const basePrice = nextCandle.open;
        const pv = this.POINT_VALUE;
        let fillPrice;
        if (side === 'BUY') {
            fillPrice = basePrice + (spread / 2 + slippage) * pv; // BUY at ask
        } else {
            fillPrice = basePrice - (spread / 2 + slippage) * pv; // SELL at bid
        }

        return {
            fillPrice: Math.round(fillPrice * 100) / 100,
            spread,
            slippage,
            commission,
            totalCost: (spread + slippage) * pv * options.quantity * this.contractSize + commission,
        };
    }

    /**
     * Calculate realistic exit fill price.
     * Exit fills at the NEXT candle's open (conservative), minus spread and slippage.
     *
     * @param {string} side - 'BUY' or 'SELL' (original trade side)
     * @param {Object} exitCandle - The candle where exit is triggered
     * @param {Object} options - { atr, quantity, isNewsEvent }
     * @returns {Object} { fillPrice, spread, slippage, commission, totalCost }
     */
    calculateExitFill(side, exitCandle, options = {}) {
        const spread = this.calculateSpread(exitCandle, {
            isNewsEvent: options.isNewsEvent,
            atr: options.atr,
        });

        const slippage = this.calculateSlippage({
            side: side === 'BUY' ? 'SELL' : 'BUY', // Opposite side for exit
            candle: exitCandle,
            atr: options.atr,
            quantity: options.quantity || 0.01,
        });

        const commission = this.calculateCommission(options.quantity || 0.01);

        // Fill at candle open, adjusted for spread and slippage
        const pv = this.POINT_VALUE;
        const basePrice = exitCandle.open;
        let fillPrice;
        if (side === 'BUY') {
            // Closing a BUY = SELL at bid
            fillPrice = basePrice - (spread / 2 + slippage) * pv;
        } else {
            // Closing a SELL = BUY at ask
            fillPrice = basePrice + (spread / 2 + slippage) * pv;
        }

        return {
            fillPrice: Math.round(fillPrice * 100) / 100,
            spread,
            slippage,
            commission,
            totalCost: (spread + slippage) * pv * options.quantity * this.contractSize + commission,
        };
    }

    /**
     * Check if SL or TP was hit on a candle, using conservative fills.
     * Returns the FIRST event that would occur (SL-before-TP logic).
     *
     * @param {string} tradeSide - 'BUY' or 'SELL'
     * @param {Object} candle - { open, high, low, close }
     * @param {number} sl - Stop loss price
     * @param {number} tp1 - Take profit 1 price (nullable)
     * @param {number} tp2 - Take profit 2 price (nullable)
     * @param {Object} options - { atr, quantity }
     * @returns {Object} { hit, event, fillPrice } where event = 'SL', 'TP1', 'TP2', or null
     */
    checkExitEvents(tradeSide, candle, sl, tp1, tp2, options = {}) {
        const spread = this.calculateSpread(candle, { atr: options.atr });
        const halfSpread = spread / 2;
        const pv = this.POINT_VALUE;

        if (tradeSide === 'BUY') {
            // SL check: price drops to SL (bid side)
            const slTouched = candle.low <= sl;
            // TP check: price rises to TP (ask side)
            const tp1Touched = tp1 !== null && candle.high >= tp1;
            const tp2Touched = tp2 !== null && candle.high >= tp2;

            if (slTouched) {
                // SL was touched — conservative: fill at SL minus slippage
                const slippage = this.calculateSlippage({
                    side: 'SELL', candle,
                    atr: options.atr, quantity: options.quantity || 0.01,
                });
                // But also check if TP was hit before SL on same candle
                // Conservative: assume SL fills first (worst case)
                return {
                    hit: true,
                    event: 'SL',
                    fillPrice: sl - slippage * pv,
                };
            }
            if (tp1Touched) {
                const slippage = this.calculateSlippage({
                    side: 'SELL', candle,
                    atr: options.atr, quantity: options.quantity || 0.01,
                });
                return { hit: true, event: 'TP1', fillPrice: tp1 - slippage * pv };
            }
            if (tp2Touched) {
                const slippage = this.calculateSlippage({
                    side: 'SELL', candle,
                    atr: options.atr, quantity: options.quantity || 0.01,
                });
                return { hit: true, event: 'TP2', fillPrice: tp2 - slippage * pv };
            }
        } else {
            // SELL trade
            const slTouched = candle.high >= sl;
            const tp1Touched = tp1 !== null && candle.low <= tp1;
            const tp2Touched = tp2 !== null && candle.low <= tp2;

            if (slTouched) {
                const slippage = this.calculateSlippage({
                    side: 'BUY', candle,
                    atr: options.atr, quantity: options.quantity || 0.01,
                });
                return { hit: true, event: 'SL', fillPrice: sl + slippage * pv };
            }
            if (tp1Touched) {
                const slippage = this.calculateSlippage({
                    side: 'BUY', candle,
                    atr: options.atr, quantity: options.quantity || 0.01,
                });
                return { hit: true, event: 'TP1', fillPrice: tp1 + slippage * pv };
            }
            if (tp2Touched) {
                const slippage = this.calculateSlippage({
                    side: 'BUY', candle,
                    atr: options.atr, quantity: options.quantity || 0.01,
                });
                return { hit: true, event: 'TP2', fillPrice: tp2 + slippage * pv };
            }
        }

        return { hit: false, event: null, fillPrice: null };
    }

    /**
     * Calculate P&L for a closed trade with realistic costs.
     *
     * @param {Object} trade - { action, entryPrice, exitPrice, quantity }
     * @param {Object} costs - { entrySpread, entrySlippage, exitSpread, exitSlippage, commission, swap }
     * @returns {Object} { grossPnl, totalCosts, netPnl, breakdown }
     */
    calculateRealisticPnl(trade, costs = {}) {
        const { action, entryPrice, exitPrice, quantity } = trade;
        const positionSize = quantity * this.contractSize;
        const pv = this.POINT_VALUE;

        let grossPnl;
        if (action === 'BUY') {
            grossPnl = (exitPrice - entryPrice) * positionSize;
        } else {
            grossPnl = (entryPrice - exitPrice) * positionSize;
        }

        const totalSpreadCost = ((costs.entrySpread || 0) + (costs.exitSpread || 0)) * pv * quantity * this.contractSize * 0.5;
        const totalSlippageCost = ((costs.entrySlippage || 0) + (costs.exitSlippage || 0)) * pv * quantity * this.contractSize;
        const commission = costs.commission || 0;
        const swap = costs.swap || 0;

        const totalCosts = totalSpreadCost + totalSlippageCost + commission + swap;
        const netPnl = grossPnl - totalCosts;

        return {
            grossPnl: Math.round(grossPnl * 100) / 100,
            totalSpreadCost: Math.round(totalSpreadCost * 100) / 100,
            totalSlippageCost: Math.round(totalSlippageCost * 100) / 100,
            commission: Math.round(commission * 100) / 100,
            swap: Math.round(swap * 100) / 100,
            totalCosts: Math.round(totalCosts * 100) / 100,
            netPnl: Math.round(netPnl * 100) / 100,
        };
    }

    /**
     * Generate a summary of broker settings for display.
     */
    getSummary() {
        return {
            accountType: this.accountType,
            baseSpread: this.baseSpread,
            baseSlippage: this.baseSlippage,
            commissionPerLot: this.commissionPerLot,
            swapLongPerLot: this.swapLongPerLot,
            swapShortPerLot: this.swapShortPerLot,
            slippageModel: this.slippageModel,
        };
    }
}

module.exports = BrokerSimulation;
