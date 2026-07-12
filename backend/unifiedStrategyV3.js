/**
 * UnifiedGoldStrategy V4 — Bias-Free Regime-Adaptive Confluence
 *
 * V4 changes vs V3:
 *  - REMOVED all hard directional gates (EMA200, EMA50/EMA200 trend direction).
 *    These created systematic bias: 13/17 trades were SELL, all losing.
 *  - Lowered confluence threshold from 6.5 → 5.0 for more trade frequency.
 *  - Regime detection now uses real ADX instead of EMA-diff approximation.
 *  - Trailing stop less aggressive: lock breakeven at 3.5R (was 2R).
 *  - EMA alignment is a score bonus, not a hard reject.
 *  - Counter-trend allowance: if confluence strongly favors opposite direction,
 *    the trade is allowed regardless of EMA position.
 *  - Fix trailing stop lock-in: only lock BE after TP1 partial or 3.5R move.
 */

class UnifiedStrategy {
    constructor(config = {}) {
        // ═══════════════════════════════════════════════════════════════
        // CORE THRESHOLD
        // ═══════════════════════════════════════════════════════════════
        this.CONFLUENCE_THRESHOLD = config.confluenceThreshold ?? 5.5;
        this.interval = config.interval || 360;

        // ═══════════════════════════════════════════════════════════════
        // V3 CORE FACTOR WEIGHTS (must sum to 1.0)
        // ═══════════════════════════════════════════════════════════════
        this.CORE_WEIGHTS = {
            trend:       0.35,   // EMA stack + price vs EMA50
            pullback:    0.30,   // Fib zone quality
            momentum:    0.25,   // RSI + MACD alignment
            structure:   0.10,   // BOS / OB / FVG — tie-breaker only
        };

        // ═══════════════════════════════════════════════════════════════
        // V4-PLUS: VOF STRUCTURE CONSTANTS
        // ═══════════════════════════════════════════════════════════════
        this.PIVOT_LOOKBACK = 3;          // Bars left/right for swing detection
        this.VP_ROWS = 15;                // Volume profile rows
        this.VP_WEIGHT_BODY = 1.5;       // Body closeness multiplier
        this.MANIP_SWEEP_THRESHOLD = 0.2; // OB sweep buffer as ATR fraction

        // ═══════════════════════════════════════════════════════════════
        // V3 VOLATILITY REGIME → ADAPTIVE TP/SL
        // ═══════════════════════════════════════════════════════════════
        this.REGIME_TP1_RR = {
            trending:  1.5,
            ranging:   1.0,
            volatile:  2.0,
        };
        this.REGIME_TP2_RR = {
            trending:  2.5,
            ranging:   1.5,
            volatile:  3.0,
        };
        this.TP1_CLOSE_PERCENT = config.tp1ClosePercent ?? 50; // Default 50% at TP1
        this.MAX_SL_DISTANCE = config.maxSlDistance ?? Infinity;

        // Optimizer-tunable params (via env vars or config object)
        this.SCORE_MARGIN_MIN = config.scoreMarginMin ?? (Number(process.env.SCORE_MARGIN_MIN) || 1.0);
        this.BUY_SCORE_MARGIN = config.buyScoreMargin ?? (Number(process.env.BUY_SCORE_MARGIN) || 2.0);
        this.EMA_ALIGNMENT_REQUIRED = config.emaAlignmentRequired ?? (process.env.EMA_ALIGNMENT_REQUIRED === 'true' || false);

        // V5: Zero-Lag Trend parameters (from AlgoAlpha indicator)
        this.ZLEMA_LENGTH = config.zlemaLength ?? (Number(process.env.ZLEMA_LENGTH) || 70);
        this.ZLEMA_MULT = config.zlemaMult ?? (Number(process.env.ZLEMA_MULT) || 1.2);
        this.ZLEMA_REQUIRED = config.zlemaRequired ?? (process.env.ZLEMA_REQUIRED === 'true' || false);
        this.ZLEMA_ENTRY_REQUIRED = config.zlemaEntryRequired ?? (process.env.ZLEMA_ENTRY_REQUIRED !== 'false');

        // Convenience aliases for external consumers (tradingBot backtest, etc.)
        this.TP1_RR = config.tp1RR ?? null;
        this.TP2_RR = config.tp2RR ?? null;

        // ═══════════════════════════════════════════════════════════════
        // GOLD SPECIALIST (shared module)
        // ═══════════════════════════════════════════════════════════════
        let GoldSpecialist;
        try { GoldSpecialist = require('./goldSpecialist'); } catch { try { GoldSpecialist = require('./strategies/goldSpecialist'); } catch {} }
        this.goldSpecialist = GoldSpecialist ? new GoldSpecialist() : null;

        // ═══════════════════════════════════════════════════════════════
        // BROKER SIMULATION (optional)
        // ═══════════════════════════════════════════════════════════════
        let BrokerSimulator;
        try { BrokerSimulator = require('./brokerSimulation'); } catch { try { BrokerSimulator = require('./utils/brokerSimulation'); } catch {} }
        this.broker = config.broker ?? (BrokerSimulator ? new BrokerSimulator() : null);
    }

    // ═══════════════════════════════════════════════════════════════════
    // INDICATOR LIBRARY (unchanged from V2 — battle-tested)
    // ═══════════════════════════════════════════════════════════════════

    calculateRsi(closes, period = 14) {
        if (!closes || closes.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = closes.length - period; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff; else losses -= diff;
        }
        if (losses === 0) return 100;
        const rs = gains / losses;
        return 100 - (100 / (1 + rs));
    }

    calculateMacd(closes) {
        if (!closes || closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
        const ema12 = this.calculateEma(closes, 12);
        const ema26 = this.calculateEma(closes, 26);
        const macdLine = ema12.map((v, i) => v - ema26[i]);
        const signalLine = this.calculateEma(macdLine.slice(26), 9);
        const lastMacd = macdLine[macdLine.length - 1];
        const lastSignal = signalLine[signalLine.length - 1];
        return { macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal };
    }

    calculateEma(data, period) {
        if (!data || data.length === 0) return [];
        const k = 2 / (period + 1);
        const ema = [data[0]];
        for (let i = 1; i < data.length; i++) {
            ema.push(data[i] * k + ema[i - 1] * (1 - k));
        }
        return ema;
    }

    calculateBollingerBands(closes, period = 20, stdDev = 2) {
        if (!closes || closes.length < period) return { upper: 0, middle: 0, lower: 0 };
        const slice = closes.slice(-period);
        const mean = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
        const std = Math.sqrt(variance);
        return { upper: mean + std * stdDev, middle: mean, lower: mean - std * stdDev };
    }

    calculateAtr(priceData, period = 14) {
        if (!priceData || priceData.length < period + 1) return 15;
        const trs = [];
        for (let i = priceData.length - period; i < priceData.length; i++) {
            const high = priceData[i].high ?? priceData[i].price;
            const low = priceData[i].low ?? priceData[i].price;
            const prevClose = priceData[i - 1].close ?? priceData[i - 1].price;
            trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        return trs.reduce((a, b) => a + b, 0) / trs.length;
    }

    calculateCPR(priceData) {
        if (!priceData || priceData.length < 2) return { pivot: null, bc: null, tc: null };
        const slice = priceData.slice(-2);
        const high = Math.max(...slice.map(c => c.high ?? c.price));
        const low = Math.min(...slice.map(c => c.low ?? c.price));
        const close = slice[slice.length - 1].close ?? slice[slice.length - 1].price;
        const pivot = (high + low + close) / 3;
        return { pivot, bc: (high + low) / 2, tc: 2 * pivot - low };
    }

    calculateFibonacciLevels(priceData) {
        if (!priceData || priceData.length < 20) return null;
        const recent = priceData.slice(-60);
        const high = Math.max(...recent.map(c => c.high ?? c.price));
        const low = Math.min(...recent.map(c => c.low ?? c.price));
        return {
            high, low,
            '0.0': high,
            '0.236': high - (high - low) * 0.236,
            '0.382': high - (high - low) * 0.382,
            '0.5': high - (high - low) * 0.5,
            '0.618': high - (high - low) * 0.618,
            '0.786': high - (high - low) * 0.786,
            '1.0': low,
        };
    }

    detectLiquiditySweep(priceData) {
        if (!priceData || priceData.length < 20) return { sweepLevel: null, sweepType: null };
        const lookback = priceData.slice(-20);
        const highs = lookback.map(c => c.high ?? c.price);
        const lows = lookback.map(c => c.low ?? c.price);
        const maxHigh = Math.max(...highs);
        const minLow = Math.min(...lows);
        const last = lookback[lookback.length - 1];
        const lastHigh = last.high ?? last.price;
        const lastLow = last.low ?? last.price;
        if (lastHigh > maxHigh * 1.001) return { sweepLevel: maxHigh, sweepType: 'BUY_STOP_HUNT' };
        if (lastLow < minLow * 0.999) return { sweepLevel: minLow, sweepType: 'SELL_STOP_HUNT' };
        return { sweepLevel: null, sweepType: null };
    }

    detectOrderBlock(priceData) {
        if (!priceData || priceData.length < 10) return { bullOB: null, bearOB: null };
        const slice = priceData.slice(-20);
        let bullOB = null, bearOB = null;
        for (let i = 1; i < slice.length - 1; i++) {
            const prev = slice[i - 1], curr = slice[i], next = slice[i + 1];
            const prevBody = (prev.close ?? prev.price) - (prev.open ?? prev.price);
            const currBody = (curr.close ?? curr.price) - (curr.open ?? curr.price);
            const nextBody = (next.close ?? next.price) - (next.open ?? next.price);
            if (prevBody > 0 && currBody < 0 && nextBody > 0 && Math.abs(currBody) > Math.abs(prevBody) * 1.2) {
                bearOB = { high: curr.high ?? curr.price, low: curr.low ?? curr.price, index: i };
            }
            if (prevBody < 0 && currBody > 0 && nextBody < 0 && Math.abs(currBody) > Math.abs(prevBody) * 1.2) {
                bullOB = { high: curr.high ?? curr.price, low: curr.low ?? curr.price, index: i };
            }
        }
        return { bullOB, bearOB };
    }

    detectFVG(priceData) {
        if (!priceData || priceData.length < 5) return [];
        const fvgs = [];
        const slice = priceData.slice(-20);
        for (let i = 2; i < slice.length; i++) {
            const c1 = slice[i - 2], c3 = slice[i];
            const c1High = c1.high ?? c1.price, c3Low = c3.low ?? c3.price;
            if (c3Low > c1High) fvgs.push({ type: 'bullFVG', top: c3Low, bottom: c1High, index: i });
            const c1Low = c1.low ?? c1.price, c3High = c3.high ?? c3.price;
            if (c3High < c1Low) fvgs.push({ type: 'bearFVG', top: c1Low, bottom: c3High, index: i });
        }
        return fvgs;
    }

    calculateStochastic(priceData, period = 14) {
        if (!priceData || priceData.length < period) return { k: 50, d: 50 };
        const slice = priceData.slice(-period);
        const highs = slice.map(c => c.high ?? c.price);
        const lows = slice.map(c => c.low ?? c.price);
        const highest = Math.max(...highs);
        const lowest = Math.min(...lows);
        const close = priceData[priceData.length - 1].close ?? priceData[priceData.length - 1].price;
        if (highest === lowest) return { k: 50, d: 50 };
        const k = ((close - lowest) / (highest - lowest)) * 100;
        return { k, d: k };
    }

    calculateSupertrend(priceData, period = 10, multiplier = 3) {
        if (!priceData || priceData.length < period + 1) return { direction: 'NEUTRAL', value: 0 };
        const atr = this.calculateAtr(priceData, period);
        const last = priceData[priceData.length - 1];
        const mid = ((last.high ?? last.price) + (last.low ?? last.price)) / 2;
        return { direction: last.close > mid + atr * multiplier ? 'BULLISH' : last.close < mid - atr * multiplier ? 'BEARISH' : 'NEUTRAL', value: mid };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V5 Zero-Lag Trend Signals (ZLEMA) — AlgoAlpha indicator
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Calculate Zero-Lag EMA — EMA applied to de-lagged source.
     * zlema = EMA(src + (src - src[lag]), length)
     * where lag = floor((length - 1) / 2)
     */
    calculateZLEMA(closes, length = 70) {
        if (!closes || closes.length < length + 2) return [];
        const lag = Math.floor((length - 1) / 2);
        const deLagSrc = [];
        for (let i = lag; i < closes.length; i++) {
            deLagSrc.push(closes[i] + (closes[i] - closes[i - lag]));
        }
        return this.calculateEma(deLagSrc, length);
    }

    /**
     * Detect ZLEMA trend state from Pine Script logic:
     *   trend = 1  when crossover(close, zlema + volatility)
     *   trend = -1 when crossunder(close, zlema - volatility)
     *   where volatility = highest(ATR(length), length*3) * mult
     *
     * Returns object with current trend state and MTF-friendly signal array.
     */
    _calculateZLEMATrend(priceData, length = 70, mult = 1.2) {
        if (!priceData || priceData.length < length + 10) {
            return { trend: 0, zlema: null, upper: null, lower: null, signal: 'NEUTRAL', zlemaEntry: false };
        }

        const closes = priceData.map(p => p.close ?? p.price);
        const zlemaVals = this.calculateZLEMA(closes, length);
        if (zlemaVals.length === 0) return { trend: 0, zlema: null, upper: null, lower: null, signal: 'NEUTRAL', zlemaEntry: false };

        // Compute ATR array for volatility band
        const atrPeriod = length;
        const atrVals = [];
        for (let i = atrPeriod; i <= priceData.length; i++) {
            atrVals.push(this.calculateAtr(priceData.slice(0, i), atrPeriod));
        }

        // Align arrays — zlemaVals and atrVals must have same length
        const zlemaLen = zlemaVals.length;
        const atrLen = atrVals.length;
        // Build aligned close array
        const alignedCloses = closes.slice(-Math.min(zlemaLen, atrLen));

        // Compute volatility band: highest(ATR, length*3) * mult
        const volLookback = length * 3;
        const volatility = [];
        for (let i = 0; i < atrLen; i++) {
            const start = Math.max(0, i - volLookback + 1);
            const slice = atrVals.slice(start, i + 1);
            const highestAtr = slice.length > 0 ? Math.max(...slice) : 0;
            volatility.push(highestAtr * mult);
        }

        // Detect trend state (replicate Pine Script logic)
        const n = Math.min(zlemaLen, atrLen, alignedCloses.length);
        const trendArr = new Array(n).fill(0);
        for (let i = 1; i < n; i++) {
            const prevTrend = trendArr[i - 1];
            const currClose = alignedCloses[i];
            const prevClose = alignedCloses[i - 1];
            const zlema_i = zlemaVals[zlemaVals.length - n + i];
            const prevZlema = zlemaVals[zlemaVals.length - n + i - 1];
            const vol_i = volatility[volatility.length - n + i];
            const prevVol = volatility[volatility.length - n + i - 1];

            // crossover(close, zlema + volatility): close crossed above band
            if (prevClose <= prevZlema + prevVol && currClose > zlema_i + vol_i) {
                trendArr[i] = 1;
            }
            // crossunder(close, zlema - volatility): close crossed below band
            else if (prevClose >= prevZlema - prevVol && currClose < zlema_i - vol_i) {
                trendArr[i] = -1;
            } else {
                trendArr[i] = prevTrend;
            }
        }

        const currentTrend = trendArr[trendArr.length - 1] || 0;
        const prevTrend = trendArr[trendArr.length - 2] || 0;
        const currZlema = zlemaVals[zlemaVals.length - 1];
        const prevZlemaVal = zlemaVals[zlemaVals.length - 2];
        const currClose = alignedCloses[alignedCloses.length - 1];
        const prevClose = alignedCloses[alignedCloses.length - 2];
        const vol = volatility[volatility.length - 1];

        // Entry signals (Pine Script logic)
        // Bullish: crossover(close, zlema) AND trend == 1 AND trend[1] == 1
        const bullCross = prevClose <= prevZlemaVal && currClose > currZlema;
        const bullEntry = bullCross && currentTrend === 1 && prevTrend === 1;
        // Bearish: crossunder(close, zlema) AND trend == -1 AND trend[1] == -1
        const bearCross = prevClose >= prevZlemaVal && currClose < currZlema;
        const bearEntry = bearCross && currentTrend === -1 && prevTrend === -1;

        let signal = 'NEUTRAL';
        if (bullEntry) signal = 'BULLISH';
        else if (bearEntry) signal = 'BEARISH';
        else if (currentTrend === 1) signal = 'BULL_TREND';
        else if (currentTrend === -1) signal = 'BEAR_TREND';

        return {
            trend: currentTrend,
            prevTrend,
            zlema: currZlema,
            upper: currZlema + vol,
            lower: currZlema - vol,
            volatility: vol,
            signal,
            zlemaEntry: bullEntry || bearEntry,
            entryDirection: bullEntry ? 'BULLISH' : bearEntry ? 'BEARISH' : null,
            bullCross,
            bearCross,
        };
    }

    /** Shorthand to get ZLEMA trend from different timeframes */
    _getZLEMAMTF(priceData) {
        return {
            main: this._calculateZLEMATrend(priceData, 70, 1.2),
            fast: priceData.length >= 40 ? this._calculateZLEMATrend(priceData, 30, 1.0) : null,
            slow: priceData.length >= 100 ? this._calculateZLEMATrend(priceData, 100, 1.5) : null,
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 ADX CALCULATION — Average Directional Index
    // ═══════════════════════════════════════════════════════════════════

    calculateADX(priceData, period = 14) {
        if (!priceData || priceData.length < period + 2) return 0;

        const trs = [];
        const plusDMs = [];
        const minusDMs = [];

        for (let i = 1; i < priceData.length; i++) {
            const high = priceData[i].high ?? priceData[i].price;
            const low = priceData[i].low ?? priceData[i].price;
            const prevHigh = priceData[i - 1].high ?? priceData[i - 1].price;
            const prevLow = priceData[i - 1].low ?? priceData[i - 1].price;
            const prevClose = priceData[i - 1].close ?? priceData[i - 1].price;

            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            trs.push(tr);

            const plusDM = high - prevHigh;
            const minusDM = prevLow - low;
            plusDMs.push(plusDM > minusDM && plusDM > 0 ? plusDM : 0);
            minusDMs.push(minusDM > plusDM && minusDM > 0 ? minusDM : 0);
        }

        // Wilder's smoothing
        let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let plusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let minusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;

        const dxValues = [];
        for (let i = period; i < trs.length; i++) {
            atr = (atr * (period - 1) + trs[i]) / period;
            plusDM = (plusDM * (period - 1) + plusDMs[i]) / period;
            minusDM = (minusDM * (period - 1) + minusDMs[i]) / period;

            const plusDI = atr > 0 ? (plusDM / atr) * 100 : 0;
            const minusDI = atr > 0 ? (minusDM / atr) * 100 : 0;
            const dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
            dxValues.push(dx);
        }

        // ADX = smoothed DX
        if (dxValues.length < period) return 0;
        let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < dxValues.length; i++) {
            adx = (adx * (period - 1) + dxValues[i]) / period;
        }
        return adx;
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 REGIME DETECTION
    // ═══════════════════════════════════════════════════════════════════

    detectRegime(priceData) {
        if (!priceData || priceData.length < 30) {
            return { regime: 'ranging', atrPercentile: 50 };
        }

        const closes = priceData.map(p => p.close || p.price);
        const atr = this.calculateAtr(priceData, 14);
        const currentPrice = closes[closes.length - 1];

        // Use real ADX for trend strength measurement
        const adx = this.calculateADX(priceData, 14);

        // ATR as % of price — higher = more volatile
        const atrPct = (atr / currentPrice) * 100;

        // Bollinger bandwidth
        const bb = this.calculateBollingerBands(closes, 20, 2);
        const bbWidth = bb.upper > 0 ? ((bb.upper - bb.lower) / bb.middle) * 100 : 0;

        // Classification using ADX + ATR (calibrated for XAUUSD 6H)
        // Scale thresholds for shorter intervals: ATR scales with sqrt(time)
        // base atrPct threshold = 0.50 (for 6H=360m), base bbWidth threshold = 3.0
        // ADX threshold also scales down for shorter TFs (ADX is naturally lower with noise)
        const timeScale = Math.sqrt(this.interval / 360);
        const atrPctThreshold = 0.50 * timeScale;
        const bbWidthThreshold = 3.0 * timeScale;
        const adxThreshold = Math.max(20, Math.round(25 * Math.min(1, timeScale * 1.5)));

        let regime;
        if (adx > adxThreshold && atrPct > atrPctThreshold) {
            regime = 'volatile';
        } else if (adx > adxThreshold) {
            regime = 'trending';
        } else if (bbWidth > bbWidthThreshold) {
            regime = 'volatile';
        } else {
            regime = 'ranging';
        }

        const result = { regime, atrPct, adx, bbWidth };
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 GOLD MARKET SPECIALIST (shared with V2)
    // ═══════════════════════════════════════════════════════════════════

    analyzeGoldMarketContext(priceData) {
        if (!this.goldSpecialist) return null;
        try {
            const ts = priceData[priceData.length - 1].timestamp;
            const hour = ts ? new Date(ts).getUTCHours() : new Date().getUTCHours();
            const session = this.goldSpecialist.getSession(hour);
            const dailyData = priceData.filter(c => {
                if (!c.timestamp) return false;
                const h = new Date(c.timestamp).getUTCHours();
                return h === 0 || h === 12;
            });
            const structural = dailyData.length >= 4
                ? this.goldSpecialist.calculateStructuralLevels(dailyData, priceData[priceData.length - 1].price)
                : { nearestSupport: null, nearestResistance: null };
            const dailyBias = dailyData.length >= 4
                ? this.goldSpecialist.getDailyBias(dailyData)
                : { bias: 'neutral', ema200: null };
            const volAdj = this.goldSpecialist.calculateVolatilityAdjustment
                ? this.goldSpecialist.calculateVolatilityAdjustment(priceData)
                : null;

            const minScore = (session?.characteristics?.minScore !== undefined && session.characteristics.minScore < 999)
                ? session.characteristics.minScore
                : null;

            return { session, structural, dailyBias, volAdj, minScore };
        } catch { return null; }
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 STRUCTURE BREAK DETECTION (improved)
    // ═══════════════════════════════════════════════════════════════════

    _checkStructureBreak(priceData, direction) {
        if (!priceData || priceData.length < 10) return null;
        const lookback = Math.min(priceData.length - 1, 20);
        const last = priceData[priceData.length - 1];
        const lastHigh = last.high ?? last.price;
        const lastLow = last.low ?? last.price;
        const lastClose = last.close ?? last.price;

        let recentHigh = -Infinity;
        let recentLow = Infinity;
        for (let i = 0; i < lookback; i++) {
            const c = priceData[priceData.length - 2 - i];
            recentHigh = Math.max(recentHigh, c.high ?? c.price);
            recentLow = Math.min(recentLow, c.low ?? c.price);
        }

        // V3 FIX: Require current candle to CLOSE beyond the structural level
        if (direction === 'BULLISH') {
            if (lastClose > recentHigh && (last.close ?? last.price) > (last.open ?? last.price)) {
                return 'BOS_BULLISH';
            }
        } else if (direction === 'BEARISH') {
            if (lastClose < recentLow && (last.close ?? last.price) < (last.open ?? last.price)) {
                return 'BOS_BEARISH';
            }
        }
        return null;
    }

    _findNearestOB(priceData, direction) {
        if (!priceData || priceData.length < 10) return null;
        const { bullOB, bearOB } = this.detectOrderBlock(priceData);
        const last = priceData[priceData.length - 1];
        const price = last.price ?? last.close;
        if (direction === 'BULLISH' && bullOB) {
            if (price >= bullOB.low * 0.998 && price <= bullOB.high * 1.002) {
                return { type: 'bullOB', ...bullOB };
            }
        }
        if (direction === 'BEARISH' && bearOB) {
            if (price >= bearOB.low * 0.998 && price <= bearOB.high * 1.002) {
                return { type: 'bearOB', ...bearOB };
            }
        }
        return null;
    }

    _findNearestFVG(priceData, direction) {
        if (!priceData || priceData.length < 10) return null;
        const fvgs = this.detectFVG(priceData);
        const last = priceData[priceData.length - 1];
        const price = last.price ?? last.close;
        if (direction === 'BULLISH') {
            const fvg = fvgs.find(f => f.type === 'bullFVG' && price >= f.bottom * 0.998 && price <= f.top * 1.002);
            return fvg ? { type: 'bullFVG', ...fvg } : null;
        } else {
            const fvg = fvgs.find(f => f.type === 'bearFVG' && price >= f.bottom * 0.998 && price <= f.top * 1.002);
            return fvg ? { type: 'bearFVG', ...fvg } : null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 RSI DIVERGENCE (fixed: includes current candle)
    // ═══════════════════════════════════════════════════════════════════

    _detectMomentumDivergence(priceData) {
        if (!priceData || priceData.length < 15) return { bullDiv: false, bearDiv: false };
        const closes = priceData.map(p => p.close || p.price);
        const rsiValues = [];
        for (let i = 14; i <= closes.length; i++) {
            rsiValues.push(this.calculateRsi(closes.slice(0, i), 14));
        }
        if (rsiValues.length < 10) return { bullDiv: false, bearDiv: false };

        const lastRsi = rsiValues[rsiValues.length - 1];

        // V3 FIX: Include current candle in lookback (was priceData.length - 2)
        const lookback = Math.min(priceData.length - 1, 20);
        let lowestLow = Infinity;
        let highestHigh = -Infinity;

        for (let i = 0; i < lookback; i++) {
            const idx = priceData.length - 1 - i;
            if (idx < 0) break;
            lowestLow = Math.min(lowestLow, priceData[idx].low ?? priceData[idx].price);
            highestHigh = Math.max(highestHigh, priceData[idx].high ?? priceData[idx].price);
        }

        const lastClose = priceData[priceData.length - 1].close ?? priceData[priceData.length - 1].price;

        // Bullish divergence: price near recent lows, RSI rising
        const bullDiv = lastClose <= lowestLow * 1.005 && lastRsi > rsiValues[rsiValues.length - 2] && lastRsi < 50;

        // Bearish divergence: price near recent highs, RSI falling
        const bearDiv = lastClose >= highestHigh * 0.995 && lastRsi < rsiValues[rsiValues.length - 2] && lastRsi > 50;

        return { bullDiv, bearDiv };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 FIBONACCI PULLBACK ZONE
    // ═══════════════════════════════════════════════════════════════════

    _getPullbackZone(priceData) {
        const fibs = this.calculateFibonacciLevels(priceData);
        if (!fibs) return { inZone: false, zone: 'none', fibLevel: null };
        const last = priceData[priceData.length - 1];
        const price = last.price ?? last.close;
        const { high, low } = fibs;
        const range = high - low;
        if (range <= 0) return { inZone: false, zone: 'none', fibLevel: null };

        const fib382 = high - range * 0.382;
        const fib618 = high - range * 0.618;
        const fib50 = high - range * 0.5;

        // Premium zone (above 0.5) — ideal for bearish entries / sell-side pullback
        if (price > fib50 + range * 0.02) {
            return { inZone: true, zone: 'premium', fibLevel: 0.5 };
        }

        // Discount zone (0.382 - 0.618) — ideal for buys
        if (price >= fib618 * 0.998 && price <= fib382 * 1.002) {
            const closestFib = Math.abs(price - fib382) < Math.abs(price - fib618) ? 0.382 : 0.618;
            return { inZone: true, zone: 'discount', fibLevel: closestFib };
        }

        // Deep discount (below 0.786) — extreme, higher risk
        const fib786 = high - range * 0.786;
        if (price <= fib786) {
            return { inZone: true, zone: 'deep_discount', fibLevel: 0.786 };
        }

        return { inZone: false, zone: 'outside', fibLevel: null };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 DAILY GATE (EMA-200 filter)
    // ═══════════════════════════════════════════════════════════════════

    _getDailyGate(priceData) {
        if (!priceData || priceData.length < 50) return { above: true, ema200: null, ema50: null };
        const closes = priceData.map(p => p.close || p.price);
        const ema50 = this.calculateEma(closes, 50);
        const ema200 = this.calculateEma(closes, Math.min(200, closes.length));
        const lastClose = closes[closes.length - 1];
        const ema50Val = ema50[ema50.length - 1];
        const ema200Val = ema200[ema200.length - 1];
        return {
            above: lastClose > ema200Val,
            ema200: ema200Val,
            ema50: ema50Val,
            close: lastClose,
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V4-PLUS: VOF STRUCTURE — Pivot Break (BOS/CHoCH)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Detect pivot-based structural breaks (BOS / CHoCH).
     *
     * @param {Array} priceData  - candles
     * @returns {{ type: string|null, broken: number, pivot: number }}
     */
    detectPivotBreak(priceData) {
        if (!priceData || priceData.length < 8) return { type: null, broken: 0, pivot: 0 };

        const lb = this.PIVOT_LOOKBACK;
        const highs = priceData.map(c => c.high ?? c.price);
        const lows  = priceData.map(c => c.low  ?? c.price);
        const lastIdx = priceData.length - 1;

        // Find last swing high (pivot high: bar[i] > neighbors on both sides)
        let lastSwingHigh = null, lastSwingHighIdx = null;
        for (let i = lastIdx - lb; i >= 1; i--) {
            let isPivot = true;
            for (let j = 1; j <= lb; j++) {
                if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) { isPivot = false; break; }
            }
            if (isPivot) { lastSwingHigh = highs[i]; lastSwingHighIdx = i; break; }
        }

        // Find last swing low
        let lastSwingLow = null, lastSwingLowIdx = null;
        for (let i = lastIdx - lb; i >= 1; i--) {
            let isPivot = true;
            for (let j = 1; j <= lb; j++) {
                if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) { isPivot = false; break; }
            }
            if (isPivot) { lastSwingLow = lows[i]; lastSwingLowIdx = i; break; }
        }

        const currentClose = priceData[lastIdx].close ?? priceData[lastIdx].price;

        // Detect breaks: price closes beyond a pivot
        if (lastSwingHigh !== null && currentClose > lastSwingHigh) {
            // Prior structure: was there a recent swing low before this swing high?
            const hasHigherLow = lastSwingLow !== null && lastSwingLowIdx < lastSwingHighIdx;
            if (hasHigherLow) {
                return { type: 'BOS', broken: lastSwingHigh, pivot: lastSwingHigh, direction: 'bullish' };
            }
            return { type: 'CHoCH', broken: lastSwingHigh, pivot: lastSwingHigh, direction: 'bullish' };
        }

        if (lastSwingLow !== null && currentClose < lastSwingLow) {
            const hasLowerHigh = lastSwingHigh !== null && lastSwingHighIdx < lastSwingLowIdx;
            if (hasLowerHigh) {
                return { type: 'BOS', broken: lastSwingLow, pivot: lastSwingLow, direction: 'bearish' };
            }
            return { type: 'CHoCH', broken: lastSwingLow, pivot: lastSwingLow, direction: 'bearish' };
        }

        return { type: null, broken: 0, pivot: 0, direction: null };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V4-PLUS: VOF STRUCTURE — Volume Profile (15-row, body-weighted)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Compute a 15-row volume profile for a window of candles.
     * Weights volume by body closeness to the row center.
     *
     * @param {Array} priceData  - candles
     * @param {number} [windowSize=20] - lookback candles
     * @returns {{ poc: number, rows: Array, maxVol: number }}
     */
    _computeVolumeProfile(priceData, windowSize = 20) {
        if (!priceData || priceData.length < 5) return { poc: null, rows: [], maxVol: 0 };

        const window = priceData.slice(-windowSize);
        let globalHigh = -Infinity, globalLow = Infinity;
        for (const c of window) {
            const h = c.high ?? c.price;
            const l = c.low  ?? c.price;
            if (h > globalHigh) globalHigh = h;
            if (l < globalLow) globalLow = l;
        }

        const range = globalHigh - globalLow;
        if (range <= 0) return { poc: null, rows: [], maxVol: 0 };

        const rowSize = range / this.VP_ROWS;
        const rows = [];

        for (let r = 0; r < this.VP_ROWS; r++) {
            const rowLow  = globalLow + r * rowSize;
            const rowHigh = rowLow + rowSize;
            const rowCenter = (rowLow + rowHigh) / 2;
            let vol = 0;

            for (const c of window) {
                const open  = c.open  ?? c.price;
                const close = c.close ?? c.price;
                const high  = c.high  ?? c.price;
                const low   = c.low   ?? c.price;

                // Volume allocation: how much of this candle's range falls in this row
                const overlapLow  = Math.max(low, rowLow);
                const overlapHigh = Math.min(high, rowHigh);
                if (overlapHigh <= overlapLow) continue;

                const fraction = (overlapHigh - overlapLow) / (high - low || 1);
                const candleVol = (c.volume ?? 1) * fraction;

                // Weight by body closeness (close within 50% of row center = 1.5x)
                const bodyMid = (open + close) / 2;
                const dist = Math.abs(bodyMid - rowCenter) / (rowSize / 2);
                const weight = dist < 0.5 ? this.VP_WEIGHT_BODY : 1.0;

                vol += candleVol * weight;
            }

            rows.push({ low: rowLow, high: rowHigh, center: rowCenter, vol });
        }

        // Find POC (highest volume row)
        let pocRow = rows[0], maxVol = 0;
        for (const row of rows) {
            if (row.vol > maxVol) { maxVol = row.vol; pocRow = row; }
        }

        return { poc: pocRow.center, rows, maxVol };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V4-PLUS: VOF STRUCTURE — Manipulation Sweep Detection
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Detect manipulation: a sweep of order block liquidity that fails
     * and reverses back through the OB zone.
     *
     * @param {Array} priceData  - candles
     * @returns {{ detected: boolean, direction: string|null, obLevel: number }}
     */
    _detectManipulation(priceData) {
        if (!priceData || priceData.length < 5) return { detected: false, direction: null, obLevel: null };

        const atr = this.calculateAtr(priceData, 14);
        const obResult = this.detectOrderBlock(priceData);
        if (!obResult) return { detected: false, direction: null, obLevel: null };

        const { bullOB, bearOB } = obResult;
        const last = priceData[priceData.length - 1];
        const prev = priceData[priceData.length - 2];

        const sweepBuffer = atr * this.MANIP_SWEEP_THRESHOLD;

        // Bearish manipulation: sweep above bearOB high then close back below
        if (bearOB) {
            const obHigh = bearOB.high;
            if (obHigh != null) {
                const sweptAbove = (prev.high ?? prev.price) > obHigh + sweepBuffer;
                const closedBelow = (last.close ?? last.price) < obHigh;
                if (sweptAbove && closedBelow) {
                    return { detected: true, direction: 'bearish', obLevel: obHigh };
                }
            }
        }

        // Bullish manipulation: sweep below bullOB low then close back above
        if (bullOB) {
            const obLow = bullOB.low;
            if (obLow != null) {
                const sweptBelow = (prev.low ?? prev.price) < obLow - sweepBuffer;
                const closedAbove = (last.close ?? last.price) > obLow;
                if (sweptBelow && closedAbove) {
                    return { detected: true, direction: 'bullish', obLevel: obLow };
                }
            }
        }

        return { detected: false, direction: null, obLevel: null };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 CONFLUENCE SCORER — weighted core + secondary
    // ═══════════════════════════════════════════════════════════════════

    calculateConfluenceScore(priceData) {
        if (!priceData || priceData.length < 50) {
            return { score: 0, threshold: this.CONFLUENCE_THRESHOLD, details: 'Insufficient data', direction: 'NEUTRAL', scoreMargin: 0, bullScore: 0, bearScore: 0 };
        }

        const prices = priceData.map(p => p.price);
        const closes = priceData.map(p => p.close || p.price);
        const last = priceData[priceData.length - 1];
        const currentPrice = last.price ?? last.close;

        // ── Compute all indicators ──────────────────────────────────
        const ema20 = this.calculateEma(closes, 20);
        const ema50 = this.calculateEma(closes, 50);
        const ema200 = this.calculateEma(closes, Math.min(200, closes.length));
        const ema9Val = this.calculateEma(closes, 9).slice(-1)[0];
        const ema21Val = this.calculateEma(closes, 21).slice(-1)[0];
        const ema50Val = ema50[ema50.length - 1];
        const ema200Val = ema200[ema200.length - 1];
        const rsi = this.calculateRsi(closes, 14);
        const macd = this.calculateMacd(closes);
        const cpr = this.calculateCPR(priceData);
        const liquidity = this.detectLiquiditySweep(priceData);
        const ote = this.calculateFibonacciLevels(priceData);
        const obfvg = { ob: this.detectOrderBlock(priceData), fvg: this.detectFVG(priceData) };
        const structure = this._checkStructureBreak(priceData, 'BULLISH') || this._checkStructureBreak(priceData, 'BEARISH') || 'NEUTRAL';
        const supertrend = this.calculateSupertrend(priceData);
        const stochastic = this.calculateStochastic(priceData);
        const rsiDivergence = this._detectMomentumDivergence(priceData);
        const dailyGate = this._getDailyGate(priceData);
        const goldMeta = this.analyzeGoldMarketContext(priceData);

        // ── V4-PLUS: VOF Structure indicators ──────────────────────
        const pivotBreak = this.detectPivotBreak(priceData);
        const manipulation = this._detectManipulation(priceData);
        let volumeProfile = null;
        if (pivotBreak.type) {
            volumeProfile = this._computeVolumeProfile(priceData, 20);
        }

        // ── V5: Zero-Lag Trend Signals (ZLEMA) ──────────────────────
        const zlemaTrend = this._getZLEMAMTF(priceData);

        // ── V3: Pullback zone ──────────────────────────────────────
        const pullback = this._getPullbackZone(priceData);

        // ── V3: Regime ─────────────────────────────────────────────
        const regime = this.detectRegime(priceData);

        // ═══════════════════════════════════════════════════════════
        // V3 CORE SCORING — weighted by factor importance
        // ═══════════════════════════════════════════════════════════

        let bullScore = 0;
        let bearScore = 0;
        const details = [];

        // ── Factor 1: TREND (weight 0.35) ─────────────────────────
        // EMA stack: 9 > 21 > 50 = strong bull; 9 < 21 < 50 = strong bear
        const ema921bull = ema9Val > ema21Val;
        const ema2150bull = ema21Val > ema50Val;
        const ema921bear = ema9Val < ema21Val;
        const ema2150bear = ema21Val < ema50Val;
        const priceAbove50 = currentPrice > ema50Val;
        const priceBelow50 = currentPrice < ema50Val;
        const priceAbove200 = currentPrice > ema200Val;
        const priceBelow200 = currentPrice < ema200Val;

        if (ema921bull && ema2150bull && priceAbove50) {
            bullScore += 3;
            details.push('EMA bullish stack (9>21>50, price>50)');
        } else if (ema921bull && priceAbove50) {
            bullScore += 2;
            details.push('Partial EMA bull (9>21, price>50)');
        } else if (ema921bull || priceAbove50) {
            bullScore += 1;
            details.push('Weak EMA bull');
        }

        if (ema921bear && ema2150bear && priceBelow50) {
            bearScore += 3;
            details.push('EMA bearish stack (9<21<50, price<50)');
        } else if (ema921bear && priceBelow50) {
            bearScore += 2;
            details.push('Partial EMA bear (9<21, price<50)');
        } else if (ema921bear || priceBelow50) {
            bearScore += 1;
            details.push('Weak EMA bear');
        }

        // Supertrend confirmation
        if (supertrend.direction === 'BULLISH') { bullScore += 1; details.push('Supertrend bull'); }
        if (supertrend.direction === 'BEARISH') { bearScore += 1; details.push('Supertrend bear'); }

        // ── Factor 1b: ZLEMA TREND (weight 0.15 of trend factor) ──
        const zlemaMain = zlemaTrend.main;
        const zlemaFast = zlemaTrend.fast;

        if (zlemaMain.trend === 1) {
            bullScore += 2;
            details.push('ZLEMA trend bull');
            if (zlemaMain.zlemaEntry && zlemaMain.entryDirection === 'BULLISH') {
                bullScore += 2;
                details.push('ZLEMA bull entry signal');
            }
            if (zlemaFast && zlemaFast.trend === 1) {
                bullScore += 1;
                details.push('ZLEMA fast trend bull (MTF confirm)');
            }
        }
        if (zlemaMain.trend === -1) {
            bearScore += 2;
            details.push('ZLEMA trend bear');
            if (zlemaMain.zlemaEntry && zlemaMain.entryDirection === 'BEARISH') {
                bearScore += 2;
                details.push('ZLEMA bear entry signal');
            }
            if (zlemaFast && zlemaFast.trend === -1) {
                bearScore += 1;
                details.push('ZLEMA fast trend bear (MTF confirm)');
            }
        }

        // ZLEMA vs Supertrend alignment bonus
        if (zlemaMain.trend === 1 && supertrend.direction === 'BULLISH') {
            bullScore += 1;
            details.push('ZLEMA+Supertrend bull alignment');
        }
        if (zlemaMain.trend === -1 && supertrend.direction === 'BEARISH') {
            bearScore += 1;
            details.push('ZLEMA+Supertrend bear alignment');
        }

        // ── Factor 2: PULLBACK QUALITY (weight 0.30) ──────────────
        // V3: Prefer entries at Fib levels aligned with trend
        if (pullback.inZone && pullback.zone === 'discount') {
            // Bull pullback: price in discount zone + bullish trend context
            if (ema921bull || priceAbove50) {
                bullScore += 3;
                details.push(`Fib pullback in discount zone (${pullback.fibLevel})`);
            }
        } else if (pullback.inZone && pullback.zone === 'premium') {
            // Bear pullback: price in premium zone + bearish trend context
            if (ema921bear || priceBelow50) {
                bearScore += 3;
                details.push(`Fib pullback in premium zone (${pullback.fibLevel})`);
            }
        } else if (pullback.inZone && pullback.zone === 'deep_discount') {
            if (ema921bull || priceAbove50) {
                bullScore += 2;
                details.push('Deep discount Fib (0.786)');
            }
        }

        // CPR proximity
        if (cpr.pivot !== null) {
            const distToPivot = Math.abs(currentPrice - cpr.pivot);
            const atr = this.calculateAtr(priceData, 14);
            if (distToPivot < atr * 0.5) {
                bullScore += 1;
                bearScore += 1;
                details.push('At CPR pivot');
            }
        }

        // ── Factor 3: MOMENTUM (weight 0.25) ──────────────────────
        // RSI
        if (rsi > 55 && rsi < 75) { bullScore += 2; details.push(`RSI bull ${rsi.toFixed(1)}`); }
        else if (rsi > 50) { bullScore += 1; details.push(`RSI weak bull ${rsi.toFixed(1)}`); }
        if (rsi < 45 && rsi > 25) { bearScore += 2; details.push(`RSI bear ${rsi.toFixed(1)}`); }
        else if (rsi < 50) { bearScore += 1; details.push(`RSI weak bear ${rsi.toFixed(1)}`); }

        // MACD
        if (macd.histogram > 0 && macd.macd > macd.signal) { bullScore += 2; details.push('MACD bull cross'); }
        else if (macd.histogram > 0) { bullScore += 1; details.push('MACD histogram +'); }
        if (macd.histogram < 0 && macd.macd < macd.signal) { bearScore += 2; details.push('MACD bear cross'); }
        else if (macd.histogram < 0) { bearScore += 1; details.push('MACD histogram -'); }

        // RSI divergence (secondary confirmation)
        if (rsiDivergence.bullDiv) { bullScore += 1; details.push('RSI bull divergence'); }
        if (rsiDivergence.bearDiv) { bearScore += 1; details.push('RSI bear divergence'); }

        // Stochastic
        if (stochastic.k > 50 && stochastic.k < 80) { bullScore += 1; details.push('Stoch bull'); }
        if (stochastic.k < 50 && stochastic.k > 20) { bearScore += 1; details.push('Stoch bear'); }

        // ── Factor 4: STRUCTURE (weight 0.10) — tie-breaker ───────
        // Old V4: BOS/OB/FVG scoring
        if (structure === 'BOS_BULLISH') { bullScore += 2; details.push('BOS bullish'); }
        if (structure === 'BOS_BEARISH') { bearScore += 2; details.push('BOS bearish'); }

        const ob = this._findNearestOB(priceData, 'BULLISH');
        if (ob) { bullScore += 1; details.push('Bull OB nearby'); }
        const obBear = this._findNearestOB(priceData, 'BEARISH');
        if (obBear) { bearScore += 1; details.push('Bear OB nearby'); }

        const fvgBull = this._findNearestFVG(priceData, 'BULLISH');
        if (fvgBull) { bullScore += 1; details.push('Bull FVG nearby'); }
        const fvgBear = this._findNearestFVG(priceData, 'BEARISH');
        if (fvgBear) { bearScore += 1; details.push('Bear FVG nearby'); }

        // ── V4-PLUS: VOF Structure scoring ────────────────────────
        // Pivot BOS: +1 same direction
        if (pivotBreak.type === 'BOS' && pivotBreak.direction === 'bullish') { bullScore += 1; details.push('Pivot BOS bull'); }
        if (pivotBreak.type === 'BOS' && pivotBreak.direction === 'bearish') { bearScore += 1; details.push('Pivot BOS bear'); }

        // CHoCH: +2 (stronger signal — trend change)
        if (pivotBreak.type === 'CHoCH' && pivotBreak.direction === 'bullish') { bullScore += 2; details.push('CHoCH bull (trend change)'); }
        if (pivotBreak.type === 'CHoCH' && pivotBreak.direction === 'bearish') { bearScore += 2; details.push('CHoCH bear (trend change)'); }

        // Volume profile POC proximity
        if (volumeProfile && volumeProfile.poc) {
            const distToPOC = Math.abs(currentPrice - volumeProfile.poc);
            const atr = this.calculateAtr(priceData, 14);
            if (distToPOC < atr * 0.3) {
                bullScore += 1;
                bearScore += 1;
                details.push(`At VP POC ${volumeProfile.poc.toFixed(1)}`);
            }
        }

        // Manipulation scoring: +1 when sweep confirms trade direction
        if (manipulation.detected) {
            if (manipulation.direction === 'bullish') { bullScore += 1; details.push('Manipulation sweep → bull'); }
            if (manipulation.direction === 'bearish') { bearScore += 1; details.push('Manipulation sweep → bear'); }
        }

        // ── Session / liquidity adjustments (secondary) ────────────
        if (goldMeta && goldMeta.session && goldMeta.session.name === 'asian') {
            details.push('Asian session — low conviction');
        }
        if (liquidity.sweepLevel) {
            if (liquidity.sweepType === 'BUY_STOP_HUNT') { bullScore += 1; details.push('Liq sweep buy stops'); }
            if (liquidity.sweepType === 'SELL_STOP_HUNT') { bearScore += 1; details.push('Liq sweep sell stops'); }
        }

        // ═══════════════════════════════════════════════════════════
        // V3 FINAL SCORE — weighted sum (0-10 scale)
        // ═══════════════════════════════════════════════════════════
        // V4 max raw: trend=4, pullback=3, momentum=5, structure=4 = 16
        // V5 adds ZLEMA trend (up to 5 bonus: 2 trend, 2 entry, 1 MTF) = 21
        const MAX_RAW = 20;
        const normalizedBull = (bullScore / MAX_RAW) * 10;
        const normalizedBear = (bearScore / MAX_RAW) * 10;
        const score = Math.max(normalizedBull, normalizedBear);
        const direction = normalizedBull > normalizedBear ? 'BULLISH' : normalizedBear > normalizedBull ? 'BEARISH' : 'NEUTRAL';
        const scoreMargin = Math.abs(normalizedBull - normalizedBear);

        return {
            score: Math.round(score * 10) / 10,
            threshold: this.CONFLUENCE_THRESHOLD,
            details: details.join(' | '),
            direction,
            scoreMargin: Math.round(scoreMargin * 10) / 10,
            bullScore: Math.round(normalizedBull * 10) / 10,
            bearScore: Math.round(normalizedBear * 10) / 10,
            goldMeta,
            regime,
            pullback,
            // V4-Plus: VOF structure indicators
            pivotBreak,
            manipulation,
            volumeProfile,
            // V5: ZLEMA trend signals
            zlemaTrend,
            indicators: {
                rsi, macd, cpr, liquidity, ote, obfvg, structure,
                ema50Val, ema200Val, supertrend, stochastic, rsiDivergence, dailyGate,
                ema9Val, ema21Val, ema921bull, ema2150bull, ema921bear, ema2150bear,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 SIGNAL GENERATION — strict confluence only
    // ═══════════════════════════════════════════════════════════════════

    analyze(priceData) {
        if (!priceData || priceData.length < 50) {
            return { signal: 'NEUTRAL', score: 0, details: 'Insufficient data' };
        }

        const confluence = this.calculateConfluenceScore(priceData);
        const { score, indicators, direction, regime, pullback } = confluence;

        let signal = 'NEUTRAL';
        const currentPrice = priceData[priceData.length - 1].price ?? priceData[priceData.length - 1].close;
        const ema9Val = indicators.ema9Val;
        const ema21Val = indicators.ema21Val;
        const ema50Val = indicators.ema50Val;
        const ema200Val = indicators.ema200Val;

        const bullishEma = ema9Val > ema21Val;
        const bearishEma = ema9Val < ema21Val;
        const bullishPrice = currentPrice > ema50Val;
        const bearishPrice = currentPrice < ema50Val;
        const bullish = bullishEma && bullishPrice;
        const bearish = bearishEma && bearishPrice;

        const dailyGate = indicators.dailyGate;
        const aboveEMA200 = dailyGate.above;

        const trendBullish = ema50Val > ema200Val; // EMA50 > EMA200 = bullish trend
        const trendBearish = ema50Val < ema200Val; // EMA50 < EMA200 = bearish trend

        let filterBreakdown = {
            scoreMet: score >= this.CONFLUENCE_THRESHOLD,
            threshold: this.CONFLUENCE_THRESHOLD,
            score,
            confluenceDirection: direction,
            ema9Val, ema21Val, ema50Val,
            ema200: dailyGate.ema200,
            currentPrice,
            bullishEma, bearishEma,
            bullishPrice, bearishPrice,
            emaBullish: bullish,
            emaBearish: bearish,
            trendBullish, trendBearish,
            directionAgrees: null,
            rejectedReason: null,
            dailyGatePass: true,
            regime: regime?.regime || 'unknown',
            pullbackZone: pullback?.zone || 'unknown',
        };

        // ═══════════════════════════════════════════════════════════
        // V4-PLUS PROFITABLE SIGNAL PATH:
        //   1. Score >= regime-adjusted threshold
        //   2. EMA alignment is a preference, not a gate —
        //      if score margin is strong (>2.0), counter-trend fires anyway
        //   3. Trend direction gate: block counter-trend trades
        //   4. Score margin quality gate: require directional confidence
        //   5. Session is not blocked
        // ═══════════════════════════════════════════════════════════

        // Change 5: Adaptive regime-adjusted threshold
        // Volatile regime: adaptive buffer (min 0.5, max 1.0)
        // Trending/ranging: base threshold (no change from V4-Plus baseline)
        const adxVal = confluence.indicators?.adx || 20;
        const atrRatio = confluence.indicators?.atrRatio || 1.0;
        let regimeBuffer = 0;
        if (regime?.regime === 'volatile') {
            regimeBuffer = Math.max(0.5, 0.5 + (adxVal > 35 ? 0.2 : 0) + (atrRatio > 1.5 ? 0.3 : 0));
        }
        const effectiveThreshold = this.CONFLUENCE_THRESHOLD + regimeBuffer;

        if (score >= effectiveThreshold) {
            const scoreMargin = confluence.scoreMargin;
            // Counter-trend override: strong confluence margin overrides EMA alignment
            if (scoreMargin > 2.0) {
                signal = direction === 'BULLISH' ? 'BUY' : 'SELL';
                filterBreakdown.rejectedReason = null;
            }
            // EMA alignment check (preferred but not mandatory)
            else if (bullish && direction === 'BULLISH') {
                signal = 'BUY';
            } else if (bearish && direction === 'BEARISH') {
                signal = 'SELL';
            } else {
                // Confluence says direction but EMA doesn't align directly —
                // still fire if score is sufficiently high (>= threshold + 0.5 buffer)
                if (score >= effectiveThreshold + 0.5) {
                    signal = direction === 'BULLISH' ? 'BUY' : 'SELL';
                    filterBreakdown.rejectedReason = null;
                } else {
                    if (direction === 'BULLISH') {
                        filterBreakdown.rejectedReason = `Bull direction but EMA not aligned (EMA9 ${bullishEma ? '>' : '<'} EMA21, price ${bullishPrice ? '>' : '<'} EMA50)`;
                    } else {
                        filterBreakdown.rejectedReason = `Bear direction but EMA not aligned (EMA9 ${bullishEma ? '>' : '<'} EMA21, price ${bullishPrice ? '>' : '<'} EMA50)`;
                    }
                }
            }

            // Change 1: Trend direction gate — require higher confidence for counter-trend trades
            // Counter-trend trades need stronger confluence to pass
            if (signal !== 'NEUTRAL') {
                if (trendBearish && signal === 'BUY') {
                    if (confluence.scoreMargin < 2.0) {
                        signal = 'NEUTRAL';
                        filterBreakdown.rejectedReason = `Counter-trend BUY blocked (margin: ${confluence.scoreMargin.toFixed(1)}, need >= 2.0)`;
                    } else {
                        filterBreakdown.rejectedReason = 'Counter-trend BUY passed (strong confluence)';
                    }
                }
                if (trendBullish && signal === 'SELL') {
                    if (confluence.scoreMargin < 2.0) {
                        signal = 'NEUTRAL';
                        filterBreakdown.rejectedReason = `Counter-trend SELL blocked (margin: ${confluence.scoreMargin.toFixed(1)}, need >= 2.0)`;
                    } else {
                        filterBreakdown.rejectedReason = 'Counter-trend SELL passed (strong confluence)';
                    }
                }
            }

            // Change 7: Volatile regime filter — intentionally DISABLED.
            // The original code blocked BUY in volatile markets (33% WR), but this
            // creates a structural bearish bias. Both directions are now allowed.

            // Change 8: RSI quality filter — relaxed for better BUY signal generation
            // Original: blocked if RSI <= 55. Now: only block if RSI < 40 (oversold).
            // Weak RSI buys in bearish market have 22% WR (vs 50% for RSI > 55)
            if (signal === 'BUY' && confluence.indicators && confluence.indicators.rsi < 40) {
                signal = 'NEUTRAL';
                filterBreakdown.rejectedReason = `BUY blocked — RSI too low for entry (${confluence.indicators.rsi.toFixed(1)}, need >= 40)`;
            }

            // Change 9: BUY EMA crossover — configurable: optional score penalty or hard block
            // If EMA 9/21 is not bullish, BUY trades need higher score to compensate
            if (signal === 'BUY' && !bullishEma) {
                if (this.EMA_ALIGNMENT_REQUIRED) {
                    // Hard block: BUY requires EMA alignment
                    signal = 'NEUTRAL';
                    filterBreakdown.rejectedReason = `BUY blocked — EMA 9/21 alignment required (EMA9 ${ema9Val > ema21Val ? '>' : '<'} EMA21)`;
                } else {
                    // Penalize: require score >= threshold + 0.5 extra if EMA not aligned (relaxed from +1.0)
                    if (score < effectiveThreshold + 0.5) {
                        signal = 'NEUTRAL';
                        filterBreakdown.rejectedReason = `BUY blocked — EMA 9/21 weak (EMA9 ${ema9Val > ema21Val ? '>' : '<'} EMA21, score ${score.toFixed(1)} < ${(effectiveThreshold + 0.5).toFixed(1)})`;
                    }
                }
            }

            // Change 4: Score margin quality gate — require directional confidence (tunable)
            // Relaxed: both directions use same margin threshold
            let minMargin = this.SCORE_MARGIN_MIN;
            // Relaxed: both directions use same margin (was 2.0 for BUY, 1.0 for SELL)
            if (signal !== 'NEUTRAL' && confluence.scoreMargin < minMargin) {
                signal = 'NEUTRAL';
                filterBreakdown.rejectedReason = `Insufficient directional confidence (margin: ${confluence.scoreMargin.toFixed(1)}, need >= ${minMargin.toFixed(1)})`;
            }
        }

        // ── Session block (binary gate — proven effective) ──────────────────
        const goldMeta = confluence.goldMeta;
        if (signal !== 'NEUTRAL' && goldMeta && goldMeta.session) {
            const sessionMin = goldMeta.session.characteristics?.minScore;
            if (sessionMin === 999) {
                filterBreakdown.rejectedReason = 'Session blocked (low-probability window)';
                signal = 'NEUTRAL';
            }
        }

        // ── V4-PLUS: Manipulation filter ──────────────────────────
        // Block trade if manipulation sweep opposes trade direction
        if (signal !== 'NEUTRAL' && confluence.manipulation) {
            const manip = confluence.manipulation;
            if (manip.detected) {
                if (signal === 'BUY' && manip.direction === 'bearish') {
                    filterBreakdown.rejectedReason = 'Manipulation sweep opposes BUY (bearish sweep detected)';
                    signal = 'NEUTRAL';
                } else if (signal === 'SELL' && manip.direction === 'bullish') {
                    filterBreakdown.rejectedReason = 'Manipulation sweep opposes SELL (bullish sweep detected)';
                    signal = 'NEUTRAL';
                }
            }
        }

        // ── V5: ZLEMA Trend Filter (configurable gate) ────────────
        // ZLEMA_REQUIRED: hard block — trade must align with ZLEMA trend
        // ZLEMA_ENTRY_REQUIRED: hard block — must have ZLEMA entry signal
        if (signal !== 'NEUTRAL' && confluence.zlemaTrend) {
            const zlemaMain = confluence.zlemaTrend.main;
            if (this.ZLEMA_REQUIRED) {
                if (signal === 'BUY' && zlemaMain.trend !== 1) {
                    signal = 'NEUTRAL';
                    filterBreakdown.rejectedReason = `ZLEMA trend required for BUY (trend: ${zlemaMain.trend})`;
                } else if (signal === 'SELL' && zlemaMain.trend !== -1) {
                    signal = 'NEUTRAL';
                    filterBreakdown.rejectedReason = `ZLEMA trend required for SELL (trend: ${zlemaMain.trend})`;
                }
            }
            if (signal !== 'NEUTRAL' && this.ZLEMA_ENTRY_REQUIRED) {
                if (!zlemaMain.zlemaEntry) {
                    signal = 'NEUTRAL';
                    filterBreakdown.rejectedReason = `ZLEMA entry signal required (signal: ${zlemaMain.signal})`;
                } else if (signal === 'BUY' && zlemaMain.entryDirection !== 'BULLISH') {
                    signal = 'NEUTRAL';
                    filterBreakdown.rejectedReason = `ZLEMA entry direction mismatch (need BULLISH, got ${zlemaMain.entryDirection})`;
                } else if (signal === 'SELL' && zlemaMain.entryDirection !== 'BEARISH') {
                    signal = 'NEUTRAL';
                    filterBreakdown.rejectedReason = `ZLEMA entry direction mismatch (need BEARISH, got ${zlemaMain.entryDirection})`;
                }
            }
        }

        // ═══════════════════════════════════════════════════════════
        // V3 RISK PARAMETERS — regime-adaptive
        // ═══════════════════════════════════════════════════════════
        const riskParams = this.calculateRiskParameters(priceData, indicators, regime, confluence.goldMeta);

        return {
            signal,
            score: confluence.score,
            details: {
                confluenceScorer: confluence,
                filterBreakdown,
                riskCalculator: riskParams,
                goldMeta: confluence.goldMeta || null,
                regime: regime || null,
                pullback: pullback || null,
                timestamp: new Date().toISOString(),
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 RISK PARAMETERS — regime-adaptive TP/SL
    // ═══════════════════════════════════════════════════════════════════

    calculateRiskParameters(priceData, indicators, regime, goldMeta = null) {
        const currentPrice = priceData[priceData.length - 1].price ?? priceData[priceData.length - 1].close;
        const atr = this.calculateAtr(priceData, 14);
        const liquidity = indicators?.liquidity || this.detectLiquiditySweep(priceData);
        const cpr = indicators?.cpr || this.calculateCPR(priceData);

        // V4-Plus: OB level as SL candidate (between liquidity sweep and CPR)
        const obResult = this.detectOrderBlock(priceData);
        let obLevel = null;
        if (obResult) {
            const { bullOB, bearOB } = obResult;
            const ob = bearOB ?? bullOB;
            if (ob) obLevel = ob.low ?? ob.high ?? null;
        }

        let slDistance;
        const atrFallback = atr * 1.0;
        if (liquidity.sweepLevel) {
            const buffer = atr * 0.2;
            slDistance = Math.abs(currentPrice - liquidity.sweepLevel) + buffer;
        } else if (obLevel != null) {
            // V4-Plus: Use OB level for tighter SL, but never wider than ATR baseline
            const buffer = atr * 0.2;
            const obSL = Math.abs(currentPrice - obLevel) + buffer;
            slDistance = Math.min(obSL, atrFallback);
        } else if (cpr.bc && cpr.tc) {
            slDistance = Math.max(Math.abs(currentPrice - cpr.bc), Math.abs(cpr.tc - currentPrice), atrFallback);
        } else {
            slDistance = atrFallback;
        }
        const regimeName = regime?.regime || 'ranging';
        const regimeSLCap = regimeName === 'ranging' ? atr * 0.8
                         : regimeName === 'volatile' ? atr * 1.5
                         : atr * 1.2;
        slDistance = Math.max(Math.min(slDistance, regimeSLCap, this.MAX_SL_DISTANCE), Math.min(atr * 0.5, this.MAX_SL_DISTANCE * 0.6));

        // ═══════════════════════════════════════════════════════════
        // V3: REGIME-ADAPTIVE TP
        // ═══════════════════════════════════════════════════════════
        const regimeTP1 = regimeName === 'ranging' ? 2.0 : this.REGIME_TP1_RR[regimeName] ?? 3.0;
        const tp1RR = this.TP1_RR ?? regimeTP1;
        const tp2RR = this.TP2_RR ?? this.REGIME_TP2_RR[regimeName] ?? 5.0;

        // Volatility adjustment (if available) — clamp back to MAX_SL_DISTANCE after adjustment
        if (goldMeta?.volAdj) {
            const origSl = slDistance;
            const adj = goldMeta.volAdj.slAdjustment ?? 1;
            slDistance *= adj;
            slDistance = Math.min(slDistance, this.MAX_SL_DISTANCE);
            // volAdj applied (suppressed for performance)
        }

        const tp1Distance = slDistance * tp1RR;
        const tp2Distance = slDistance * tp2RR;

        // Risk params computed (suppressed for performance)

        return {
            atr,
            slDistance,
            tp1RR,
            tp2RR,
            regime: regimeName,
            stopLoss: {
                long: currentPrice - slDistance,
                short: currentPrice + slDistance,
            },
            takeProfit: {
                tp1Long: currentPrice + tp1Distance,
                tp1Short: currentPrice - tp1Distance,
                tp2Long: currentPrice + tp2Distance,
                tp2Short: currentPrice - tp2Distance,
            },
            riskReward: { tp1: tp1RR, tp2: tp2RR },
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // V4 TRAILING STOP — BE lock at 1.5R (was 3.5R)
    // ═══════════════════════════════════════════════════════════════════
    // Zones:
    //   0.5-1.5R  → trail 30%  (gentle protection)
    //   1.5R      → BE lock    (no loss possible)
    //   2.0-3.0R  → trail 50%  (tighter)
    //   > 3.0R    → trail 70%  (tight trailing for max profit)
    // ═══════════════════════════════════════════════════════════════════

    applyTrailingStop(activeTrade, currentCandle) {
        const initialStop = activeTrade.originalSl ?? activeTrade.original_sl ?? activeTrade.sl;
        const riskDistance = Math.abs(activeTrade.entryPrice - initialStop);
        const fallbackRiskDistance = activeTrade.atr || 15;
        const riskUnit = riskDistance > 0 ? riskDistance : fallbackRiskDistance;

        if (activeTrade.action === 'BUY') {
            const favorableMove = currentCandle.close - activeTrade.entryPrice;
            if (favorableMove > riskUnit * 3) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.7;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 1.5) {
                activeTrade.sl = Math.max(activeTrade.sl, activeTrade.entryPrice);
            } else if (favorableMove > riskUnit * 0.5) {
                const trailed = activeTrade.entryPrice + (currentCandle.high - activeTrade.entryPrice) * 0.3;
                activeTrade.sl = Math.max(activeTrade.sl, trailed);
            }
        } else if (activeTrade.action === 'SELL') {
            const favorableMove = activeTrade.entryPrice - currentCandle.close;
            if (favorableMove > riskUnit * 3) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.7;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            } else if (favorableMove > riskUnit * 1.5) {
                activeTrade.sl = Math.min(activeTrade.sl, activeTrade.entryPrice);
            } else if (favorableMove > riskUnit * 0.5) {
                const trailed = activeTrade.entryPrice - (activeTrade.entryPrice - currentCandle.low) * 0.3;
                activeTrade.sl = Math.min(activeTrade.sl, trailed);
            }
        }
        return activeTrade;
    }

    // ═══════════════════════════════════════════════════════════════════
    // V3 TRADE EXIT — TP-before-SL (liberal fill assumption)
    // ═══════════════════════════════════════════════════════════════════

    checkTradeExit(activeTrade, currentCandle) {
        this.applyTrailingStop(activeTrade, currentCandle);

        // Same-candle prevention
        const entryTs = activeTrade.timestamp ? new Date(activeTrade.timestamp).getTime() : 0;
        const candleTs = currentCandle.timestamp ? new Date(currentCandle.timestamp).getTime() : 0;
        if (entryTs === candleTs) return { closed: false };

        let exitPrice = null;
        let exitReason = '';
        const CONTRACT_SIZE = 100;
        const initialQuantity = activeTrade.initialQuantity || activeTrade.quantity;
        const remainingQuantity = activeTrade.remainingQuantity ?? activeTrade.remaining_quantity ?? activeTrade.quantity;
        const realizedPnl = activeTrade.realizedPnl ?? activeTrade.realized_pnl ?? 0;
        const tp1Hit = activeTrade.tp1Hit || Boolean(activeTrade.tp1_hit);

        const broker = this.broker;
        const brokerSlippage = (side) => {
            if (!broker) return 0;
            return broker.calculateSlippage({ side, candle: currentCandle, atr: activeTrade.atr, quantity: remainingQuantity }) * 0.01;
        };

        const calculatePnl = (price, quantity) => {
            const positionSize = quantity * CONTRACT_SIZE;
            return activeTrade.action === 'BUY'
                ? (price - activeTrade.entryPrice) * positionSize
                : (activeTrade.entryPrice - price) * positionSize;
        };

        const closeRemaining = (fillPrice, reason) => ({
            closed: true,
            exitPrice: fillPrice,
            exitReason: reason,
            pnl: (activeTrade.realizedPnl ?? activeTrade.realized_pnl ?? 0)
                + calculatePnl(fillPrice, activeTrade.remainingQuantity ?? activeTrade.remaining_quantity ?? remainingQuantity),
        });

        const takePartial = (fillPrice) => {
            const closePercent = Math.min(Math.max(this.TP1_CLOSE_PERCENT, 0), 100) / 100;
            const closeQuantity = Math.min(remainingQuantity, initialQuantity * closePercent);
            const nextRemaining = Math.max(remainingQuantity - closeQuantity, 0);
            const partialPnl = calculatePnl(fillPrice, closeQuantity);
            activeTrade.remainingQuantity = nextRemaining;
            activeTrade.realizedPnl = realizedPnl + partialPnl;
            activeTrade.tp1Hit = true;
            if (nextRemaining <= 0) {
                return { closed: true, exitPrice: fillPrice, exitReason: 'Take Profit 1', pnl: realizedPnl + partialPnl };
            }
            activeTrade.sl = activeTrade.action === 'BUY'
                ? Math.max(activeTrade.sl, activeTrade.entryPrice)
                : Math.min(activeTrade.sl, activeTrade.entryPrice);
            return { closed: false, partial: true, exitPrice: fillPrice, exitReason: 'TP1 Partial', partialPnl, remainingQuantity: nextRemaining };
        };

        if (activeTrade.action === 'BUY') {
            // ═══ V3: TP BEFORE SL (liberal — captures more wins) ═══
            // Check TP1 first
            if (!tp1Hit && currentCandle.high >= activeTrade.tp1) {
                const fillPrice = activeTrade.tp1 - brokerSlippage('SELL');
                const partialResult = takePartial(fillPrice);
                // Check if TP2 also hit in same candle
                if (activeTrade.tp2 && currentCandle.high >= activeTrade.tp2) {
                    const tp2Fill = activeTrade.tp2 - brokerSlippage('SELL');
                    return closeRemaining(tp2Fill, 'Take Profit 2');
                }
                return partialResult;
            }
            // Check TP2 after TP1 hit
            if ((tp1Hit || activeTrade.tp1Hit) && activeTrade.tp2 && currentCandle.high >= activeTrade.tp2) {
                const fillPrice = activeTrade.tp2 - brokerSlippage('SELL');
                return closeRemaining(fillPrice, 'Take Profit 2');
            }
            // Then check SL
            if (currentCandle.low <= activeTrade.sl) {
                const fillPrice = activeTrade.sl - brokerSlippage('SELL');
                return closeRemaining(fillPrice, activeTrade.sl >= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss');
            }
        } else {
            // SELL trade
            // ═══ V3: TP BEFORE SL (liberal — captures more wins) ═══
            if (!tp1Hit && currentCandle.low <= activeTrade.tp1) {
                const fillPrice = activeTrade.tp1 + brokerSlippage('BUY');
                const partialResult = takePartial(fillPrice);
                if (activeTrade.tp2 && currentCandle.low <= activeTrade.tp2) {
                    const tp2Fill = activeTrade.tp2 + brokerSlippage('BUY');
                    return closeRemaining(tp2Fill, 'Take Profit 2');
                }
                return partialResult;
            }
            if ((tp1Hit || activeTrade.tp1Hit) && activeTrade.tp2 && currentCandle.low <= activeTrade.tp2) {
                const fillPrice = activeTrade.tp2 + brokerSlippage('BUY');
                return closeRemaining(fillPrice, 'Take Profit 2');
            }
            if (currentCandle.high >= activeTrade.sl) {
                const fillPrice = activeTrade.sl + brokerSlippage('BUY');
                return closeRemaining(fillPrice, activeTrade.sl <= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss');
            }
        }

        return { closed: false };
    }

    // ═══════════════════════════════════════════════════════════════════
    // MULTI-TIMEFRAME (MTF) ANALYSIS — 6H confluence × 15m ORB retest
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Initialize or reset pending entries map.
     */
    _initPendingEntries() {
        if (!this._pendingEntries) this._pendingEntries = new Map();
    }

    /**
     * Multi-timeframe analysis: 6H confluence gating × 15m ORB retest entry.
     *
     * Flow:
     *   1. Run standard V4 analyze() on 6H candles.
     *   2. If score >= threshold & signal is BUY/SELL → create a pending entry.
     *   3. Check 15m sub-candles for opening range breakout + retest.
     *   4. If retest confirmed → return EXECUTE_BUY / EXECUTE_SELL.
     *   5. If pending expired (no confirmation within window) → return NEUTRAL.
     *
     * @param {Array} priceData6h     - 6H candles
     * @param {Array} priceData15m    - 15m candles (used for ORB retest check)
     * @param {object} [options={}]   - { sessionStart, pendingExpiryHrs, orbCandles }
     * @returns {{ signal: string, score: number, details: object }}
     */
    analyzeMTF(priceData6h, priceData15m, options = {}) {
        this._initPendingEntries();

        const {
            sessionStart = null,
            pendingExpiryHrs = 6,
            orbCandles = 2,
        } = options;

        // Step 1: Run V4 on 6H
        const baseResult = this.analyze(priceData6h);
        const { signal, score, details: baseDetails } = baseResult;

        if (!priceData15m || priceData15m.length < orbCandles + 1 || !this.goldSpecialist) {
            // No 15m data available → fall back to pure V4
            return {
                signal: signal === 'BUY' ? 'EXECUTE_BUY'
                      : signal === 'SELL' ? 'EXECUTE_SELL'
                      : 'NEUTRAL',
                score,
                details: {
                    ...baseDetails,
                    mtf: { mode: 'fallback', reason: 'No 15m data or goldSpecialist' },
                },
            };
        }

        const last15mCandle = priceData15m[priceData15m.length - 1];
        const currentTime = new Date(last15mCandle.time || last15mCandle.timestamp);

        // Use explicit sessionStart for session detection (backtest passes 6H candle time)
        // This prevents the last 15m candle's hour (e.g. 17) from masking the actual session (e.g. 12)
        const sessionTime = sessionStart ? new Date(sessionStart) : currentTime;
        const utcHour = sessionTime.getUTCHours();
        const sessionDateStr = currentTime.toISOString().slice(0, 10);

        // London session: ORB from 07:00–07:30 UTC
        // NY session: ORB from 12:00–12:30 UTC
        let orbSessionStartHour = null;
        if (utcHour >= 7 && utcHour < 12) {
            orbSessionStartHour = 7; // London
        } else if (utcHour >= 12 && utcHour < 17) {
            orbSessionStartHour = 12; // NY
        }

        // ── Handle V4 signal → create/manage pending entry ──────────
        if (signal === 'BUY' || signal === 'SELL') {
            const entryKey = `${signal}_${sessionDateStr}`;

            // Create or update pending entry if not already confirmed
            if (!this._pendingEntries.has(entryKey) ||
                this._pendingEntries.get(entryKey).status === 'EXPIRED') {

                if (orbSessionStartHour !== null) {
                    const candleTimeMs = currentTime.getTime();
                    const sessionStartTime = new Date(currentTime);
                    sessionStartTime.setUTCHours(orbSessionStartHour, 0, 0, 0);

                    this._pendingEntries.set(entryKey, {
                        signal,
                        score,
                        sessionDate: sessionDateStr,
                        sessionStartHour: orbSessionStartHour,
                        sessionStartTime: sessionStartTime.getTime(),
                        created: candleTimeMs,
                        expiresAt: candleTimeMs + pendingExpiryHrs * 3600000,
                        status: 'PENDING',
                        orbConfirmed: false,
                        baseDetails,
                    });
                }
            }
        }

        // ── Check existing pending entries against 15m data ────────
        for (const [key, entry] of this._pendingEntries.entries()) {
            if (entry.status !== 'PENDING') continue;
            if (currentTime.getTime() > entry.expiresAt) {
                entry.status = 'EXPIRED';
                continue;
            }

            if (!orbSessionStartHour || entry.sessionStartHour !== orbSessionStartHour) {
                continue;
            }

            // Find index of session start in 15m data
            const sessionStartMs = entry.sessionStartTime;
            let sessionStartIdx = -1;
            for (let i = 0; i < priceData15m.length; i++) {
                const c = priceData15m[i];
                const cTime = new Date(c.time || c.timestamp).getTime();
                if (cTime >= sessionStartMs) {
                    sessionStartIdx = i;
                    break;
                }
            }
            if (sessionStartIdx < 0) continue;

            // Calculate opening range
            const openingRange = this.goldSpecialist.calculateOpeningRange(
                priceData15m, sessionStartIdx, orbCandles
            );
            if (!openingRange) continue;

            // Candles after opening range for retest check
            const candlesAfterRange = priceData15m.slice(sessionStartIdx + orbCandles);

            // Check breakout + retest
            const retestResult = this.goldSpecialist.detectBreakoutRetest(
                candlesAfterRange, openingRange, entry.signal === 'BUY' ? 'BUY' : 'SELL'
            );

            if (retestResult.confirmed) {
                entry.status = 'CONFIRMED';
                entry.orbConfirmed = true;
                entry.entryPrice = retestResult.entryPrice;
                entry.retestCandle = retestResult.retestCandle;
                entry.breakCandle = retestResult.breakCandle;
                entry.openingRange = openingRange;
            }
        }

        // ── Determine final signal ──────────────────────────────────
        const pendingEntry = this._pendingEntries.get(`BUY_${sessionDateStr}`)
                         || this._pendingEntries.get(`SELL_${sessionDateStr}`);

        if (pendingEntry && pendingEntry.status === 'CONFIRMED') {
            const executeSignal = pendingEntry.signal === 'BUY' ? 'EXECUTE_BUY' : 'EXECUTE_SELL';
            return {
                signal: executeSignal,
                score,
                details: {
                    ...baseDetails,
                    mtf: {
                        mode: 'confirmed',
                        pendingEntry: {
                            ...pendingEntry,
                            retestCandle: undefined,
                            breakCandle: undefined,
                        },
                        retestCandle: pendingEntry.retestCandle,
                        openingRange: pendingEntry.openingRange,
                        entryPrice: pendingEntry.entryPrice,
                    },
                },
            };
        }

        if (pendingEntry && pendingEntry.status === 'PENDING') {
            return {
                signal: `PENDING_${pendingEntry.signal}`,
                score,
                details: {
                    ...baseDetails,
                    mtf: {
                        mode: 'pending',
                        sessionStartHour: pendingEntry.sessionStartHour,
                        expiresAt: pendingEntry.expiresAt,
                        expiresIn: Math.round((pendingEntry.expiresAt - currentTime.getTime()) / 60000),
                    },
                },
            };
        }

        // No active pending entry → return V4 signal or NEUTRAL
        return {
            signal: signal === 'BUY' ? 'EXECUTE_BUY'
                  : signal === 'SELL' ? 'EXECUTE_SELL'
                  : 'NEUTRAL',
            score,
            details: {
                ...baseDetails,
                mtf: { mode: 'direct', reason: 'No pending entry needed' },
            },
        };
    }

    /**
     * Reset pending entries (e.g. on new day / session).
     */
    resetPendingEntries() {
        this._pendingEntries = new Map();
    }
}

module.exports = UnifiedStrategy;
