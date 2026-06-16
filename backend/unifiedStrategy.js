/**
 * UNIFIED STRATEGY MODULE — XAU/USD (Gold)
 * Single source of truth for signal generation, confluence scoring, and risk management.
 * Tuned specifically for gold's price action characteristics.
 * Used by both the live bot and standalone backtest.
 */

class UnifiedStrategy {
    constructor() {
        const numberFromEnv = (key, fallback) => {
            const value = Number(process.env[key]);
            return Number.isFinite(value) ? value : fallback;
        };

        this.CONFLUENCE_THRESHOLD = numberFromEnv('CONFLUENCE_THRESHOLD', 6); // Minimum score to take a trade
        this.MAX_SCORE = 10;
        this.MIN_DIRECTIONAL_MARGIN = numberFromEnv('MIN_DIRECTIONAL_MARGIN', 1);
        this.FIXED_QUANTITY = Number(process.env.XAU_QUANTITY) || 0.01;  // Configurable via env
        this.TP1_RR = numberFromEnv('TP1_RR', 3);   // 1:3 Risk-Reward for TP1 by default
        this.TP2_RR = numberFromEnv('TP2_RR', 5);   // 1:5 Risk-Reward for TP2 by default
        this.TP1_CLOSE_PERCENT = numberFromEnv('TP1_CLOSE_PERCENT', 50);
        this.weights = {
            trend: numberFromEnv('WEIGHT_TREND', 1.2),
            rsi: numberFromEnv('WEIGHT_RSI', 0.8),
            macd: numberFromEnv('WEIGHT_MACD', 1),
            cpr: numberFromEnv('WEIGHT_CPR', 0.8),
            vwap: numberFromEnv('WEIGHT_VWAP', 0.8),
            liquidity: numberFromEnv('WEIGHT_LIQUIDITY', 1.4),
            wyckoffBonus: numberFromEnv('WEIGHT_WYCKOFF_BONUS', 0.8),
            ote: numberFromEnv('WEIGHT_OTE', 0.9),
            obfvg: numberFromEnv('WEIGHT_OBFVG', 1.2),
            structure: numberFromEnv('WEIGHT_STRUCTURE', 1.3),
            volume: numberFromEnv('WEIGHT_VOLUME', 0.7)
        };
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
        const bearStrength = bearFvgCount + bearObCount;
        const fvgCount = bullFvgCount + bearFvgCount;
        const obCount = bullObCount + bearObCount;

        let signal = 'NEUTRAL';
        if (bullStrength > bearStrength && bullStrength > 2) signal = 'BULLISH';
        else if (bearStrength > bullStrength && bearStrength > 2) signal = 'BEARISH';

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

        // Track bullish and bearish confluence SEPARATELY
        let bullScore = 0, bearScore = 0;
        const details = [];

        // Factor 1: EMA-50 Trend
        if (currentPrice > ema50Val && currentPrice > prevPrice) { bullScore += this.weights.trend; details.push('Trend ↑'); }
        else if (currentPrice < ema50Val && currentPrice < prevPrice) { bearScore += this.weights.trend; details.push('Trend ↓'); }

        // Factor 2: RSI Confirmation (tighter, direction-specific ranges)
        if (rsi > 50 && rsi < 65) { bullScore += this.weights.rsi; details.push(`RSI: ${rsi.toFixed(1)} (bull zone)`); }
        else if (rsi > 35 && rsi < 50) { bearScore += this.weights.rsi; details.push(`RSI: ${rsi.toFixed(1)} (bear zone)`); }

        // Factor 3: MACD Confirmation (FIXED: requires meaningful magnitude, not just != 0)
        const macdThreshold = currentPrice * 0.0001; // 0.01% of price = ~$0.44 for gold at $4400
        if (macd.histogram > macdThreshold) { bullScore += this.weights.macd; details.push('MACD bull'); }
        else if (macd.histogram < -macdThreshold) { bearScore += this.weights.macd; details.push('MACD bear'); }

        // Factor 4: CPR PP Alignment (tighter for gold — 1.5% vs 3% for BTC)
        if (cpr.signal === 'BULLISH' && Math.abs(cpr.distToPP) < 0.015) { bullScore += this.weights.cpr; details.push('CPR PP ↑'); }
        else if (cpr.signal === 'BEARISH' && Math.abs(cpr.distToPP) < 0.015) { bearScore += this.weights.cpr; details.push('CPR PP ↓'); }

        // Factor 5: VWAP Alignment
        if (vwap.signal === 'BULLISH') { bullScore += this.weights.vwap; details.push('VWAP ↑'); }
        else if (vwap.signal === 'BEARISH') { bearScore += this.weights.vwap; details.push('VWAP ↓'); }

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

        // Factor 7: OTE Zone (Fibonacci 62-79%)
        if (ote.signal === 'BULLISH') { bullScore += this.weights.ote; details.push('OTE bull'); }
        else if (ote.signal === 'BEARISH') { bearScore += this.weights.ote; details.push('OTE bear'); }

        // Factor 8: Order Block / FVG
        if (obfvg.signal === 'BULLISH' && obfvg.strength > 2) { bullScore += this.weights.obfvg; details.push('OB/FVG ↑'); }
        else if (obfvg.signal === 'BEARISH' && obfvg.strength > 2) { bearScore += this.weights.obfvg; details.push('OB/FVG ↓'); }

        // Factor 9: CHoCH / BOS Structure Break
        if (structure.signal === 'BULLISH') { bullScore += this.weights.structure; details.push('BOS/CHoCH ↑'); }
        else if (structure.signal === 'BEARISH') { bearScore += this.weights.structure; details.push('BOS/CHoCH ↓'); }

        // Factor 10: Volume Confirmation (direction-neutral)
        if (recentVol > prevVol * 1.1) {
            // Volume confirms the dominant direction
            if (bullScore > bearScore) { bullScore += this.weights.volume; details.push('Vol confirms ↑'); }
            else if (bearScore > bullScore) { bearScore += this.weights.volume; details.push('Vol confirms ↓'); }
        }

        // The score is the MAX of the two directional scores — conflicting signals DON'T stack
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
            direction, // NEW: tells analyze() which way confluence is pointing
            scoreMargin,
            bullScore,
            bearScore,
            indicators: { rsi, macd, cpr, vwap, liquidity, ote, obfvg, structure, ema50Val }
        };
    }

    // ==================== UNIFIED SIGNAL GENERATION ====================

    analyze(priceData) {
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

        let filterBreakdown = {
            scoreMet: score >= this.CONFLUENCE_THRESHOLD,
            threshold: this.CONFLUENCE_THRESHOLD,
            score,
            confluenceDirection: direction,
            ema9Val,
            ema21Val,
            ema50Val: indicators.ema50Val,
            currentPrice,
            bullishEma,
            bearishEma,
            bullishPrice,
            bearishPrice,
            emaBullish: bullishEma && bullishPrice,
            emaBearish: bearishEma && bearishPrice,
            directionAgrees: null,
            rejectedReason: null
        };

        if (score >= this.CONFLUENCE_THRESHOLD) {
            const bullish = bullishEma && bullishPrice;
            const bearish = bearishEma && bearishPrice;

            if (bullish && direction === 'BULLISH') {
                signal = 'BUY';
            } else if (bearish && direction === 'BEARISH') {
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
        }

        // Calculate risk parameters
        const riskParams = this.calculateRiskParameters(priceData, indicators);

        return {
            signal,
            score: confluence.score,
            details: {
                confluenceScorer: confluence,
                filterBreakdown,
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
        const initialStop = activeTrade.originalSl ?? activeTrade.original_sl ?? activeTrade.sl;
        const riskDistance = Math.abs(activeTrade.entryPrice - initialStop);
        const fallbackRiskDistance = activeTrade.atr || 15; // Gold ATR ~$15-30 on 6H
        const riskUnit = riskDistance > 0 ? riskDistance : fallbackRiskDistance;

        if (activeTrade.action === 'BUY') {
            const favorableMove = currentCandle.close - activeTrade.entryPrice;
            if (favorableMove > riskUnit * 5) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.8;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 3.5) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.6;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 2) {
                const be = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.1;
                activeTrade.sl = Math.max(activeTrade.sl, be);
            }
        } else if (activeTrade.action === 'SELL') {
            const favorableMove = activeTrade.entryPrice - currentCandle.close;
            if (favorableMove > riskUnit * 5) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.8;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 3.5) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.6;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 2) {
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
        const CONTRACT_SIZE = 100;
        const initialQuantity = activeTrade.initialQuantity || activeTrade.quantity;
        const remainingQuantity = activeTrade.remainingQuantity ?? activeTrade.remaining_quantity ?? activeTrade.quantity;
        const realizedPnl = activeTrade.realizedPnl ?? activeTrade.realized_pnl ?? 0;
        const tp1Hit = activeTrade.tp1Hit || Boolean(activeTrade.tp1_hit);

        const calculatePnl = (price, quantity) => {
            const positionSize = quantity * CONTRACT_SIZE;
            return activeTrade.action === 'BUY'
                ? (price - activeTrade.entryPrice) * positionSize
                : (activeTrade.entryPrice - price) * positionSize;
        };

        const closeRemaining = (price, reason) => ({
            closed: true,
            exitPrice: price,
            exitReason: reason,
            pnl: (activeTrade.realizedPnl ?? activeTrade.realized_pnl ?? 0)
                + calculatePnl(price, activeTrade.remainingQuantity ?? activeTrade.remaining_quantity ?? remainingQuantity)
        });

        const takePartial = (price) => {
            const closePercent = Math.min(Math.max(this.TP1_CLOSE_PERCENT, 0), 100) / 100;
            const closeQuantity = Math.min(remainingQuantity, initialQuantity * closePercent);
            const nextRemaining = Math.max(remainingQuantity - closeQuantity, 0);
            const partialPnl = calculatePnl(price, closeQuantity);

            activeTrade.remainingQuantity = nextRemaining;
            activeTrade.realizedPnl = realizedPnl + partialPnl;
            activeTrade.tp1Hit = true;
            activeTrade.sl = activeTrade.action === 'BUY'
                ? Math.max(activeTrade.sl, activeTrade.entryPrice)
                : Math.min(activeTrade.sl, activeTrade.entryPrice);

            return { closed: false, partial: true, exitPrice: price, exitReason: 'TP1 Partial', partialPnl, remainingQuantity: nextRemaining };
        };

        if (activeTrade.action === 'BUY') {
            if (currentCandle.low <= activeTrade.sl) {
                return closeRemaining(activeTrade.sl, activeTrade.sl >= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss');
            }
            if (!tp1Hit && currentCandle.high >= activeTrade.tp1) {
                const partialResult = takePartial(activeTrade.tp1);
                if (activeTrade.tp2 && currentCandle.high >= activeTrade.tp2) {
                    return closeRemaining(activeTrade.tp2, 'Take Profit 2');
                }
                return partialResult;
            }
            if ((tp1Hit || activeTrade.tp1Hit) && activeTrade.tp2 && currentCandle.high >= activeTrade.tp2) {
                return closeRemaining(activeTrade.tp2, 'Take Profit 2');
            }
        } else {
            if (currentCandle.high >= activeTrade.sl) {
                return closeRemaining(activeTrade.sl, activeTrade.sl <= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss');
            }
            if (!tp1Hit && currentCandle.low <= activeTrade.tp1) {
                const partialResult = takePartial(activeTrade.tp1);
                if (activeTrade.tp2 && currentCandle.low <= activeTrade.tp2) {
                    return closeRemaining(activeTrade.tp2, 'Take Profit 2');
                }
                return partialResult;
            }
            if ((tp1Hit || activeTrade.tp1Hit) && activeTrade.tp2 && currentCandle.low <= activeTrade.tp2) {
                return closeRemaining(activeTrade.tp2, 'Take Profit 2');
            }
        }

        return { closed: false };
    }
}

module.exports = UnifiedStrategy;
