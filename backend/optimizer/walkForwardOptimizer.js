/**
 * Walk-Forward Optimizer — Out-of-Sample Testing for Strategy Robustness
 * 
 * Splits data into training windows (in-sample) and validation windows (out-of-sample).
 * Tests if optimized parameters work on unseen data.
 * 
 * Usage: node walkForwardOptimizer.js [days] [trainDays] [valDays]
 */

const fs = require('fs');
const path = require('path');

class WalkForwardOptimizer {
    constructor(db, config = {}) {
        this.db = db;
        this.trainWindowDays = config.trainWindowDays || 30;   // In-sample training period
        this.valWindowDays = config.valWindowDays || 10;        // Out-of-sample validation period
        this.stepDays = config.stepDays || 5;                   // Rolling window step
        this.minTrainTrades = config.minTrainTrades || 5;       // Minimum trades in training
        this.minValTrades = config.minValTrades || 3;           // Minimum trades in validation
        
        // Parameter grid (same as daily optimizer)
        this.paramGrid = this._buildParamGrid();
    }

    _buildParamGrid() {
        const confluence = [5.5, 6.0, 6.5, 7.0];
        const tp1Close = [40, 50, 60, 70];
        const maxSl = [8, 10, 12, 15];
        
        const grid = [];
        for (const cf of confluence) {
            for (const tp1 of tp1Close) {
                for (const sl of maxSl) {
                    grid.push({
                        confluenceThreshold: cf,
                        tp1ClosePercent: tp1,
                        maxSlDistance: sl,
                        scoreMarginMin: 1.0,
                        buyScoreMargin: 2.0,
                        emaAlignmentRequired: false,
                    });
                }
            }
        }
        return grid;
    }

    /**
     * Run walk-forward optimization
     * @param {Array} historicalData - Full historical candle data
     * @param {Function} backtestFn - Function to run backtest with given params
     * @returns {Object} Walk-forward results
     */
    async runWalkForward(historicalData, backtestFn) {
        console.log(`[WFO] Starting walk-forward optimization...`);
        console.log(`[WFO] Train window: ${this.trainWindowDays}d, Val window: ${this.valWindowDays}d, Step: ${this.stepDays}d`);

        const totalDays = this._getDaysFromData(historicalData);
        const windows = this._generateWindows(totalDays);
        
        console.log(`[WFO] Total data: ${totalDays} days, Windows: ${windows.length}`);

        const results = {
            windows: [],
            summary: {
                totalWindows: windows.length,
                trainWins: 0,
                valWins: 0,
                avgTrainPF: 0,
                avgValPF: 0,
                robustnessScore: 0,
            }
        };

        for (let i = 0; i < windows.length; i++) {
            const window = windows[i];
            console.log(`\n[WFO] Window ${i + 1}/${windows.length}: Train ${window.trainStart}-${window.trainEnd}d, Val ${window.valStart}-${window.valEnd}d`);

            // Extract train/val data
            const trainData = this._extractWindow(historicalData, window.trainStart, window.trainEnd);
            const valData = this._extractWindow(historicalData, window.valStart, window.valEnd);

            if (trainData.length < 50 || valData.length < 20) {
                console.log(`[WFO] ⚠️ Skipping window ${i + 1} — insufficient data`);
                continue;
            }

            // Find best params on train (in-sample)
            const bestTrainResult = await this._findBestParams(trainData, backtestFn);
            
            if (!bestTrainResult || bestTrainResult.trades < this.minTrainTrades) {
                console.log(`[WFO] ⚠️ Skipping window ${i + 1} — not enough training trades`);
                continue;
            }

            // Test best params on val (out-of-sample)
            const valResult = await this._testParams(valData, backtestFn, bestTrainResult.params);

            const windowResult = {
                windowNum: i + 1,
                trainPeriod: `${window.trainStart}-${window.trainEnd}`,
                valPeriod: `${window.valStart}-${window.valEnd}`,
                train: {
                    params: bestTrainResult.params,
                    pf: bestTrainResult.pf,
                    wr: bestTrainResult.wr,
                    trades: bestTrainResult.trades,
                    maxDD: bestTrainResult.maxDD,
                },
                val: valResult ? {
                    params: bestTrainResult.params,
                    pf: valResult.pf,
                    wr: valResult.wr,
                    trades: valResult.trades,
                    maxDD: valResult.maxDD,
                    equity: valResult.equity,
                } : null,
                robustness: valResult && valResult.trades >= this.minValTrades ? 
                    (valResult.pf >= 1.0 ? 'PASS' : 'FAIL') : 'NO_TRADES',
            };

            results.windows.push(windowResult);

            if (windowResult.train.pf >= 1.5) results.summary.trainWins++;
            if (windowResult.val && windowResult.val.pf >= 1.0) results.summary.valWins++;
        }

        // Calculate summary
        const validWindows = results.windows.filter(w => w.val);
        if (validWindows.length > 0) {
            results.summary.avgTrainPF = validWindows.reduce((s, w) => s + w.train.pf, 0) / validWindows.length;
            results.summary.avgValPF = validWindows.reduce((s, w) => s + (w.val?.pf || 0), 0) / validWindows.length;
            results.summary.robustnessScore = (results.summary.valWins / validWindows.length) * 100;
            results.summary.validWindows = validWindows.length;
        }

        console.log(`\n[WFO] === Summary ===`);
        console.log(`[WFO] Total windows: ${results.summary.totalWindows}`);
        console.log(`[WFO] Valid windows: ${results.summary.validWindows}`);
        console.log(`[WFO] Train profitable: ${results.summary.trainWins}/${results.summary.validWindows}`);
        console.log(`[WFO] Val profitable: ${results.summary.valWins}/${results.summary.validWindows}`);
        console.log(`[WFO] Avg Train PF: ${results.summary.avgTrainPF.toFixed(2)}`);
        console.log(`[WFO] Avg Val PF: ${results.summary.avgValPF.toFixed(2)}`);
        console.log(`[WFO] Robustness Score: ${results.summary.robustnessScore.toFixed(1)}%`);

        return results;
    }

    _getDaysFromData(data) {
        if (!data || data.length < 2) return 0;
        const first = new Date(data[0].timestamp).getTime();
        const last = new Date(data[data.length - 1].timestamp).getTime();
        return Math.floor((last - first) / (24 * 60 * 60 * 1000));
    }

    _generateWindows(totalDays) {
        const windows = [];
        let trainStart = 0;
        
        while (true) {
            const trainEnd = trainStart + this.trainWindowDays;
            const valStart = trainEnd;
            const valEnd = valStart + this.valWindowDays;
            
            if (valEnd > totalDays) break;
            
            windows.push({
                trainStart,
                trainEnd,
                valStart,
                valEnd,
            });
            
            trainStart += this.stepDays;
        }
        
        return windows;
    }

    _extractWindow(data, startDay, endDay) {
        if (!data || data.length === 0) return [];
        
        const firstTs = new Date(data[0].timestamp).getTime();
        const msPerDay = 24 * 60 * 60 * 1000;
        
        const startTs = firstTs + startDay * msPerDay;
        const endTs = firstTs + endDay * msPerDay;
        
        return data.filter(d => {
            const ts = new Date(d.timestamp).getTime();
            return ts >= startTs && ts < endTs;
        });
    }

    async _findBestParams(data, backtestFn) {
        let bestResult = null;
        let bestScore = -Infinity;

        for (const params of this.paramGrid) {
            try {
                const result = await backtestFn(data, params);
                
                if (!result || result.trades < this.minTrainTrades) continue;

                // Score: PF × (1 - DD%) × trade count bonus
                const tradeBonus = Math.min(1.5, Math.log10(result.trades + 1) / 2);
                const score = result.pf * (1 - result.maxDrawdownPct / 100) * tradeBonus;

                if (score > bestScore && result.pf >= 1.0) {
                    bestScore = score;
                    bestResult = {
                        params,
                        pf: result.pf,
                        wr: result.winRate,
                        trades: result.trades,
                        maxDD: result.maxDrawdownPct,
                        score,
                    };
                }
            } catch (e) {
                // Skip failed params
            }
        }

        return bestResult;
    }

    async _testParams(data, backtestFn, params) {
        try {
            const result = await backtestFn(data, params);
            return result;
        } catch (e) {
            return null;
        }
    }

    /**
     * Get recommended params based on walk-forward results
     * Uses params that performed consistently across validation windows
     */
    getRecommendedParams(wfoResults) {
        const validWindows = wfoResults.windows.filter(w => w.val && w.val.trades >= this.minValTrades);
        
        if (validWindows.length === 0) {
            return null;
        }

        // Find params that appeared most often in profitable validation windows
        const paramCounts = {};
        
        validWindows.forEach(w => {
            if (w.val.pf >= 1.0) {
                const key = JSON.stringify(w.train.params);
                paramCounts[key] = (paramCounts[key] || 0) + 1;
            }
        });

        const sorted = Object.entries(paramCounts).sort((a, b) => b[1] - a[1]);
        
        if (sorted.length === 0) return null;

        return JSON.parse(sorted[0][0]);
    }
}

module.exports = WalkForwardOptimizer;