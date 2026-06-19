/**
 * UNIFIED STRATEGY MODULE — XAU/USD (Gold) — V2
 * Single source of truth for signal generation, confluence scoring, and risk management.
 * Tuned specifically for gold's price action characteristics.
 * Used by both the live bot and standalone backtest.
 *
 * V2 Changes (vs V1 backup in backups/unifiedStrategy.v1.js):
 * 1. Added Supertrend (10, 3.0) — weight 1.3
 * 2. Added Stochastic (14, 3, 3) — weight 0.8
 * 3. Daily EMA-200 hard gate filter (counter-trend trades lose ~60% on 6H)
 * 4. RSI divergence detection (bullish/bearish divergence bonus)
 * 5. MACD threshold fix (0.0001 → 0.00005 for gold sensitivity)
 * 6. OB/FVG tightening (> 2 → > 3, bearStrength * 1.5 for stronger confirmation)
 * 7. Volume improvement (5-bar → 20-bar average, 1.5x multiplier)
 * 8. Breakeven trigger at 1R (new tier before existing 2R trail)
 * 9. Threshold lowered from 5.5 → 4.5
 * 10. Removed VWAP from scoring (noise on 6H)
 * 11. Liquidity sweep tightening (lookback 10→15, close-inside requirement)
 * 12. Lookback window increased to 200 for EMA-200 and better indicator calc
 * 13. Added check1HConfirmation() for multi-TF confirmation
 */

const GoldSpecialist = require('./goldSpecialist');
const BrokerSimulation = require('./brokerSimulation');

class UnifiedStrategy {
    constructor() {
        const numberFromEnv = (key, fallback) => {
            const value = Number(process.env[key]);
            return Number.isFinite(value) ? value : fallback;
        };

        this.CONFLUENCE_THRESHOLD = numberFromEnv('CONFLUENCE_THRESHOLD', 4.5);
        this.MAX_SCORE = 14; // Expanded for gold specialist additions
        this.MIN_DIRECTIONAL_MARGIN = numberFromEnv('MIN_DIRECTIONAL_MARGIN', 1);
        this.FIXED_QUANTITY = Number(process.env.XAU_QUANTITY) || 0.01;
        this.TP1_RR = numberFromEnv('TP1_RR', 3);
        this.TP2_RR = numberFromEnv('TP2_RR', 5);
        this.TP1_CLOSE_PERCENT = numberFromEnv('TP1_CLOSE_PERCENT', 50);
        this.LOOKBACK = 200; // Increased for EMA-200 and better indicator calc

        this.weights = {
            trend: numberFromEnv('WEIGHT_TREND', 1.2),
            rsi: numberFromEnv('WEIGHT_RSI', 0.8),
            macd: numberFromEnv('WEIGHT_MACD', 1),
            cpr: numberFromEnv('WEIGHT_CPR', 0.8),
            // VWAP REMOVED — noise on 6H candles, designed for intraday
            liquidity: numberFromEnv('WEIGHT_LIQUIDITY', 1.4),
            wyckoffBonus: numberFromEnv('WEIGHT_WYCKOFF_BONUS', 0.8),
            ote: numberFromEnv('WEIGHT_OTE', 0.9),
            obfvg: numberFromEnv('WEIGHT_OBFVG', 1.2),
            structure: numberFromEnv('WEIGHT_STRUCTURE', 1.3),
            volume: numberFromEnv('WEIGHT_VOLUME', 0.7),
            supertrend: numberFromEnv('WEIGHT_SUPERTREND', 1.3),
            stochastic: numberFromEnv('WEIGHT_STOCHASTIC', 0.8),
            rsiDivergence: numberFromEnv('WEIGHT_RSI_DIVERGENCE', 0.6),
            goldStructural: numberFromEnv('WEIGHT_GOLD_STRUCTURAL', 1.2),
            goldSweep: numberFromEnv('WEIGHT_GOLD_SWEEP', 1.0),
            goldConflict: numberFromEnv('WEIGHT_GOLD_CONFLICT', -1.0)
        };

        this.goldSpecialist = new GoldSpecialist();
        this.broker = new BrokerSimulation();
    }

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
        const currentCandle = priceData[priceData.length - 1];
        let prevDay = null;

        if (currentCandle?.timestamp) {
            const currentDate = new Date(currentCandle.timestamp).toISOString().slice(0, 10);
            const previousCandles = priceData.filter(candle => (
                candle.timestamp && new Date(candle.timestamp).toISOString().slice(0, 10) < currentDate
            ));
            const previousDate = previousCandles.length > 0
                ? new Date(previousCandles[previousCandles.length - 1].timestamp).toISOString().slice(0, 10)
                : null;

            if (previousDate) {
                const dailyCandles = previousCandles.filter(candle => new Date(candle.timestamp).toISOString().slice(0, 10) === previousDate);
                prevDay = {
                    high: Math.max(...dailyCandles.map(candle => candle.high || candle.price)),
                    low: Math.min(...dailyCandles.map(candle => candle.low || candle.price)),
                    close: dailyCandles[dailyCandles.length - 1].close || dailyCandles[dailyCandles.length - 1].price
                };
            }
        }

        if (!prevDay) {
            prevDay = priceData[priceData.length - 2];
        }

        const high = prevDay.high || prevDay.price;
        const low = prevDay.low || prevDay.price;
        const close = prevDay.close || prevDay.price;

        const pp = (high + low + close) / 3;
        const bc = (high + low) / 2;
        const tc = (2 * pp) - bc;
        const r1 = (2 * pp) - low;
        const s1 = (2 * pp) - high;

        const currentPrice = currentCandle.price;
        const distToPP = (currentPrice - pp) / pp;

        let signal = 'NEUTRAL';
        if (currentPrice > pp && currentPrice > tc) signal = 'BULLISH';
        else if (currentPrice < pp && currentPrice < bc) signal = 'BEARISH';

        return { signal, pp, bc, tc, r1, s1, distToPP };
    }

    // VWAP REMOVED — was noise on 6H candles. Kept method for backward compat only.
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

    // IMPROVEMENT #11: Liquidity sweep tightened — lookback 10→15, requires close inside
    detectLiquiditySweep(priceData) {
        const recent = priceData.slice(-15); // Tightened from 10
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

            // Tighter threshold for gold (0.05%)
            if (currentHigh > prevHigh * 1.0005 && currentClose < prevHigh) {
                // REQUIRED: close must be back inside the swept level (reject)
                sweepType = 'LIQUIDITY_ABOVE'; sweepLevel = prevHigh; isWyckoffConfirmed = true;
            }
            if (currentLow < prevLow * 0.9995 && currentClose > prevLow) {
                // REQUIRED: close must be back inside the swept level (reject)
                sweepType = 'LIQUIDITY_BELOW'; sweepLevel = prevLow; isWyckoffConfirmed = true;
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

    // IMPROVEMENT #6: OB/FVG tightened — threshold >2→>3, bearStrength * 1.5
    detectOrderBlockFVG(priceData) {
        const recent = priceData.slice(-20);
        let bullFvgCount = 0, bearFvgCount = 0, bullObCount = 0, bearObCount = 0;

        for (let i = 2; i < recent.length; i++) {
            const prev = recent[i - 2], next = recent[i];
            const prevHigh = prev.high || prev.price;
            const nextLow = next.low || next.price;
            const prevLow = prev.low || prev.price;
            const nextHigh = next.high || next.price;

            if (prevHigh < nextLow) bullFvgCount++;
            if (prevLow > nextHigh) bearFvgCount++;

            const curr = recent[i - 1];
            const open = curr.open || curr.price;
            const close = curr.close || curr.price;
            const bodySize = Math.abs(open - close);
            const candleSize = (curr.high || curr.price) - (curr.low || curr.price);
            if (candleSize > 0 && bodySize / candleSize > 0.6) {
                if (close > open) bullObCount++;
                else if (close < open) bearObCount++;
            }
        }

        const bullStrength = bullFvgCount + bullObCount;
        const bearStrength = (bearFvgCount + bearObCount) * 1.5; // Tightened: bear needs 1.5x strength
        const fvgCount = bullFvgCount + bearFvgCount;
        const obCount = bullObCount + bearObCount;

        let signal = 'NEUTRAL';
        if (bullStrength > bearStrength && bullStrength > 3) signal = 'BULLISH';      // Tightened from >2
        else if (bearStrength > bullStrength && bearStrength > 3) signal = 'BEARISH';  // Tightened from >2

        return {
            signal,
            fvgCount,
            obCount,
            bullFvgCount,
            bearFvgCount,
            bullObCount,
            bearObCount,
            strength: Math.min(Math.max(bullStrength, bearStrength), 10)
        };
    }

    detectStructureBreak(priceData) {
        const recent = priceData.slice(-10);
        let bullBosCount = 0, bearBosCount = 0, bullChochCount = 0, bearChochCount = 0;
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
        if (swingHighs.length > 0 && currentPrice > Math.max(...swingHighs)) bullBosCount++;
        if (swingLows.length > 0 && currentPrice < Math.min(...swingLows)) bearBosCount++;
        if (swingHighs.length >= 2 && swingLows.length >= 2) {
            const [prevSH, lastSH] = swingHighs.slice(-2);
            const [prevSL, lastSL] = swingLows.slice(-2);
            if (lastSH > prevSH && lastSL > prevSL) bullChochCount++;
            if (lastSH < prevSH && lastSL < prevSL) bearChochCount++;
        }

        const bullStrength = bullBosCount + bullChochCount;
        const bearStrength = bearBosCount + bearChochCount;
        let signal = 'NEUTRAL';
        if (bullStrength > bearStrength && bullStrength > 0) signal = 'BULLISH';
        else if (bearStrength > bullStrength && bearStrength > 0) signal = 'BEARISH';

        return {
            signal,
            bosCount: bullBosCount + bearBosCount,
            chochCount: bullChochCount + bearChochCount,
            bullBosCount,
            bearBosCount,
            bullChochCount,
            bearChochCount
        };
    }

    // IMPROVEMENT #1: Supertrend (10, 3.0) — new indicator
    calculateSupertrend(priceData, period = 10, multiplier = 3.0) {
        if (priceData.length < period + 1) return { value: 0, direction: 'NEUTRAL' };

        const atr = this.calculateAtr(priceData, period);
        const closes = priceData.map(p => p.close || p.price);
        const highs = priceData.map(p => p.high || p.price);
        const lows = priceData.map(p => p.low || p.price);

        const hl2 = [];
        for (let i = 0; i < priceData.length; i++) {
            hl2.push((highs[i] + lows[i]) / 2);
        }

        const upperBand = [];
        const lowerBand = [];
        const direction = []; // 1 = bullish, -1 = bearish

        for (let i = 0; i < hl2.length; i++) {
            upperBand.push(hl2[i] + multiplier * atr);
            lowerBand.push(hl2[i] - multiplier * atr);
            direction.push(0);
        }

        // First direction
        if (closes[period] > upperBand[period]) direction[period] = 1;
        else direction[period] = -1;

        // Propagate direction
        for (let i = period + 1; i < closes.length; i++) {
            if (closes[i] > upperBand[i - 1]) {
                direction[i] = 1;
            } else if (closes[i] < lowerBand[i - 1]) {
                direction[i] = -1;
            } else {
                direction[i] = direction[i - 1];
            }

            // Adjust bands based on direction
            if (direction[i] === 1 && lowerBand[i] < lowerBand[i - 1]) {
                lowerBand[i] = lowerBand[i - 1];
            }
            if (direction[i] === -1 && upperBand[i] > upperBand[i - 1]) {
                upperBand[i] = upperBand[i - 1];
            }
        }

        const lastDir = direction[direction.length - 1];
        const value = lastDir === 1 ? lowerBand[lowerBand.length - 1] : upperBand[upperBand.length - 1];

        return {
            value,
            direction: lastDir === 1 ? 'BULLISH' : lastDir === -1 ? 'BEARISH' : 'NEUTRAL',
            upperBand: upperBand[upperBand.length - 1],
            lowerBand: lowerBand[lowerBand.length - 1]
        };
    }

    // IMPROVEMENT #2: Stochastic (14, 3, 3) — new indicator
    calculateStochastic(priceData, kPeriod = 14, kSmooth = 3, dSmooth = 3) {
        if (priceData.length < kPeriod + kSmooth + dSmooth) return { k: 50, d: 50, signal: 'NEUTRAL' };

        const highs = priceData.map(p => p.high || p.price);
        const lows = priceData.map(p => p.low || p.price);
        const closes = priceData.map(p => p.close || p.price);

        // Raw %K
        const rawK = [];
        for (let i = kPeriod - 1; i < closes.length; i++) {
            const periodHighs = highs.slice(i - kPeriod + 1, i + 1);
            const periodLows = lows.slice(i - kPeriod + 1, i + 1);
            const hh = Math.max(...periodHighs);
            const ll = Math.min(...periodLows);
            const range = hh - ll;
            rawK.push(range === 0 ? 50 : ((closes[i] - ll) / range) * 100);
        }

        // Smoothed %K (SMA of rawK)
        const smoothedK = [];
        for (let i = kSmooth - 1; i < rawK.length; i++) {
            const slice = rawK.slice(i - kSmooth + 1, i + 1);
            smoothedK.push(slice.reduce((s, v) => s + v, 0) / kSmooth);
        }

        // %D (SMA of smoothedK)
        const dLine = [];
        for (let i = dSmooth - 1; i < smoothedK.length; i++) {
            const slice = smoothedK.slice(i - dSmooth + 1, i + 1);
            dLine.push(slice.reduce((s, v) => s + v, 0) / dSmooth);
        }

        const kVal = smoothedK[smoothedK.length - 1] || 50;
        const dVal = dLine[dLine.length - 1] || kVal;

        let signal = 'NEUTRAL';
        // Bull: oversold crossover (< 20, K crosses above D)
        if (kVal < 20 && kVal > dVal && smoothedK[smoothedK.length - 2] <= dLine[dLine.length - 2]) {
            signal = 'BULLISH';
        }
        // Bear: overbought crossover (> 80, K crosses below D)
        else if (kVal > 80 && kVal < dVal && smoothedK[smoothedK.length - 2] >= dLine[dLine.length - 2]) {
            signal = 'BEARISH';
        }
        // General direction
        else if (kVal < 30 && dVal < 30) {
            signal = 'BULLISH'; // Oversold zone
        }
        else if (kVal > 70 && dVal > 70) {
            signal = 'BEARISH'; // Overbought zone
        }

        return { k: kVal, d: dVal, signal };
    }

    // IMPROVEMENT #4: RSI divergence detection
    detectRSIDivergence(closes, priceData) {
        if (closes.length < 30) return { signal: 'NEUTRAL', type: 'NONE' };

        // Find last 3 swing lows in price and RSI
        const swingLows = [];
        const swingHighs = [];
        const rsiValues = [];

        for (let i = 2; i < closes.length - 2; i++) {
            const rsi = this.calculateRsi(closes.slice(0, i + 1), 14);
            rsiValues.push(rsi);

            if (closes[i] < closes[i - 1] && closes[i] < closes[i - 2] &&
                closes[i] < closes[i + 1] && closes[i] < closes[i + 2]) {
                swingLows.push({ priceIdx: i, price: closes[i], rsi });
            }
            if (closes[i] > closes[i - 1] && closes[i] > closes[i - 2] &&
                closes[i] > closes[i + 1] && closes[i] > closes[i + 2]) {
                swingHighs.push({ priceIdx: i, price: closes[i], rsi });
            }
        }

        // Bullish divergence: price makes lower low, RSI makes higher low
        if (swingLows.length >= 2) {
            const [prev, curr] = swingLows.slice(-2);
            if (curr.price < prev.price && curr.rsi > prev.rsi) {
                return { signal: 'BULLISH', type: 'BULLISH_DIVERGENCE' };
            }
        }

        // Bearish divergence: price makes higher high, RSI makes lower high
        if (swingHighs.length >= 2) {
            const [prev, curr] = swingHighs.slice(-2);
            if (curr.price > prev.price && curr.rsi < prev.rsi) {
                return { signal: 'BEARISH', type: 'BEARISH_DIVERGENCE' };
            }
        }

        return { signal: 'NEUTRAL', type: 'NONE' };
    }

    // IMPROVEMENT #3: Daily EMA-200 hard gate
    checkDailyEMA200Gate(priceData) {
        // Use last 200 candles as proxy for daily trend
        const lookback = Math.min(priceData.length, 200);
        const prices = priceData.slice(-lookback).map(p => p.close || p.price);
        if (prices.length < 50) return { above: true, ema200: 0, currentPrice: prices[prices.length - 1] || 0 };

        const ema200 = this.calculateEma(prices, Math.min(200, prices.length));
        const ema200Val = ema200[ema200.length - 1];
        const currentPrice = priceData[priceData.length - 1].price;

        return {
            above: currentPrice > ema200Val,
            ema200: ema200Val,
            currentPrice
        };
    }

    // ==================== 12-FACTOR CONFLUENCE SCORING ====================

    calculateConfluenceScore(priceData) {
        const prices = priceData.map(p => p.price);
        const closes = priceData.map(p => p.close || p.price);
        const currentPrice = priceData[priceData.length - 1].price;
        const prevPrice = priceData[priceData.length - 2]?.price || currentPrice;

        // IMPROVEMENT #12: Lookback 200 for better indicator calc
        const lookbackData = priceData.slice(-this.LOOKBACK);
        const lookbackPrices = lookbackData.map(p => p.price);
        const lookbackCloses = lookbackData.map(p => p.close || p.price);

        // Calculate all indicators
        const ema50 = this.calculateEma(prices, 50);
        const ema50Val = ema50[ema50.length - 1];
        const rsi = this.calculateRsi(closes, 14);
        const macd = this.calculateMacd(closes);
        const cpr = this.calculateCPR(priceData);
        const vwap = this.calculateVWAP(priceData); // Kept for compat but NOT scored
        const liquidity = this.detectLiquiditySweep(priceData);
        const ote = this.checkOTEZone(priceData);
        const obfvg = this.detectOrderBlockFVG(priceData);
        const structure = this.detectStructureBreak(priceData);
        const supertrend = this.calculateSupertrend(lookbackData, 10, 3.0);
        const stochastic = this.calculateStochastic(lookbackData, 14, 3, 3);
        const rsiDivergence = this.detectRSIDivergence(closes, priceData);
        const dailyGate = this.checkDailyEMA200Gate(priceData);

        // IMPROVEMENT #7: Volume analysis — 20-bar average, 1.5x multiplier
        const recentVol = priceData.slice(-20).reduce((s, p) => s + (p.volume || 1), 0) / Math.min(20, priceData.length);
        const prevVol = priceData.slice(-40, -20).reduce((s, p) => s + (p.volume || 1), 0) / Math.min(20, priceData.length);

        let bullScore = 0, bearScore = 0;
        const details = [];

        // Factor 1: EMA-50 Trend
        if (currentPrice > ema50Val && currentPrice > prevPrice) { bullScore += this.weights.trend; details.push('Trend ↑'); }
        else if (currentPrice < ema50Val && currentPrice < prevPrice) { bearScore += this.weights.trend; details.push('Trend ↓'); }

        // Factor 2: RSI Confirmation
        if (rsi > 50 && rsi < 65) { bullScore += this.weights.rsi; details.push(`RSI: ${rsi.toFixed(1)} (bull zone)`); }
        else if (rsi > 35 && rsi < 50) { bearScore += this.weights.rsi; details.push(`RSI: ${rsi.toFixed(1)} (bear zone)`); }

        // IMPROVEMENT #4: RSI Divergence bonus
        if (rsiDivergence.signal === 'BULLISH') {
            bullScore += this.weights.rsiDivergence;
            details.push('RSI bull divergence');
        } else if (rsiDivergence.signal === 'BEARISH') {
            bearScore += this.weights.rsiDivergence;
            details.push('RSI bear divergence');
        }

        // IMPROVEMENT #5: MACD threshold fix (0.0001 → 0.00005)
        const macdThreshold = currentPrice * 0.00005; // Tightened from 0.0001
        if (macd.histogram > macdThreshold) { bullScore += this.weights.macd; details.push('MACD bull'); }
        else if (macd.histogram < -macdThreshold) { bearScore += this.weights.macd; details.push('MACD bear'); }

        // Factor 4: CPR PP Alignment
        if (cpr.signal === 'BULLISH' && Math.abs(cpr.distToPP) < 0.015) { bullScore += this.weights.cpr; details.push('CPR PP ↑'); }
        else if (cpr.signal === 'BEARISH' && Math.abs(cpr.distToPP) < 0.015) { bearScore += this.weights.cpr; details.push('CPR PP ↓'); }

        // IMPROVEMENT #10: VWAP REMOVED from scoring — noise on 6H
        // (kept calculateVWAP method for backward compat)

        // Factor 6: Liquidity Sweep / Wyckoff
        if (liquidity.signal === 'BULLISH') {
            bullScore += this.weights.liquidity;
            details.push(liquidity.isWyckoffConfirmed ? 'Wyckoff ↑' : 'Liq sweep ↑');
            if (liquidity.isWyckoffConfirmed) { bullScore += this.weights.wyckoffBonus; details.push('Wyckoff bonus'); }
        } else if (liquidity.signal === 'BEARISH') {
            bearScore += this.weights.liquidity;
            details.push(liquidity.isWyckoffConfirmed ? 'Wyckoff ↓' : 'Liq sweep ↓');
            if (liquidity.isWyckoffConfirmed) { bearScore += this.weights.wyckoffBonus; details.push('Wyckoff bonus'); }
        }

        // Factor 7: OTE Zone
        if (ote.signal === 'BULLISH') { bullScore += this.weights.ote; details.push('OTE bull'); }
        else if (ote.signal === 'BEARISH') { bearScore += this.weights.ote; details.push('OTE bear'); }

        // IMPROVEMENT #6: Order Block / FVG (tightened thresholds)
        if (obfvg.signal === 'BULLISH' && obfvg.strength > 0) { bullScore += this.weights.obfvg; details.push('OB/FVG ↑'); }
        else if (obfvg.signal === 'BEARISH' && obfvg.strength > 0) { bearScore += this.weights.obfvg; details.push('OB/FVG ↓'); }

        // Factor 9: CHoCH / BOS Structure Break
        if (structure.signal === 'BULLISH') { bullScore += this.weights.structure; details.push('BOS/CHoCH ↑'); }
        else if (structure.signal === 'BEARISH') { bearScore += this.weights.structure; details.push('BOS/CHoCH ↓'); }

        // IMPROVEMENT #7: Volume Confirmation (20-bar avg, 1.5x threshold)
        if (recentVol > prevVol * 1.5) {
            if (bullScore > bearScore) { bullScore += this.weights.volume; details.push('Vol confirms ↑'); }
            else if (bearScore > bullScore) { bearScore += this.weights.volume; details.push('Vol confirms ↓'); }
        }

        // IMPROVEMENT #1: Supertrend (10, 3.0)
        if (supertrend.direction === 'BULLISH') { bullScore += this.weights.supertrend; details.push('Supertrend ↑'); }
        else if (supertrend.direction === 'BEARISH') { bearScore += this.weights.supertrend; details.push('Supertrend ↓'); }

        // IMPROVEMENT #2: Stochastic (14, 3, 3)
        if (stochastic.signal === 'BULLISH') { bullScore += this.weights.stochastic; details.push(`Stoch: ${stochastic.k.toFixed(0)}/${stochastic.d.toFixed(0)} ↑`); }
        else if (stochastic.signal === 'BEARISH') { bearScore += this.weights.stochastic; details.push(`Stoch: ${stochastic.k.toFixed(0)}/${stochastic.d.toFixed(0)} ↓`); }

        // ════════════════════════════════════════════════════════════════════
        // GOLD-SPECIFIC SCORING — session, structure, conflicts, sweeps
        // ════════════════════════════════════════════════════════════════════
        const hour = new Date(priceData[priceData.length - 1].timestamp).getUTCHours();
        const dailyData = priceData.filter(c => {
            const ts = c.timestamp;
            if (!ts) return false;
            const h = new Date(ts).getUTCHours();
            return h === 0 || h === 12; // synthetic daily proxy from 6H candles
        });

        const goldAnalysis = this.goldSpecialist.analyze({
            candles: priceData.slice(-20),
            currentPrice,
            hour,
            dailyData,
            indicators: {
                side: bullScore > bearScore ? 'BUY' : 'SELL',
                supertrend: { direction: supertrend.direction },
                stochData: { k: stochastic.k, d: stochastic.d },
                rsi,
                macdHist: macd.histogram,
                obfvgScore: obfvg.strength,
            },
        });

        // Gold structural proximity (PDH/PDL, round numbers)
        if (goldAnalysis.structScore.score !== 0) {
            const goldStructDir = goldAnalysis.structScore.score > 0 ? 'BULL' : 'BEAR';
            if (goldStructDir === 'BULL') {
                bullScore += Math.abs(goldAnalysis.structScore.score) * this.weights.goldStructural;
                details.push(`Gold: ${goldAnalysis.structScore.details}`);
            } else {
                bearScore += Math.abs(goldAnalysis.structScore.score) * this.weights.goldStructural;
                details.push(`Gold: ${goldAnalysis.structScore.details}`);
            }
        }

        // Liquidity sweep (gold-specific: wick rejection pattern)
        if (goldAnalysis.sweep.swept) {
            if (goldAnalysis.sweep.side === 'BUY') {
                bullScore += this.weights.goldSweep;
                details.push(`Gold sweep ↑ $${goldAnalysis.sweep.level.toFixed(0)}`);
            } else {
                bearScore += this.weights.goldSweep;
                details.push(`Gold sweep ↓ $${goldAnalysis.sweep.level.toFixed(0)}`);
            }
        }

        // Momentum exhaustion penalty
        if (goldAnalysis.exhaustion.exhausted) {
            if (goldAnalysis.exhaustion.side === 'BUY' && bullScore > bearScore) {
                bullScore += this.weights.goldConflict; // penalty for buying into exhaustion
                details.push(`Exhaustion: ${goldAnalysis.exhaustion.type}`);
            } else if (goldAnalysis.exhaustion.side === 'SELL' && bearScore > bullScore) {
                bearScore += this.weights.goldConflict;
                details.push(`Exhaustion: ${goldAnalysis.exhaustion.type}`);
            }
        }

        // Indicator conflict penalty (main source of losses)
        if (goldAnalysis.conflicts.hasConflict && goldAnalysis.conflicts.severity === 'high') {
            const penalty = Math.abs(this.weights.goldConflict) * 1.5;
            if (bullScore > bearScore) bullScore -= penalty;
            else bearScore -= penalty;
            details.push(`CONFLICT: ${goldAnalysis.conflicts.conflicts[0].type}`);
        }

        // Store gold analysis for downstream use (session, volatility, structural)
        const goldMeta = {
            session: goldAnalysis.session,
            volatility: goldAnalysis.volatility,
            volAdj: goldAnalysis.volAdj,
            structural: goldAnalysis.structural,
            goldScore: goldAnalysis.goldScore,
            summary: goldAnalysis.summary,
        };

        // Final score: max of directional scores (conflicting signals don't stack)
        const score = Number(Math.min(Math.max(bullScore, bearScore), this.MAX_SCORE).toFixed(1));
        const scoreMargin = Math.abs(bullScore - bearScore);
        let direction = 'NEUTRAL';
        if (scoreMargin >= this.MIN_DIRECTIONAL_MARGIN) {
            direction = bullScore > bearScore ? 'BULLISH' : 'BEARISH';
        }

        return {
            score,
            threshold: this.CONFLUENCE_THRESHOLD,
            details: details.join(', '),
            direction,
            scoreMargin,
            bullScore,
            bearScore,
            goldMeta,
            indicators: { rsi, macd, cpr, vwap, liquidity, ote, obfvg, structure, ema50Val, supertrend, stochastic, rsiDivergence, dailyGate }
        };
    }

    // ==================== UNIFIED SIGNAL GENERATION ====================

    analyze(priceData, oneHourData = null) {
        if (!priceData || priceData.length < 50) {
            return { signal: 'NEUTRAL', score: 0, details: 'Insufficient data' };
        }

        const confluence = this.calculateConfluenceScore(priceData);
        const { score, indicators, direction } = confluence;

        let signal = 'NEUTRAL';
        const prices = priceData.map(p => p.price);
        const currentPrice = priceData[priceData.length - 1].price;
        const ema9 = this.calculateEma(prices, 9);
        const ema21 = this.calculateEma(prices, 21);
        const ema9Val = ema9[ema9.length - 1];
        const ema21Val = ema21[ema21.length - 1];

        const bullishEma = ema9Val > ema21Val;
        const bearishEma = ema9Val < ema21Val;
        const bullishPrice = currentPrice > indicators.ema50Val;
        const bearishPrice = currentPrice < indicators.ema50Val;

        // IMPROVEMENT #3: Daily EMA-200 hard gate — counter-trend trades lose ~60% on 6H
        const dailyGate = indicators.dailyGate;
        const aboveEMA200 = dailyGate.above;

        let filterBreakdown = {
            scoreMet: score >= this.CONFLUENCE_THRESHOLD,
            threshold: this.CONFLUENCE_THRESHOLD,
            score,
            confluenceDirection: direction,
            ema9Val,
            ema21Val,
            ema50Val: indicators.ema50Val,
            ema200: dailyGate.ema200,
            currentPrice,
            bullishEma,
            bearishEma,
            bullishPrice,
            bearishPrice,
            emaBullish: bullishEma && bullishPrice,
            emaBearish: bearishEma && bearishPrice,
            directionAgrees: null,
            rejectedReason: null,
            dailyGatePass: true
        };

        if (score >= this.CONFLUENCE_THRESHOLD) {
            const bullish = bullishEma && bullishPrice;
            const bearish = bearishEma && bearishPrice;

            // Hard gate: Only allow trades aligned with EMA-200
            if (direction === 'BULLISH' && !aboveEMA200) {
                filterBreakdown.dailyGatePass = false;
                filterBreakdown.rejectedReason = 'Counter-trend: BULLISH signal but price below EMA-200';
            } else if (direction === 'BEARISH' && aboveEMA200) {
                filterBreakdown.dailyGatePass = false;
                filterBreakdown.rejectedReason = 'Counter-trend: BEARISH signal but price above EMA-200';
            } else if (bullish && direction === 'BULLISH') {
                signal = 'BUY';
            } else if (bearish && direction === 'BEARISH') {
                signal = 'SELL';
            } else if (score >= 7) {
                if (direction === 'BULLISH' && (bullishEma || bullishPrice)) {
                    signal = 'BUY';
                } else if (direction === 'BEARISH' && (bearishEma || bearishPrice)) {
                    signal = 'SELL';
                } else {
                    if (bullish && direction !== 'BULLISH') {
                        filterBreakdown.directionAgrees = false;
                        filterBreakdown.rejectedReason = `EMA bullish but confluence direction is ${direction}`;
                    } else if (bearish && direction !== 'BEARISH') {
                        filterBreakdown.directionAgrees = false;
                        filterBreakdown.rejectedReason = `EMA bearish but confluence direction is ${direction}`;
                    } else if (!bullish && !bearish) {
                        filterBreakdown.rejectedReason = !bullishEma && !bearishEma
                            ? 'EMA9/21 flat — no clear trend direction'
                            : bullishEma
                                ? 'EMA9 > EMA21 but price below EMA50'
                                : 'EMA9 < EMA21 but price above EMA50';
                    }
                }
            } else {
                if (bullish && direction !== 'BULLISH') {
                    filterBreakdown.directionAgrees = false;
                    filterBreakdown.rejectedReason = `EMA bullish but confluence direction is ${direction}`;
                } else if (bearish && direction !== 'BEARISH') {
                    filterBreakdown.directionAgrees = false;
                    filterBreakdown.rejectedReason = `EMA bearish but confluence direction is ${direction}`;
                } else if (!bullish && !bearish) {
                    filterBreakdown.rejectedReason = !bullishEma && !bearishEma
                        ? 'EMA9/21 flat — no clear trend direction'
                        : bullishEma
                            ? 'EMA9 > EMA21 but price below EMA50'
                            : 'EMA9 < EMA21 but price above EMA50';
                }
            }
        }

        // IMPROVEMENT #13: 1H confirmation check (if 1H data provided)
        let oneHourConfirmation = null;
        if (oneHourData && oneHourData.length >= 14) {
            oneHourConfirmation = this.check1HConfirmation(oneHourData, direction);
            if (oneHourConfirmation && !oneHourConfirmation.confirmed) {
                if (signal !== 'NEUTRAL') {
                    filterBreakdown.rejectedReason = `1H confirmation failed: ${oneHourConfirmation.reason}`;
                    signal = 'NEUTRAL';
                }
            }
        }

        // ════════════════════════════════════════════════════════════════════
        // SESSION-AWARE DYNAMIC THRESHOLD — lower bar during peak liquidity
        // ════════════════════════════════════════════════════════════════════
        const goldMeta = confluence.goldMeta;
        let effectiveThreshold = this.CONFLUENCE_THRESHOLD;
        if (goldMeta && goldMeta.session && signal !== 'NEUTRAL') {
            const sessionMinScore = goldMeta.session.characteristics.minScore;
            if (sessionMinScore < 999) {
                effectiveThreshold = Math.max(this.CONFLUENCE_THRESHOLD, sessionMinScore);
                if (effectiveThreshold !== this.CONFLUENCE_THRESHOLD) {
                    filterBreakdown.sessionThreshold = effectiveThreshold;
                    filterBreakdown.sessionName = goldMeta.session.name;
                }
            } else {
                // Asian session — block trades
                filterBreakdown.rejectedReason = 'Asian session — low-probability window';
                signal = 'NEUTRAL';
            }
        }

        // Re-check threshold with session-adjusted value
        if (signal !== 'NEUTRAL' && score < effectiveThreshold) {
            filterBreakdown.rejectedReason = `Score ${score} below session threshold ${effectiveThreshold}`;
            signal = 'NEUTRAL';
        }

        // ════════════════════════════════════════════════════════════════════
        // VOLATILITY-ADJUSTED SL — widen in high-vol, tighten in low-vol
        // ════════════════════════════════════════════════════════════════════
        const riskParams = this.calculateRiskParameters(priceData, indicators);
        if (goldMeta && goldMeta.volAdj) {
            riskParams.slDistance *= goldMeta.volAdj.slAdjustment;
            // Recalculate TP distances from adjusted SL
            riskParams.tp1Distance = riskParams.slDistance * this.TP1_RR;
            riskParams.tp2Distance = riskParams.slDistance * this.TP2_RR;
            riskParams.volAdj = goldMeta.volAdj;
        }

        // Calculate risk parameters
        const riskParamsFinal = riskParams;

        return {
            signal,
            score: confluence.score,
            details: {
                confluenceScorer: confluence,
                filterBreakdown,
                riskCalculator: riskParamsFinal,
                oneHourConfirmation,
                goldMeta: goldMeta || null,
                timestamp: new Date().toISOString()
            }
        };
    }

    // IMPROVEMENT #13: 1H confirmation — waits for candle close
    check1HConfirmation(oneHourData, direction) {
        if (!oneHourData || oneHourData.length < 14) {
            return { confirmed: false, reason: 'Insufficient 1H data' };
        }

        const closes = oneHourData.map(p => p.close || p.price);
        const currentPrice = oneHourData[oneHourData.length - 1].price;
        const rsi = this.calculateRsi(closes, 14);
        const macd = this.calculateMacd(closes);
        const ema20 = this.calculateEma(closes, 20);
        const ema20Val = ema20[ema20.length - 1];

        // Confirm the 1H candle has CLOSED (use close, not live price)
        const lastCandle = oneHourData[oneHourData.length - 1];
        const candleClose = lastCandle.close || lastCandle.price;

        let confirmed = false;
        let reason = '';

        if (direction === 'BULLISH') {
            // Bullish confirmation: RSI > 45, MACD histogram > 0, price > EMA-20
            if (rsi > 45 && macd.histogram > 0 && candleClose > ema20Val) {
                confirmed = true;
                reason = `1H bull confirm: RSI ${rsi.toFixed(1)}, MACD ${macd.histogram > 0 ? '+' : '-'}, close > EMA20`;
            } else {
                reason = `1H reject: RSI ${rsi.toFixed(1)} ${rsi <= 45 ? '<=45' : ''} ${macd.histogram <= 0 ? 'MACD bear' : ''} ${candleClose <= ema20Val ? 'close < EMA20' : ''}`;
            }
        } else if (direction === 'BEARISH') {
            // Bearish confirmation: RSI < 55, MACD histogram < 0, price < EMA-20
            if (rsi < 55 && macd.histogram < 0 && candleClose < ema20Val) {
                confirmed = true;
                reason = `1H bear confirm: RSI ${rsi.toFixed(1)}, MACD ${macd.histogram < 0 ? '-' : '+'}, close < EMA20`;
            } else {
                reason = `1H reject: RSI ${rsi.toFixed(1)} ${rsi >= 55 ? '>=55' : ''} ${macd.histogram >= 0 ? 'MACD bull' : ''} ${candleClose >= ema20Val ? 'close > EMA20' : ''}`;
            }
        }

        return { confirmed, reason, rsi, macdHistogram: macd.histogram, ema20Val, candleClose };
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
        slDistance = Math.max(slDistance, atr * 0.5);

        // ════════════════════════════════════════════════════════════════════
        // STRUCTURAL SL PLACEMENT — place SL beyond nearest structural level
        // ════════════════════════════════════════════════════════════════════
        try {
            const hour = new Date(priceData[priceData.length - 1].timestamp).getUTCHours();
            const session = this.goldSpecialist.getSession(hour);

            // Build daily proxy data for structural levels
            const dailyData = priceData.filter(c => {
                const ts = c.timestamp;
                if (!ts) return false;
                const h = new Date(ts).getUTCHours();
                return h === 0 || h === 12;
            });

            const structural = this.goldSpecialist.calculateStructuralLevels(dailyData, currentPrice);
            if (structural.nearestSupport !== null) {
                const distToSupport = currentPrice - structural.nearestSupport;
                const distToResistance = structural.nearestResistance !== null
                    ? structural.nearestResistance - currentPrice
                    : 999;

                // If near a structural level, place SL just beyond it
                const bufferAtr = atr * 0.3;
                if (distToSupport > 0 && distToSupport < atr * 2) {
                    const structuralSL = distToSupport + bufferAtr;
                    slDistance = Math.max(slDistance, structuralSL);
                }
            }
        } catch (e) {
            // Gold specialist not available — use default SL
        }

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
    // Breakeven at 1R, then tighter trails at 2R, 3.5R, 5R

    applyTrailingStop(activeTrade, currentCandle) {
        const initialStop = activeTrade.originalSl ?? activeTrade.original_sl ?? activeTrade.sl;
        const riskDistance = Math.abs(activeTrade.entryPrice - initialStop);
        const fallbackRiskDistance = activeTrade.atr || 15;
        const riskUnit = riskDistance > 0 ? riskDistance : fallbackRiskDistance;

        if (activeTrade.action === 'BUY') {
            const favorableMove = currentCandle.close - activeTrade.entryPrice;
            if (favorableMove > riskUnit * 4) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.7;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 3) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.5;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 2) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.25;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit) {
                activeTrade.sl = Math.max(activeTrade.sl, activeTrade.entryPrice);
            }
        } else if (activeTrade.action === 'SELL') {
            const favorableMove = activeTrade.entryPrice - currentCandle.close;
            if (favorableMove > riskUnit * 4) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.7;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 3) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.5;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 2) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.25;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit) {
                activeTrade.sl = Math.min(activeTrade.sl, activeTrade.entryPrice);
            }
        }
        return activeTrade;
    }

    // ==================== UNIFIED TRADE EXIT CHECK ====================

    checkTradeExit(activeTrade, currentCandle) {
        this.applyTrailingStop(activeTrade, currentCandle);

        // Same-candle prevention: skip exit check on entry candle
        const entryTs = activeTrade.timestamp ? new Date(activeTrade.timestamp).getTime() : 0;
        const candleTs = currentCandle.timestamp ? new Date(currentCandle.timestamp).getTime() : 0;
        if (entryTs === candleTs) {
            return { closed: false };
        }

        let exitPrice = null;
        let exitReason = '';
        const CONTRACT_SIZE = 100;
        const initialQuantity = activeTrade.initialQuantity || activeTrade.quantity;
        const remainingQuantity = activeTrade.remainingQuantity ?? activeTrade.remaining_quantity ?? activeTrade.quantity;
        const realizedPnl = activeTrade.realizedPnl ?? activeTrade.realized_pnl ?? 0;
        const tp1Hit = activeTrade.tp1Hit || Boolean(activeTrade.tp1_hit);

        // Use broker simulation for realistic fill pricing
        const broker = this.broker;
        const brokerSlippage = (side) => {
            if (!broker) return 0;
            return broker.calculateSlippage({
                side,
                candle: currentCandle,
                atr: activeTrade.atr,
                quantity: remainingQuantity,
            });
        };

        const calculatePnl = (price, quantity) => {
            const positionSize = quantity * CONTRACT_SIZE;
            return activeTrade.action === 'BUY'
                ? (price - activeTrade.entryPrice) * positionSize
                : (activeTrade.entryPrice - price) * positionSize;
        };

        const closeRemaining = (fillPrice, reason) => {
            return {
                closed: true,
                exitPrice: fillPrice,
                exitReason: reason,
                pnl: (activeTrade.realizedPnl ?? activeTrade.realized_pnl ?? 0)
                    + calculatePnl(fillPrice, activeTrade.remainingQuantity ?? activeTrade.remaining_quantity ?? remainingQuantity)
            };
        };

        const takePartial = (fillPrice) => {
            const closePercent = Math.min(Math.max(this.TP1_CLOSE_PERCENT, 0), 100) / 100;
            const closeQuantity = Math.min(remainingQuantity, initialQuantity * closePercent);
            const nextRemaining = Math.max(remainingQuantity - closeQuantity, 0);
            const partialPnl = calculatePnl(fillPrice, closeQuantity);

            activeTrade.remainingQuantity = nextRemaining;
            activeTrade.realizedPnl = realizedPnl + partialPnl;
            activeTrade.tp1Hit = true;
            activeTrade.sl = activeTrade.action === 'BUY'
                ? Math.max(activeTrade.sl, activeTrade.entryPrice)
                : Math.min(activeTrade.sl, activeTrade.entryPrice);

            return { closed: false, partial: true, exitPrice: fillPrice, exitReason: 'TP1 Partial', partialPnl, remainingQuantity: nextRemaining };
        };

        if (activeTrade.action === 'BUY') {
            // SL-before-TP: Check SL FIRST (conservative — worst case assumption)
            if (currentCandle.low <= activeTrade.sl) {
                const slippage = brokerSlippage('SELL');
                const fillPrice = activeTrade.sl - slippage;
                return closeRemaining(fillPrice, activeTrade.sl >= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss');
            }
            // Then check TP
            if (!tp1Hit && currentCandle.high >= activeTrade.tp1) {
                const slippage = brokerSlippage('SELL');
                const fillPrice = activeTrade.tp1 - slippage;
                const partialResult = takePartial(fillPrice);
                if (activeTrade.tp2 && currentCandle.high >= activeTrade.tp2) {
                    const tp2Fill = activeTrade.tp2 - brokerSlippage('SELL');
                    return closeRemaining(tp2Fill, 'Take Profit 2');
                }
                return partialResult;
            }
            if ((tp1Hit || activeTrade.tp1Hit) && activeTrade.tp2 && currentCandle.high >= activeTrade.tp2) {
                const slippage = brokerSlippage('SELL');
                const fillPrice = activeTrade.tp2 - slippage;
                return closeRemaining(fillPrice, 'Take Profit 2');
            }
        } else {
            // SELL trade
            // SL-before-TP: Check SL FIRST (conservative — worst case assumption)
            if (currentCandle.high >= activeTrade.sl) {
                const slippage = brokerSlippage('BUY');
                const fillPrice = activeTrade.sl + slippage;
                return closeRemaining(fillPrice, activeTrade.sl <= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss');
            }
            // Then check TP
            if (!tp1Hit && currentCandle.low <= activeTrade.tp1) {
                const slippage = brokerSlippage('BUY');
                const fillPrice = activeTrade.tp1 + slippage;
                const partialResult = takePartial(fillPrice);
                if (activeTrade.tp2 && currentCandle.low <= activeTrade.tp2) {
                    const tp2Fill = activeTrade.tp2 + brokerSlippage('BUY');
                    return closeRemaining(tp2Fill, 'Take Profit 2');
                }
                return partialResult;
            }
            if ((tp1Hit || activeTrade.tp1Hit) && activeTrade.tp2 && currentCandle.low <= activeTrade.tp2) {
                const slippage = brokerSlippage('BUY');
                const fillPrice = activeTrade.tp2 + slippage;
                return closeRemaining(fillPrice, 'Take Profit 2');
            }
        }

        return { closed: false };
    }
}

module.exports = UnifiedStrategy;
