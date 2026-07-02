/**
 * DailyOptimizer — Hybrid parameter tuner + ML signal filter.
 *
 * Daily workflow:
 *   1. Fetch last N days of data
 *   2. Grid search over parameter space (fast backtest per config)
 *   3. Train ML signal filter on trade outcomes
 *   4. Evaluate: PF × (1 - MaxDD/100)
 *   5. Deploy best config if it improves over current
 *   6. Persist config to DB for bot to read on startup
 */

const fs = require('fs');
const path = require('path');

class DailyOptimizer {
    constructor(db, config = {}) {
        this.db = db;
        this.trainingDays = config.trainWindowDays || 30;
        this.validationDays = config.validationWindowDays || 7;
        this.confidenceThreshold = config.confidenceThreshold || 0.45;
        this.minSamples = config.minSamples || 20;
        this._ready = false;
        this._ensureTable();
    }

    async _waitReady() {
        if (this._ready) return;
        return new Promise(resolve => {
            const check = () => {
                if (this._ready) resolve();
                else setTimeout(check, 50);
            };
            check();
        });
    }

    _ensureTable() {
        this.db.serialize(() => {
            this.db.run(`CREATE TABLE IF NOT EXISTS optimizer_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                score REAL,
                profit_factor REAL,
                max_dd_pct REAL,
                win_rate REAL,
                trades INTEGER,
                deployed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_active INTEGER DEFAULT 1
            )`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_opt_config_key ON optimizer_config(key, deployed_at)`);
            this.db.run(`CREATE TABLE IF NOT EXISTS optimizer_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                total_configs INTEGER,
                best_pf REAL,
                best_config TEXT,
                best_score REAL,
                ml_accuracy REAL,
                ml_samples INTEGER,
                deployed INTEGER DEFAULT 0,
                improvement_pct REAL,
                duration_seconds REAL
            )`, () => {
                this._ready = true;
            });
        });
    }

    /**
     * Run a full optimization cycle.
     * @param {Object} options
     * @param {Array} options.priceData - Historical price data
     * @param {Function} options.runFastBacktest - (priceData, params) => { trades, equityCurve, stats }
     * @param {Object} options.paramSpace - Grid search parameter definitions from config.js
     * @returns {Object} Optimization result
     */
    async optimize(options) {
        const { priceData, runFastBacktest, paramSpace } = options;
        const startTime = Date.now();

        if (!priceData || priceData.length < 50) {
            return { success: false, error: 'Insufficient data (need 50+ candles)' };
        }

        // ── Step 1: Generate all parameter combinations ──
        const paramGrid = this._generateGrid(paramSpace.GRID);
        console.log(`[Optimizer] Testing ${paramGrid.length} parameter combinations...`);

        // ── Step 2: Grid search — run fast backtest for each config ──
        const results = [];
        for (let i = 0; i < paramGrid.length; i++) {
            const params = paramGrid[i];
            try {
                const backtestResult = await runFastBacktest(priceData, params);
                const score = this._evaluateScore(backtestResult, paramSpace.EVALUATION);

                results.push({
                    params,
                    stats: backtestResult.stats,
                    score,
                    trades: backtestResult.trades || [],
                    equityCurve: backtestResult.equityCurve || [],
                });
            } catch (err) {
                // Skip failed configs
            }

            if ((i + 1) % 10 === 0) {
                console.log(`[Optimizer] Progress: ${i + 1}/${paramGrid.length}`);
            }
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        const top5 = results.slice(0, 5);

        if (top5.length === 0) {
            return { success: false, error: 'All configs failed to produce results' };
        }

        // ── Step 3: Train ML signal filter on best config's trades ──
        const bestConfig = top5[0];
        const mlResult = this._trainMLFilter(bestConfig.trades, paramSpace.ML_FILTER);

        // ── Step 4: Filter trades through ML model and recompute score ──
        let mlFilteredScore = bestConfig.score;
        let mlFilteredStats = bestConfig.stats;
        if (mlResult.trained && bestConfig.trades.length >= this.minSamples) {
            const filteredTrades = bestConfig.trades.filter(t => {
                const features = this._extractFeatures(t, paramSpace.ML_FILTER.features);
                const prob = this._predict(mlResult.model, features);
                return prob >= this.confidenceThreshold;
            });

            if (filteredTrades.length > 0) {
                const filteredResult = this._computeStats(filteredTrades);
                mlFilteredScore = this._evaluateScore(
                    { stats: filteredResult, trades: filteredTrades },
                    paramSpace.EVALUATION
                );
                mlFilteredStats = filteredResult;
            }
        }

        // ── Step 5: Find best overall config ──
        const duration = (Date.now() - startTime) / 1000;

        // Check if ML filter improved the best config
        const useMLFiltered = mlFilteredScore > bestConfig.score;

        // ── Step 6: Compare to current active config ──
        const currentConfig = await this._getActiveConfig();
        const currentScore = currentConfig ? currentConfig.score : 0;
        const improvementPct = currentScore > 0
            ? (((useMLFiltered ? mlFilteredScore : bestConfig.score) - currentScore) / currentScore * 100)
            : 100;

        const shouldDeploy = improvementPct >= (paramSpace.EVALUATION?.rollingDeployThreshold || 5);

        // ── Step 7: Persist results ──
        const bestParams = useMLFiltered
            ? { ...bestConfig.params, mlFilterEnabled: true, mlConfidence: this.confidenceThreshold }
            : bestConfig.params;

        await this._saveRun({
            totalConfigs: paramGrid.length,
            bestPF: useMLFiltered ? mlFilteredStats.profitFactor : bestConfig.stats.profitFactor,
            bestConfig: JSON.stringify(bestParams),
            bestScore: useMLFiltered ? mlFilteredScore : bestConfig.score,
            mlAccuracy: mlResult.accuracy,
            mlSamples: mlResult.samples,
            deployed: shouldDeploy ? 1 : 0,
            improvementPct,
            durationSeconds: duration,
        });

        if (shouldDeploy) {
            await this._deployConfig(bestParams, useMLFiltered ? mlFilteredScore : bestConfig.score, useMLFiltered ? mlFilteredStats : bestConfig.stats);
        }

        return {
            success: true,
            totalConfigs: paramGrid.length,
            duration: duration.toFixed(1) + 's',
            topConfigs: top5.map(r => ({
                params: r.params,
                pf: r.stats.profitFactor,
                wr: r.stats.winRate,
                maxDD: r.stats.maxDDPct,
                trades: r.stats.totalTrades,
                score: r.score,
            })),
            mlFilter: {
                trained: mlResult.trained,
                accuracy: mlResult.accuracy,
                samples: mlResult.samples,
                improvedScore: useMLFiltered,
                filteredScore: mlFilteredScore,
            },
            bestConfig: bestParams,
            bestScore: useMLFiltered ? mlFilteredScore : bestConfig.score,
            bestStats: useMLFiltered ? mlFilteredStats : bestConfig.stats,
            improvementOverCurrent: improvementPct.toFixed(1) + '%',
            deployed: shouldDeploy,
        };
    }

    /**
     * Generate all combinations from parameter grid.
     */
    _generateGrid(paramGrid) {
        const keys = Object.keys(paramGrid);
        const combinations = [[]];

        for (const key of keys) {
            const values = paramGrid[key].values;
            const newCombos = [];
            for (const combo of combinations) {
                for (const val of values) {
                    newCombos.push([...combo, { key, value: val }]);
                }
            }
            combinations.length = 0;
            combinations.push(...newCombos);
        }

        return combinations.map(combo => {
            const params = {};
            combo.forEach(({ key, value }) => { params[key] = value; });
            return params;
        });
    }

    /**
     * Evaluate config score: PF × (1 - MaxDD/100) with minimum criteria.
     */
    _evaluateScore(result, evaluationConfig) {
        const s = result.stats;
        const minWR = evaluationConfig?.minWinRate || 0.40;
        const maxDD = evaluationConfig?.maxDrawdownPct || 30;

        // Penalize configs that don't meet minimum criteria
        if (s.winRate < minWR || s.maxDDPct > maxDD || s.totalTrades < 5) {
            return 0;
        }

        const pfAdjusted = s.profitFactor * (1 - Math.min(s.maxDDPct, 100) / 100);
        // Bonus for more trades (but capped)
        const tradeBonus = Math.min(s.totalTrades / 20, 1.0);
        return pfAdjusted * (1 + tradeBonus * 0.1);
    }

    /**
     * Train a simple ML filter (logistic regression on trade outcomes).
     * This is a lightweight version — for production, consider using a proper
     * ML library or external service.
     */
    _trainMLFilter(trades, mlConfig) {
        if (!trades || trades.length < this.minSamples) {
            return { trained: false, accuracy: 0, samples: trades ? trades.length : 0, model: null };
        }

        const features = mlConfig.features || [];
        const X = [];
        const y = [];

        for (const t of trades) {
            const feats = this._extractFeatures(t, features);
            if (feats.every(f => f !== null && f !== undefined && isFinite(f))) {
                X.push(feats);
                y.push(t.pnl > 0 ? 1 : 0);
            }
        }

        if (X.length < this.minSamples / 2) {
            return { trained: false, accuracy: 0, samples: X.length, model: null };
        }

        // Simple logistic regression using gradient descent
        const model = this._trainLogisticRegression(X, y);

        // Compute accuracy
        let correct = 0;
        for (let i = 0; i < X.length; i++) {
            const pred = this._predict(model, X[i]) >= 0.5 ? 1 : 0;
            if (pred === y[i]) correct++;
        }

        return {
            trained: true,
            accuracy: (correct / X.length).toFixed(3),
            samples: X.length,
            model,
        };
    }

    /**
     * Simple logistic regression with gradient descent (batched).
     * For production use, replace with a proper library like ml-logistic-regression.
     */
    _trainLogisticRegression(X, y, lr = 0.01, epochs = 500) {
        const n = X.length;
        const d = X[0].length;
        let weights = new Array(d).fill(0);
        let bias = 0;

        const sigmoid = (z) => 1 / (1 + Math.exp(-z));

        for (let epoch = 0; epoch < epochs; epoch++) {
            let dw = new Array(d).fill(0);
            let db = 0;

            for (let i = 0; i < n; i++) {
                const z = X[i].reduce((s, x, j) => s + x * weights[j], bias);
                const pred = sigmoid(z);
                const error = pred - y[i];

                for (let j = 0; j < d; j++) {
                    dw[j] += error * X[i][j];
                }
                db += error;
            }

            for (let j = 0; j < d; j++) {
                weights[j] -= (lr * dw[j]) / n;
            }
            bias -= (lr * db) / n;
        }

        return { weights, bias };
    }

    _predict(model, features) {
        if (!model || !model.weights) return 0.5;
        const z = features.reduce((s, x, j) => s + x * (model.weights[j] || 0), model.bias || 0);
        return 1 / (1 + Math.exp(-z));
    }

    /**
     * Extract feature vector from a trade record.
     */
    _extractFeatures(trade, featureNames) {
        const map = {
            score: trade.score || 0,
            scoreMargin: trade.scoreMargin || trade.confluence?.scoreMargin || 0,
            adx: trade.adx || trade.indicators?.adx || 20,
            rsi: trade.rsi || trade.indicators?.rsi || 50,
            macdHistogram: trade.macdHistogram || 0,
            emaAlignment: trade.emaAlignment || (trade.indicators?.ema9Val > trade.indicators?.ema21Val ? 1 : 0),
            atrPct: trade.atrPct || trade.indicators?.atrPct || 0,
            volumeRatio: trade.volumeRatio || 1,
            regimeTrending: trade.regime === 'trending' ? 1 : 0,
            regimeVolatile: trade.regime === 'volatile' ? 1 : 0,
            pullbackZone: trade.pullbackZone === 'premium' ? 1 : trade.pullbackZone === 'discount' ? 2 : 0,
            sessionActive: trade.sessionActive || 1,
            dayOfWeek: trade.dayOfWeek || new Date(trade.entryTimestamp || Date.now()).getDay(),
        };

        return featureNames.map(name => {
            const val = map[name];
            if (val === undefined || val === null) return 0;
            if (!isFinite(val)) return 0;
            return Number(val);
        });
    }

    /**
     * Compute statistics from filtered trades.
     */
    _computeStats(trades) {
        const wins = trades.filter(t => t.pnl > 0);
        const losses = trades.filter(t => t.pnl <= 0);
        const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;
        const wr = trades.length > 0 ? wins.length / trades.length : 0;
        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

        // Max DD
        let peak = 50, maxDD = 0, eq = 50;
        for (const t of trades) {
            eq += t.pnl;
            if (eq > peak) peak = eq;
            const dd = (peak - eq) / peak * 100;
            if (dd > maxDD) maxDD = dd;
        }

        return {
            totalTrades: trades.length,
            winRate: wr,
            profitFactor: pf,
            totalPnl,
            maxDDPct: maxDD,
            avgWin: wins.length ? grossWins / wins.length : 0,
            avgLoss: losses.length ? grossLosses / losses.length : 0,
        };
    }

    /**
     * Get currently active optimizer config from DB.
     */
    async _getActiveConfig() {
        await this._waitReady();
        return new Promise((resolve) => {
            this.db.get(
                `SELECT key, value, score, profit_factor, max_dd_pct, win_rate, trades 
                 FROM optimizer_config WHERE is_active = 1 
                 ORDER BY deployed_at DESC LIMIT 1`,
                (err, row) => {
                    if (err || !row) return resolve(null);
                    try {
                        resolve({
                            config: JSON.parse(row.value),
                            score: row.score,
                            stats: {
                                profitFactor: row.profit_factor,
                                maxDDPct: row.max_dd_pct,
                                winRate: row.win_rate,
                                totalTrades: row.trades,
                            }
                        });
                    } catch { resolve(null); }
                }
            );
        });
    }

    /**
     * Save optimizer run record.
     */
    async _saveRun(runData) {
        await this._waitReady();
        return new Promise((resolve) => {
            this.db.run(
                `INSERT INTO optimizer_runs (total_configs, best_pf, best_config, best_score, ml_accuracy, ml_samples, deployed, improvement_pct, duration_seconds)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [runData.totalConfigs, runData.bestPF, runData.bestConfig, runData.bestScore,
                 runData.mlAccuracy, runData.mlSamples, runData.deployed,
                 runData.improvementPct, runData.durationSeconds],
                (err) => resolve(!err)
            );
        });
    }

    /**
     * Deploy best config to DB (making it active).
     */
    async _deployConfig(params, score, stats) {
        await this._waitReady();
        this.db.run(`UPDATE optimizer_config SET is_active = 0`);

        const configJson = JSON.stringify(params);
        return new Promise((resolve) => {
            this.db.run(
                `INSERT INTO optimizer_config (key, value, score, profit_factor, max_dd_pct, win_rate, trades, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                ['daily_optimized', configJson, score,
                 stats.profitFactor, stats.maxDDPct, stats.winRate, stats.totalTrades],
                (err) => resolve(!err)
            );
        });
    }

    /**
     * Get optimizer run history for dashboard.
     */
    async getHistory(limit = 10) {
        await this._waitReady();
        return new Promise((resolve) => {
            this.db.all(
                `SELECT * FROM optimizer_runs ORDER BY run_at DESC LIMIT ?`,
                [limit],
                (err, rows) => resolve(err ? [] : rows)
            );
        });
    }

    /**
     * Get current active optimizer config.
     */
    async getActiveConfig() {
        const config = await this._getActiveConfig();
        if (!config) return null;

        // Also get latest run info
        const runs = await this.getHistory(1);
        return {
            ...config,
            lastOptimization: runs[0]?.run_at || null,
            lastImprovement: runs[0]?.improvement_pct || null,
            lastDeployed: runs[0]?.deployed === 1,
        };
    }
}

module.exports = DailyOptimizer;
