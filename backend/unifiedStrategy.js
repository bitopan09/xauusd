/**
 * UNIFIED STRATEGY MODULE — XAU/USD (Gold)
 * Single source of truth for signal generation, confluence scoring, and risk management.
 * Tuned specifically for gold's price action characteristics.
 * Used by both the live bot and standalone backtest.
 */

class UnifiedStrategy {
    constructor() {
        this.CONFLUENCE_THRESHOLD = 7; // Minimum score to take a trade (A+ quality)
        this.MAX_SCORE = 10;
        this.FIXED_QUANTITY = 0.01;  // Fixed lot size — never changes
        this.TP1_RR = 3;   // 1:3 Risk-Reward for TP1 (gold moves slower than BTC)
        this.TP2_RR = 5;   // 1:5 Risk-Reward for TP2
    }

    /**
     * Returns the fixed lot size — always 0.01 for this bot.
     * @returns {number} Fixed quantity
     */
    getFixedQuantity() {
        return this.FIXED_QUANTITY;
    }

    // ==================== INDICATOR CALCULATIONS ====================

    calculateEma(data, period) {
        if (data.length < period) return data.length > 0 ? [data[data.length - 1]] : [0];
        const ema = [];
        const multiplier = 2 / (period + 1);
        let sma = data.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
        ema.push(sma);
        for (let i = period; i < data.length; i++) {
            ema.push((data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
        }
        return ema;
    }

    calculateAtr(priceData, period = 14) {
        if (priceData.length < period + 1) return 0;
        const trueRanges = [];
        for (let i = 1; i < priceData.length; i++) {
            const curr = priceData[i];
            const prev = priceData[i - 1];
            const high = curr.high || curr.price;
            const low = curr.low || curr.price;
            const prevClose = prev.close || prev.price;
            trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
        for (let i = period; i < trueRanges.length; i++) {
            atr = (atr * (period - 1) + trueRanges[i]) / period;
        }
        return atr;
    }

    calculateRsi(closes, period = 14) {
        if (closes.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = closes.length - period; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    calculateMacd(closes) {
        if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
        const ema12 = this.calculateEma(closes, 12);
        const ema26 = this.calculateEma(closes, 26);
        const macdLine = ema12[ema12.length - 1] - ema26[ema26.length - 1];
        const signalLine = this.calculateEma(
            ema12.slice(ema12.length - Math.min(ema12.length, 9)).map((v, i) => {
                const idx = ema26.length - Math.min(ema12.length, 9) + i;
                return idx >= 0 && idx < ema26.length ? v - ema26[idx] : 0;
            }), 9
        );
        const signal = signalLine.length > 0 ? signalLine[signalLine.length - 1] : macdLine * 0.8;
        return { macd: macdLine, signal, histogram: macdLine - signal };
    }

    calculateCPR(priceData) {
        const prevDay = priceData[priceData.length - 2];
        const high = prevDay.high || prevDay.price;
        const low = prevDay.low || prevDay.price;
        const close = prevDay.close || prevDay.price;

        const pp = (high + low + close) / 3;
        const bc = (high + low) / 2;
        const tc = (2 * pp) - bc;
        const r1 = (2 * pp) - low;
        const s1 = (2 * pp) - high;

        const currentPrice = priceData[priceData.length - 1].price;
        const distToPP = (currentPrice - pp) / pp;

        let signal = 'NEUTRAL';
        if (currentPrice > pp && currentPrice > tc) signal = 'BULLISH';
        else if (currentPrice < pp && currentPrice < bc) signal = 'BEARISH';

        return { signal, pp, bc, tc, r1, s1, distToPP };
    }

    calculateVWAP(priceData) {
        const lookback = Math.min(priceData.length, 20);
        const recent = priceData.slice(-lookback);
        let cumTPVol = 0, cumVol = 0;

        for (const candle of recent) {
            const tp = ((candle.high || candle.price) + (candle.low || candle.price) + (candle.close || candle.price)) / 3;
            const vol = candle.volume || 1;
            cumTPVol += tp * vol;
            cumVol += vol;
        }
        const vwap = cumTPVol / cumVol;
        const currentPrice = priceData[priceData.length - 1].price;
        return { value: vwap, signal: currentPrice > vwap ? 'BULLISH' : 'BEARISH' };
    }

    detectLiquiditySweep(priceData) {
        const recent = priceData.slice(-10);
        const currentCandle = priceData[priceData.length - 1];
        const currentPrice = currentCandle.price;
        const currentClose = currentCandle.close || currentPrice;
        const currentHigh = currentCandle.high || currentPrice;
        const currentLow = currentCandle.low || currentPrice;
        let sweepType = 'NONE';
        let sweepLevel = null;
        let isWyckoffConfirmed = false;

        for (let i = 0; i < recent.length - 1; i++) {
            const prevHigh = recent[i].high || recent[i].price;
            const prevLow = recent[i].low || recent[i].price;

            // Gold has tighter spreads — use 0.05% threshold instead of 0.1%
            if (currentHigh > prevHigh * 1.0005 && currentClose < prevHigh) {
                sweepType = 'LIQUIDITY_ABOVE'; sweepLevel = prevHigh; isWyckoffConfirmed = true;
            } else if (currentHigh > prevHigh * 1.0005) {
                sweepType = 'LIQUIDITY_ABOVE'; sweepLevel = prevHigh;
            }
            if (currentLow < prevLow * 0.9995 && currentClose > prevLow) {
                sweepType = 'LIQUIDITY_BELOW'; sweepLevel = prevLow; isWyckoffConfirmed = true;
            } else if (currentLow < prevLow * 0.9995) {
                sweepType = 'LIQUIDITY_BELOW'; sweepLevel = prevLow;
            }
        }

        let signal = 'NEUTRAL';
        if (sweepType === 'LIQUIDITY_BELOW') signal = 'BULLISH';
        if (sweepType === 'LIQUIDITY_ABOVE') signal = 'BEARISH';

        return { signal, sweepType, sweepLevel, isWyckoffConfirmed };
    }

    checkOTEZone(priceData) {
        const recent = priceData.slice(-20);
        const highs = recent.map(p => p.high || p.price);
        const lows = recent.map(p => p.low || p.price);
        const swingHigh = Math.max(...highs);
        const swingLow = Math.min(...lows);
        const range = swingHigh - swingLow;
        const currentPrice = priceData[priceData.length - 1].price;

        const fib62 = swingHigh - (range * 0.618);
        const fib79 = swingHigh - (range * 0.786);
        const inBullishOTE = currentPrice >= fib79 && currentPrice <= fib62;

        const bearFib62 = swingLow + (range * 0.618);
        const bearFib79 = swingLow + (range * 0.786);
        const inBearishOTE = currentPrice >= bearFib62 && currentPrice <= bearFib79;

        let signal = 'NEUTRAL';
        if (inBullishOTE) signal = 'BULLISH';
        if (inBearishOTE) signal = 'BEARISH';

        return { signal, inBullishOTE, inBearishOTE };
    }

    detectOrderBlockFVG(priceData) {
        const recent = priceData.slice(-20);
        let fvgCount = 0, obCount = 0;

        for (let i = 2; i < recent.length; i++) {
            const prev = recent[i - 2], next = recent[i];
            const prevHigh = prev.high || prev.price;
            const nextLow = next.low || next.price;
            const prevLow = prev.low || prev.price;
            const nextHigh = next.high || next.price;

            if (prevHigh < nextLow) fvgCount++;
            if (prevLow > nextHigh) fvgCount++;

            const curr = recent[i - 1];
            const bodySize = Math.abs((curr.open || curr.price) - (curr.close || curr.price));
            const candleSize = (curr.high || curr.price) - (curr.low || curr.price);
            if (candleSize > 0 && bodySize / candleSize > 0.6) obCount++;
        }

        const signal = fvgCount > 2 ? (obCount > 1 ? 'BULLISH' : 'BEARISH') : 'NEUTRAL';
        return { signal, fvgCount, obCount, strength: Math.min((fvgCount + obCount) / 2, 10) };
    }

    detectStructureBreak(priceData) {
        const recent = priceData.slice(-10);
        let bosCount = 0, chochCount = 0;
        const swingHighs = [], swingLows = [];

        for (let i = 2; i < recent.length - 2; i++) {
            const curr = recent[i], prev = recent[i - 1], next = recent[i + 1];
            const cH = curr.high || curr.price, cL = curr.low || curr.price;
            const pH = prev.high || prev.price, pL = prev.low || prev.price;
            const nH = next.high || next.price, nL = next.low || next.price;
            if (cH > pH && cH > nH) swingHighs.push(cH);
            if (cL < pL && cL < nL) swingLows.push(cL);
        }

        const currentPrice = priceData[priceData.length - 1].price;
        if (swingHighs.length > 0 && currentPrice > Math.max(...swingHighs)) bosCount++;
        if (swingLows.length > 0 && currentPrice < Math.min(...swingLows)) bosCount++;
        if (swingHighs.length >= 2 && swingLows.length >= 2) {
            const [prevSH, lastSH] = swingHighs.slice(-2);
            const [prevSL, lastSL] = swingLows.slice(-2);
            if (lastSH > prevSH && lastSL > prevSL) chochCount++;
            if (lastSH < prevSH && lastSL < prevSL) chochCount++;
        }

        const signal = bosCount > 0 ? (chochCount > 0 ? 'BULLISH' : 'BEARISH') : 'NEUTRAL';
        return { signal, bosCount, chochCount };
    }

    // ==================== 10-FACTOR CONFLUENCE SCORING ====================

    calculateConfluenceScore(priceData) {
        const prices = priceData.map(p => p.price);
        const closes = priceData.map(p => p.close || p.price);
        const currentPrice = priceData[priceData.length - 1].price;
        const prevPrice = priceData[priceData.length - 2].price;

        // Calculate all indicators
        const ema50 = this.calculateEma(prices, 50);
        const ema50Val = ema50[ema50.length - 1];
        const rsi = this.calculateRsi(closes, 14);
        const macd = this.calculateMacd(closes);
        const cpr = this.calculateCPR(priceData);
        const vwap = this.calculateVWAP(priceData);
        const liquidity = this.detectLiquiditySweep(priceData);
        const ote = this.checkOTEZone(priceData);
        const obfvg = this.detectOrderBlockFVG(priceData);
        const structure = this.detectStructureBreak(priceData);

        // Volume analysis
        const recentVol = priceData.slice(-5).reduce((s, p) => s + (p.volume || 1), 0) / 5;
        const prevVol = priceData.slice(-10, -5).reduce((s, p) => s + (p.volume || 1), 0) / 5;

        let score = 0;
        const details = [];

        // Factor 1: EMA-50 Trend
        const trendBullish = currentPrice > ema50Val && currentPrice > prevPrice;
        const trendBearish = currentPrice < ema50Val && currentPrice < prevPrice;
        if (trendBullish || trendBearish) { score++; details.push('Trend aligned'); }

        // Factor 2: RSI Confirmation
        const rsiBullish = rsi > 40 && rsi < 65;
        const rsiBearish = rsi > 35 && rsi < 60;
        if (rsiBullish || rsiBearish) { score++; details.push(`RSI: ${rsi.toFixed(1)}`); }

        // Factor 3: MACD Confirmation
        if (macd.histogram > 0 || macd.histogram < 0) { score++; details.push('MACD confirmed'); }

        // Factor 4: CPR PP Alignment (tighter for gold — 1.5% vs 3% for BTC)
        if (cpr.signal !== 'NEUTRAL' && Math.abs(cpr.distToPP) < 0.015) { score++; details.push('CPR PP aligned'); }

        // Factor 5: VWAP Alignment
        if (vwap.signal !== 'NEUTRAL') { score++; details.push('VWAP aligned'); }

        // Factor 6: Liquidity Sweep / Wyckoff
        if (liquidity.signal !== 'NEUTRAL') {
            score++;
            details.push(liquidity.isWyckoffConfirmed ? 'Wyckoff confirmed' : 'Liquidity sweep');
            if (liquidity.isWyckoffConfirmed) { score++; details.push('Wyckoff bonus'); }
        }

        // Factor 7: OTE Zone (Fibonacci 62-79%)
        if (ote.signal !== 'NEUTRAL') { score++; details.push('In OTE zone'); }

        // Factor 8: Order Block / FVG
        if (obfvg.signal !== 'NEUTRAL' && obfvg.strength > 2) { score++; details.push('OB/FVG detected'); }

        // Factor 9: CHoCH / BOS Structure Break
        if (structure.signal !== 'NEUTRAL') { score++; details.push('Structure break'); }

        // Factor 10: Volume Confirmation
        if (recentVol > prevVol * 1.1) { score++; details.push('Volume confirmation'); }

        return {
            score: Math.min(score, this.MAX_SCORE),
            threshold: this.CONFLUENCE_THRESHOLD,
            details: details.join(', '),
            indicators: { rsi, macd, cpr, vwap, liquidity, ote, obfvg, structure, ema50Val }
        };
    }

    // ==================== UNIFIED SIGNAL GENERATION ====================

    analyze(priceData) {
        if (!priceData || priceData.length < 50) {
            return { signal: 'NEUTRAL', score: 0, details: 'Insufficient data' };
        }

        const confluence = this.calculateConfluenceScore(priceData);
        const { score, indicators } = confluence;

        let signal = 'NEUTRAL';

        if (score >= this.CONFLUENCE_THRESHOLD) {
            const prices = priceData.map(p => p.price);
            const ema9 = this.calculateEma(prices, 9);
            const ema21 = this.calculateEma(prices, 21);
            const ema9Val = ema9[ema9.length - 1];
            const ema21Val = ema21[ema21.length - 1];
            const currentPrice = priceData[priceData.length - 1].price;

            const bullish = ema9Val > ema21Val && currentPrice > indicators.ema50Val;
            const bearish = ema9Val < ema21Val && currentPrice < indicators.ema50Val;

            if (bullish) signal = 'BUY';
            else if (bearish) signal = 'SELL';
        }

        // Calculate risk parameters
        const riskParams = this.calculateRiskParameters(priceData, indicators);

        return {
            signal,
            score: confluence.score,
            details: {
                confluenceScorer: confluence,
                riskCalculator: riskParams,
                timestamp: new Date().toISOString()
            }
        };
    }

    // ==================== UNIFIED RISK MANAGEMENT ====================

    calculateRiskParameters(priceData, indicators) {
        const currentPrice = priceData[priceData.length - 1].price;
        const atr = this.calculateAtr(priceData, 14);
        const liquidity = indicators?.liquidity || this.detectLiquiditySweep(priceData);
        const cpr = indicators?.cpr || this.calculateCPR(priceData);

        let slDistance;
        if (liquidity.sweepLevel) {
            const buffer = atr * 0.2;
            slDistance = Math.abs(currentPrice - liquidity.sweepLevel) + buffer;
        } else if (cpr.bc && cpr.tc) {
            slDistance = Math.max(Math.abs(currentPrice - cpr.bc), Math.abs(cpr.tc - currentPrice), atr * 1.5);
        } else {
            slDistance = atr * 1.5;
        }
        slDistance = Math.max(slDistance, atr * 0.5); // Minimum SL

        const tp1Distance = slDistance * this.TP1_RR;
        const tp2Distance = slDistance * this.TP2_RR;

        return {
            atr,
            slDistance,
            stopLoss: {
                long: currentPrice - slDistance,
                short: currentPrice + slDistance
            },
            takeProfit: {
                tp1Long: currentPrice + tp1Distance,
                tp1Short: currentPrice - tp1Distance,
                tp2Long: currentPrice + tp2Distance,
                tp2Short: currentPrice - tp2Distance
            },
            riskReward: { tp1: this.TP1_RR, tp2: this.TP2_RR }
        };
    }

    // ==================== UNIFIED TRAILING STOP ====================
    // Adjusted for gold: tighter thresholds (2R, 3.5R, 5R vs BTC's 2.5R, 4R, 6R)

    applyTrailingStop(activeTrade, currentCandle) {
        // For XAU/USD, 1 standard lot = 100 ounces
        const CONTRACT_SIZE = 100;
        const positionSize = activeTrade.quantity * CONTRACT_SIZE;

        const atr = activeTrade.atr || 15; // Gold ATR ~$15-30 on 6H
        const riskUnit = positionSize * atr;

        if (activeTrade.action === 'BUY') {
            const unrealizedPnl = (currentCandle.close - activeTrade.entryPrice) * positionSize;
            if (unrealizedPnl > riskUnit * 5) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.8;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (unrealizedPnl > riskUnit * 3.5) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.6;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (unrealizedPnl > riskUnit * 2) {
                const be = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.1;
                activeTrade.sl = Math.max(activeTrade.sl, be);
            }
        } else if (activeTrade.action === 'SELL') {
            const unrealizedPnl = (activeTrade.entryPrice - currentCandle.close) * positionSize;
            if (unrealizedPnl > riskUnit * 5) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.8;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (unrealizedPnl > riskUnit * 3.5) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.6;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (unrealizedPnl > riskUnit * 2) {
                const be = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.1;
                activeTrade.sl = Math.min(activeTrade.sl, be);
            }
        }
        return activeTrade;
    }

    // ==================== UNIFIED TRADE EXIT CHECK ====================

    checkTradeExit(activeTrade, currentCandle) {
        this.applyTrailingStop(activeTrade, currentCandle);

        let exitPrice = null;
        let exitReason = '';

        if (activeTrade.action === 'BUY') {
            if (currentCandle.low <= activeTrade.sl) {
                exitPrice = activeTrade.sl;
                exitReason = activeTrade.sl >= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss';
            } else if (currentCandle.high >= activeTrade.tp1) {
                exitPrice = activeTrade.tp1;
                exitReason = 'Take Profit';
            }
        } else {
            if (currentCandle.high >= activeTrade.sl) {
                exitPrice = activeTrade.sl;
                exitReason = activeTrade.sl <= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss';
            } else if (currentCandle.low <= activeTrade.tp1) {
                exitPrice = activeTrade.tp1;
                exitReason = 'Take Profit';
            }
        }

        if (exitPrice !== null) {
            const CONTRACT_SIZE = 100;
            const positionSize = activeTrade.quantity * CONTRACT_SIZE;
            const pnl = activeTrade.action === 'BUY'
                ? (exitPrice - activeTrade.entryPrice) * positionSize
                : (activeTrade.entryPrice - exitPrice) * positionSize;
            return { closed: true, exitPrice, exitReason, pnl };
        }
        return { closed: false };
    }
}

module.exports = UnifiedStrategy;
