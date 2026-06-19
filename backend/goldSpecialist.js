/**
 * GoldSpecialist — XAU/USD-specific trading intelligence
 *
 * Encodes 15+ years of gold market behavior:
 *  - Session-aware (London open, NY overlap, Asian range)
 *  - Structural levels (PDH/PDL, round numbers, weekly pivots)
 *  - Volatility regime detection (high/low ATR adaptation)
 *  - Liquidity sweep / stop-hunt detection
 *  - Momentum exhaustion at session extremes
 */

const HALF_SPREAD = parseFloat(process.env.HALF_SPREAD || '2.05');

class GoldSpecialist {
  constructor() {
    // Session windows (UTC hours)
    this.sessions = {
      asian:   { start: 23, end: 7,  label: 'Asian' },
      london:  { start: 7,  end: 12, label: 'London' },
      nyOverlap: { start: 12, end: 16, label: 'London-NY Overlap' },
      ny:      { start: 16, end: 21, label: 'New York' },
    };

    // ATR lookback for regime detection
    this.ATR_LOOKBACK = 14;
    this.VOL_HIGH_MULT = 1.5;   // >1.5x avg ATR = high vol
    this.VOL_LOW_MULT  = 0.6;   // <0.6x avg ATR = low vol

    // Round-number proximity (gold moves in $50 increments)
    this.ROUND_NUMBER_STEP = 50;
  }

  // ── SESSION INTELLIGENCE ──────────────────────────────────────────────

  /**
   * Get current session name and characteristics
   * @param {number} hour - UTC hour (0-23)
   * @returns {{ name: string, phase: string, characteristics: object }}
   */
  getSession(hour) {
    if (hour >= 7 && hour < 12) {
      return {
        name: 'london',
        phase: hour < 9 ? 'open' : 'mid',
        // London open: high volatility, trend-setting
        // London mid: continuation or reversal
        characteristics: {
          volatility: 'high',
          tendency: hour < 9 ? 'trend-setting' : 'continuation',
          minScore: 5.0,       // normal threshold
          slMultiplier: 1.0,   // normal SL
          preferMomentum: true,
          avoidReversion: true,
        },
      };
    }
    if (hour >= 12 && hour < 16) {
      return {
        name: 'nyOverlap',
        phase: 'peak',
        // Highest liquidity window — best moves happen here
        characteristics: {
          volatility: 'very-high',
          tendency: 'breakout',
          minScore: 4.5,       // slightly lower — best window
          slMultiplier: 1.2,   // wider SL for bigger moves
          preferMomentum: true,
          avoidReversion: false,
        },
      };
    }
    if (hour >= 16 && hour < 21) {
      return {
        name: 'ny',
        phase: hour < 18 ? 'mid' : 'late',
        // NY afternoon: lower vol, mean reversion dominant
        characteristics: {
          volatility: hour < 18 ? 'medium' : 'low',
          tendency: hour < 18 ? 'continuation' : 'mean-reversion',
          minScore: 5.5,       // higher bar in low-vol session
          slMultiplier: 0.8,   // tighter SL
          preferMomentum: false,
          avoidReversion: hour < 18, // only late NY reversion
        },
      };
    }
    // Asian / off-hours
    return {
      name: 'asian',
      phase: 'range',
      characteristics: {
        volatility: 'low',
        tendency: 'range-bound',
        minScore: 999,         // effectively block Asian trades
        slMultiplier: 0.5,     // tiny SL if somehow taken
        preferMomentum: false,
        avoidReversion: false,
      },
    };
  }

  // ── STRUCTURAL LEVELS ─────────────────────────────────────────────────

  /**
   * Calculate structural support/resistance levels from daily data
   * @param {Array} dailyData - array of { open, high, low, close }
   * @param {number} currentPrice
   * @returns {{ levels: Array, nearestSupport: number, nearestResistance: number }}
   */
  calculateStructuralLevels(dailyData, currentPrice) {
    if (!dailyData || dailyData.length < 2) {
      return { levels: [], nearestSupport: null, nearestResistance: null };
    }

    const levels = [];
    const prev = dailyData[dailyData.length - 2];

    // Previous Day High / Low (strongest gold levels)
    levels.push({ price: prev.high, type: 'resistance', strength: 3, name: 'PDH' });
    levels.push({ price: prev.low,  type: 'support',    strength: 3, name: 'PDL' });

    // Previous Day Open/Close
    levels.push({ price: prev.open,  type: 'pivot', strength: 1, name: 'PDO' });
    levels.push({ price: prev.close, type: 'pivot', strength: 1, name: 'PDC' });

    // Round numbers (gold respects $50 increments)
    const roundBase = Math.floor(currentPrice / this.ROUND_NUMBER_STEP) * this.ROUND_NUMBER_STEP;
    for (let i = -2; i <= 2; i++) {
      const rn = roundBase + (i * this.ROUND_NUMBER_STEP);
      levels.push({
        price: rn,
        type: rn > currentPrice ? 'resistance' : 'support',
        strength: 2,
        name: `$${rn}`,
      });
    }

    // Weekly pivot (if we have enough data)
    if (dailyData.length >= 5) {
      const week = dailyData.slice(-6, -1); // last 5 completed days
      const pivot = (week.reduce((s, d) => s + d.high + d.low + d.close, 0)) / (5 * 3);
      levels.push({ price: pivot, type: 'pivot', strength: 2, name: 'WeeklyPivot' });
    }

    // Sort by price
    levels.sort((a, b) => a.price - b.price);

    // Find nearest support and resistance
    let nearestSupport = null, nearestResistance = null;
    for (const lv of levels) {
      if (lv.price < currentPrice && (nearestSupport === null || lv.price > nearestSupport)) {
        nearestSupport = lv.price;
      }
      if (lv.price > currentPrice && (nearestResistance === null || lv.price < nearestResistance)) {
        nearestResistance = lv.price;
      }
    }

    return { levels, nearestSupport, nearestResistance };
  }

  /**
   * Score proximity to structural levels
   * Being near support = bullish bonus, near resistance = bearish bonus
   * @param {object} structuralLevels - from calculateStructuralLevels
   * @param {number} price - current price
   * @param {string} side - 'BUY' or 'SELL'
   * @returns {{ score: number, details: string }}
   */
  scoreStructuralProximity(structuralLevels, price, side) {
    if (!structuralLevels || !structuralLevels.nearestSupport) {
      return { score: 0, details: 'No structural levels' };
    }

    const { nearestSupport, nearestResistance } = structuralLevels;

    // Distance to nearest level as % of price
    const distSupport    = nearestSupport ? Math.abs(price - nearestSupport) / price * 100 : 999;
    const distResistance = nearestResistance ? Math.abs(price - nearestResistance) / price * 100 : 999;

    let score = 0;
    let details = '';

    // Within 0.15% of a level = very strong
    // Within 0.3% of a level = strong
    // Within 0.5% of a level = moderate
    const PROXIMITY_VERY_STRONG = 0.15;
    const PROXIMITY_STRONG      = 0.30;
    const PROXIMITY_MODERATE    = 0.50;

    if (side === 'BUY') {
      // Near support = bullish (price bouncing off support)
      if (distSupport < PROXIMITY_VERY_STRONG) {
        score = 1.5;
        details = `Very near support $${nearestSupport.toFixed(0)} (${(distSupport * 100).toFixed(1)}%)`;
      } else if (distSupport < PROXIMITY_STRONG) {
        score = 1.0;
        details = `Near support $${nearestSupport.toFixed(0)} (${(distSupport * 100).toFixed(1)}%)`;
      } else if (distSupport < PROXIMITY_MODERATE) {
        score = 0.5;
        details = `Approaching support $${nearestSupport.toFixed(0)}`;
      }
      // Near resistance = bearish penalty
      if (distResistance < PROXIMITY_STRONG) {
        score -= 0.5;
        details += ` | Near resistance $${nearestResistance.toFixed(0)} (penalty)`;
      }
    } else {
      // Near resistance = bearish (price rejecting resistance)
      if (distResistance < PROXIMITY_VERY_STRONG) {
        score = 1.5;
        details = `Very near resistance $${nearestResistance.toFixed(0)} (${(distResistance * 100).toFixed(1)}%)`;
      } else if (distResistance < PROXIMITY_STRONG) {
        score = 1.0;
        details = `Near resistance $${nearestResistance.toFixed(0)} (${(distResistance * 100).toFixed(1)}%)`;
      } else if (distResistance < PROXIMITY_MODERATE) {
        score = 0.5;
        details = `Approaching resistance $${nearestResistance.toFixed(0)}`;
      }
      // Near support = bullish penalty
      if (distSupport < PROXIMITY_STRONG) {
        score -= 0.5;
        details += ` | Near support $${nearestSupport.toFixed(0)} (penalty)`;
      }
    }

    return { score: Math.max(score, -1), details };
  }

  // ── VOLATILITY REGIME ─────────────────────────────────────────────────

  /**
   * Detect current volatility regime using ATR
   * @param {Array} candles - OHLCV candles (most recent first)
   * @returns {{ regime: string, atr: number, avgAtr: number, ratio: number }}
   */
  detectVolatilityRegime(candles) {
    if (!candles || candles.length < this.ATR_LOOKBACK + 1) {
      return { regime: 'unknown', atr: 0, avgAtr: 0, ratio: 1 };
    }

    // Calculate ATR
    const trValues = [];
    for (let i = 0; i < candles.length - 1; i++) {
      const high = candles[i].high;
      const low  = candles[i].low;
      const prevClose = candles[i + 1].close;
      trValues.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    // Current ATR (last 14 periods)
    const atr = trValues.slice(0, this.ATR_LOOKBACK).reduce((s, v) => s + v, 0) / this.ATR_LOOKBACK;

    // Average ATR (longer window for comparison)
    const avgWindow = Math.min(trValues.length, 50);
    const avgAtr = trValues.slice(0, avgWindow).reduce((s, v) => s + v, 0) / avgWindow;

    const ratio = avgAtr > 0 ? atr / avgAtr : 1;

    let regime;
    if (ratio > this.VOL_HIGH_MULT)      regime = 'high';
    else if (ratio < this.VOL_LOW_MULT)   regime = 'low';
    else                                   regime = 'normal';

    return { regime, atr, avgAtr, ratio };
  }

  /**
   * Get volatility-based adjustments for strategy parameters
   * @param {string} regime - 'high', 'low', 'normal'
   * @returns {{ slAdjustment: number, tpAdjustment: number, minScoreAdj: number, label: string }}
   */
  getVolAdjustments(regime) {
    switch (regime) {
      case 'high':
        return {
          slAdjustment: 1.5,   // wider SL
          tpAdjustment: 1.3,   // bigger TP targets
          minScoreAdj: -0.5,   // lower bar (more opportunity)
          label: 'High Vol',
        };
      case 'low':
        return {
          slAdjustment: 0.7,   // tighter SL
          tpAdjustment: 0.8,   // smaller TP targets
          minScoreAdj: 1.0,    // higher bar (less opportunity)
          label: 'Low Vol',
        };
      default:
        return {
          slAdjustment: 1.0,
          tpAdjustment: 1.0,
          minScoreAdj: 0,
          label: 'Normal Vol',
        };
    }
  }

  // ── LIQUIDITY SWEEP / STOP-HUNT DETECTION ─────────────────────────────

  /**
   * Detect if a candle swept liquidity (wick below support or above resistance)
   * @param {object} candle - current candle { high, low, open, close }
   * @param {Array} recentCandles - last 10 candles
   * @param {object} structuralLevels - from calculateStructuralLevels
   * @returns {{ swept: boolean, side: string, level: number, strength: string }}
   */
  detectLiquiditySweep(candle, recentCandles, structuralLevels) {
    if (!candle || !structuralLevels || !structuralLevels.levels) {
      return { swept: false };
    }

    const bodyTop    = Math.max(candle.open, candle.close);
    const bodyBottom = Math.min(candle.open, candle.close);
    const wickTop    = candle.high - bodyTop;
    const wickBottom = bodyBottom - candle.low;

    // Find recent highs/lows (last 10 candles)
    const recentHigh = Math.max(...recentCandles.slice(0, 10).map(c => c.high));
    const recentLow  = Math.min(...recentCandles.slice(0, 10).map(c => c.low));

    // Check if wick swept below recent low (bullish sweep = stop hunt)
    if (wickBottom > 0 && candle.low < recentLow) {
      // Did price close back above the swept level? (strong confirmation)
      if (candle.close > recentLow) {
        return {
          swept: true,
          side: 'BUY',     // bullish sweep (stops taken, reversal likely)
          level: recentLow,
          strength: 'strong', // close back above = strong
        };
      }
    }

    // Check if wick swept above recent high (bearish sweep = stop hunt)
    if (wickTop > 0 && candle.high > recentHigh) {
      if (candle.close < recentHigh) {
        return {
          swept: true,
          side: 'SELL',     // bearish sweep (stops taken, reversal likely)
          level: recentHigh,
          strength: 'strong',
        };
      }
    }

    // Check structural level sweeps
    for (const lv of structuralLevels.levels) {
      if (lv.strength < 2) continue; // only check meaningful levels

      // Wick below support and close above = bullish sweep
      if (candle.low < lv.price && candle.close > lv.price && candle.close > bodyBottom) {
        return {
          swept: true,
          side: 'BUY',
          level: lv.price,
          strength: 'moderate',
        };
      }

      // Wick above resistance and close below = bearish sweep
      if (candle.high > lv.price && candle.close < lv.price && candle.close < bodyTop) {
        return {
          swept: true,
          side: 'SELL',
          level: lv.price,
          strength: 'moderate',
        };
      }
    }

    return { swept: false };
  }

  // ── MOMENTUM EXHAUSTION ───────────────────────────────────────────────

  /**
   * Detect momentum exhaustion (overbought/oversold with divergence)
   * @param {object} stochData - { k, d }
   * @param {number} rsi - RSI value
   * @param {Array} candles - recent candles for divergence check
   * @returns {{ exhausted: boolean, side: string, type: string }}
   */
  detectMomentumExhaustion(stochData, rsi, candles) {
    if (!stochData || !candles || candles.length < 5) {
      return { exhausted: false };
    }

    const { k, d } = stochData;

    // Stochastic overbought with bearish divergence (lower highs in price, higher highs in stoch)
    if (k > 80 && d > 75) {
      if (candles.length >= 5) {
        const priceHigh1 = candles[0].high;
        const priceHigh2 = candles[2].high;
        if (priceHigh1 < priceHigh2 && k > 80) {
          return {
            exhausted: true,
            side: 'SELL',
            type: 'Stoch overbought + bearish divergence',
          };
        }
      }
    }

    // Stochastic oversold with bullish divergence
    if (k < 20 && d < 25) {
      if (candles.length >= 5) {
        const priceLow1 = candles[0].low;
        const priceLow2 = candles[2].low;
        if (priceLow1 > priceLow2 && k < 20) {
          return {
            exhausted: true,
            side: 'BUY',
            type: 'Stoch oversold + bullish divergence',
          };
        }
      }
    }

    // RSI extreme levels
    if (rsi > 75) {
      return {
        exhausted: true,
        side: 'SELL',
        type: `RSI overbought (${rsi.toFixed(1)})`,
      };
    }
    if (rsi < 25) {
      return {
        exhausted: true,
        side: 'BUY',
        type: `RSI oversold (${rsi.toFixed(1)})`,
      };
    }

    return { exhausted: false };
  }

  // ── GOLD-SPECIFIC CONFLICT DETECTION ──────────────────────────────────

  /**
   * Detect when indicators conflict (main source of losses)
   * @param {object} indicators - { supertrend, stochK, stochD, rsi, macdHist, obfvgScore }
   * @returns {{ hasConflict: boolean, conflicts: Array, severity: string }}
   */
  detectIndicatorConflicts(indicators) {
    const conflicts = [];
    const { supertrend, stochK, stochD, rsi, macdHist, obfvgScore } = indicators;

    // Supertrend direction
    const stDir = supertrend?.direction || 'neutral';

    // Stochastic direction
    const stochDir = stochK > stochD ? 'bullish' : 'bearish';

    // MACD direction
    const macdDir = macdHist > 0 ? 'bullish' : 'bearish';

    // Conflict 1: Supertrend vs Stochastic
    if (stDir === 'up' && stochDir === 'bearish' && stochK > 70) {
      conflicts.push({
        type: 'Supertrend↑ vs Stoch overbought',
        severity: 'high',
        note: 'Uptrend but momentum exhausted — likely pullback',
      });
    }
    if (stDir === 'down' && stochDir === 'bullish' && stochK < 30) {
      conflicts.push({
        type: 'Supertrend↓ vs Stoch oversold',
        severity: 'high',
        note: 'Downtrend but momentum exhausted — likely bounce',
      });
    }

    // Conflict 2: MACD vs Supertrend
    if (stDir === 'up' && macdDir === 'bearish') {
      conflicts.push({
        type: 'Supertrend↑ vs MACD↓',
        severity: 'medium',
        note: 'Trend up but MACD fading — momentum weakening',
      });
    }
    if (stDir === 'down' && macdDir === 'bullish') {
      conflicts.push({
        type: 'Supertrend↓ vs MACD↑',
        severity: 'medium',
        note: 'Trend down but MACD rising — momentum building',
      });
    }

    // Conflict 3: RSI vs Stochastic
    if (rsi > 65 && stochK > 80) {
      conflicts.push({
        type: 'RSI high + Stoch overbought',
        severity: 'high',
        note: 'Both oscillators overbought — reversal risk',
      });
    }
    if (rsi < 35 && stochK < 20) {
      conflicts.push({
        type: 'RSI low + Stoch oversold',
        severity: 'high',
        note: 'Both oscillators oversold — bounce risk',
      });
    }

    const severity = conflicts.some(c => c.severity === 'high') ? 'high'
                   : conflicts.some(c => c.severity === 'medium') ? 'medium'
                   : 'none';

    return {
      hasConflict: conflicts.length > 0,
      conflicts,
      severity,
    };
  }

  // ── COMPREHENSIVE GOLD ANALYSIS ───────────────────────────────────────

  /**
   * Run full gold-specific analysis
   * @param {object} data - { candles, currentPrice, hour, indicators, dailyData }
   * @returns {object} comprehensive gold analysis
   */
  analyze(data) {
    const { candles, currentPrice, hour, indicators, dailyData } = data;

    // 1. Session
    const session = this.getSession(hour);

    // 2. Structural levels
    const structural = this.calculateStructuralLevels(dailyData, currentPrice);

    // 3. Volatility regime
    const volatility = this.detectVolatilityRegime(candles);
    const volAdj = this.getVolAdjustments(volatility.regime);

    // 4. Structural proximity scoring
    const structScore = this.scoreStructuralProximity(structural, currentPrice, indicators?.side || 'BUY');

    // 5. Liquidity sweep detection
    const sweep = this.detectLiquiditySweep(
      candles?.[0],
      candles,
      structural
    );

    // 6. Momentum exhaustion
    const exhaustion = this.detectMomentumExhaustion(
      indicators?.stochData,
      indicators?.rsi,
      candles
    );

    // 7. Conflict detection
    const conflicts = this.detectIndicatorConflicts(indicators || {});

    // 8. Total gold-specific score
    let goldScore = 0;
    goldScore += structScore.score;
    goldScore += sweep.swept ? (sweep.side === indicators?.side ? 1.0 : -1.0) : 0;
    goldScore += exhaustion.exhausted ? (exhaustion.side === indicators?.side ? 0.5 : -1.5) : 0;
    goldScore += conflicts.hasConflict ? (conflicts.severity === 'high' ? -1.5 : -0.5) : 0.3;

    return {
      session,
      structural,
      volatility,
      volAdj,
      structScore,
      sweep,
      exhaustion,
      conflicts,
      goldScore,
      summary: this._buildSummary(session, volatility, structural, sweep, exhaustion, conflicts),
    };
  }

  _buildSummary(session, volatility, structural, sweep, exhaustion, conflicts) {
    const parts = [];
    parts.push(`Session: ${session.name} (${session.characteristics.tendency})`);
    parts.push(`Vol: ${volatility.regime} (${volatility.ratio.toFixed(1)}x)`);
    if (structural.nearestSupport) parts.push(`Support: $${structural.nearestSupport.toFixed(0)}`);
    if (structural.nearestResistance) parts.push(`Resist: $${structural.nearestResistance.toFixed(0)}`);
    if (sweep.swept) parts.push(`SWEEP ${sweep.side} @ $${sweep.level.toFixed(0)}`);
    if (exhaustion.exhausted) parts.push(`EXHAUSTION: ${exhaustion.type}`);
    if (conflicts.hasConflict) parts.push(`CONFLICT: ${conflicts.conflicts[0].type}`);
    return parts.join(' | ');
  }

  // ── OPENING RANGE (ORB) ────────────────────────────────────────────────

  calculateOpeningRange(subCandles, sessionStartIndex = 0, numCandles = 2) {
    if (!subCandles || subCandles.length < sessionStartIndex + numCandles) {
      return null;
    }

    const rangeCandles = subCandles.slice(sessionStartIndex, sessionStartIndex + numCandles);
    const high = Math.max(...rangeCandles.map(c => c.high));
    const low  = Math.min(...rangeCandles.map(c => c.low));
    const lastClose = rangeCandles[rangeCandles.length - 1].close;

    return {
      high,
      low,
      mid: (high + low) / 2,
      range: high - low,
      breakoutDir: lastClose > high - (high - low) * 0.3 ? 'BUY'
                 : lastClose < low + (high - low) * 0.3 ? 'SELL'
                 : null,
    };
  }

  detectBreakoutRetest(candlesAfterRange, openingRange, side, proximityPct = 0.15) {
    if (!candlesAfterRange || candlesAfterRange.length < 1 || !openingRange) {
      return { confirmed: false };
    }

    const { high, low } = openingRange;
    const breakLevel = side === 'BUY' ? high : low;
    let breakCandle = null;
    let retestCandle = null;
    let brokeOut = false;

    for (let i = 0; i < candlesAfterRange.length; i++) {
      const c = candlesAfterRange[i];

      if (!brokeOut) {
        if (side === 'BUY' && c.high > breakLevel) {
          brokeOut = true;
          breakCandle = c;
        } else if (side === 'SELL' && c.low < breakLevel) {
          brokeOut = true;
          breakCandle = c;
        }
      } else {
        const retestDist = Math.abs(breakLevel - (side === 'BUY' ? c.low : c.high));
        const retestThreshold = breakLevel * (proximityPct / 100);

        if (retestDist <= retestThreshold) {
          if (side === 'BUY' && c.close > c.open) {
            retestCandle = c;
            break;
          }
          if (side === 'SELL' && c.close < c.open) {
            retestCandle = c;
            break;
          }
        }

        if (i > candlesAfterRange.length - 1 || i - candlesAfterRange.indexOf(breakCandle) > 12) {
          break;
        }
      }
    }

    if (brokeOut && retestCandle) {
      return {
        confirmed: true,
        breakCandle,
        retestCandle,
        entryPrice: side === 'BUY'
          ? Math.min(retestCandle.close, breakLevel + breakLevel * 0.001)
          : Math.max(retestCandle.close, breakLevel - breakLevel * 0.001),
      };
    }

    return { confirmed: false };
  }

  getEntryZones(openingRange, session) {
    if (!openingRange) {
      return {
        buyZone: { high: 0, low: 0 },
        sellZone: { high: 0, low: 0 },
      };
    }

    const spread = HALF_SPREAD * 2;
    const buffer = openingRange.range * 0.05;

    return {
      buyZone: {
        high: openingRange.high + spread + buffer,
        low: openingRange.high - spread,
      },
      sellZone: {
        high: openingRange.low + spread,
        low: openingRange.low - spread - buffer,
      },
    };
  }
}

module.exports = GoldSpecialist;
