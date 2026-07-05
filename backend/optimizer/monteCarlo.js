/**
 * Monte Carlo Simulator — Strategy Robustness Testing
 * 
 * Randomizes trade sequence to measure how much results depend on order.
 * Runs N simulations, calculates percentile outcomes for drawdown/profit.
 * 
 * Usage: MonteCarlo.run(trades, simulations = 1000)
 */

class MonteCarlo {
    /**
     * Run Monte Carlo simulation on trade history
     * @param {Array} trades - Array of trade objects with pnl
     * @param {number} simulations - Number of random sequences to test
     * @returns {Object} Percentile results
     */
    static run(trades, simulations = 1000) {
        if (!trades || trades.length < 2) {
            return { error: 'Need at least 2 trades for Monte Carlo' };
        }

        const pnls = trades.map(t => t.pnl);
        const n = pnls.length;
        const results = [];

        console.log(`[MC] Running ${simulations} simulations on ${n} trades...`);

        for (let i = 0; i < simulations; i++) {
            // Shuffle trade order
            const shuffled = this._shuffle([...pnls]);
            
            // Calculate equity curve
            let equity = 50; // Starting balance
            let peak = 50;
            let maxDD = 0;
            
            for (const pnl of shuffled) {
                equity += pnl;
                if (equity > peak) peak = equity;
                const dd = (peak - equity) / peak;
                if (dd > maxDD) maxDD = dd;
            }

            results.push({
                finalEquity: equity,
                maxDrawdown: maxDD * 100,
                winRate: shuffled.filter(p => p > 0).length / n,
            });
        }

        // Sort for percentile calculation
        results.sort((a, b) => a.finalEquity - b.finalEquity);

        const percentiles = this._calculatePercentiles(results);

        console.log(`[MC] Done. 95% worst-case DD: ${percentiles.dd95.toFixed(1)}%`);

        return {
            ...percentiles,
            rawResults: results.slice(0, 100), // Return first 100 for detail
            note: `${simulations} simulations, trades shuffled randomly each run`
        };
    }

    /**
     * Fisher-Yates shuffle
     */
    static _shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    /**
     * Calculate percentile outcomes
     */
    static _calculatePercentiles(results) {
        const n = results.length;
        const getP = (arr, p) => arr[Math.floor((p / 100) * n)];

        return {
            // Equity percentiles
            equity5: getP(results, 5).finalEquity,   // Very bad
            equity25: getP(results, 25).finalEquity, // Bad
            equity50: getP(results, 50).finalEquity, // Median
            equity75: getP(results, 75).finalEquity, // Good
            equity95: getP(results, 95).finalEquity, // Very good

            // Drawdown percentiles
            dd5: getP(results, 5).maxDrawdown,      // Best case DD
            dd25: getP(results, 25).maxDrawdown,
            dd50: getP(results, 50).maxDrawdown,    // Median DD
            dd75: getP(results, 75).maxDrawdown,
            dd95: getP(results, 95).maxDrawdown,    // Worst case 95% DD

            // Win rate percentiles
            wr5: getP(results, 5).winRate,
            wr50: getP(results, 50).winRate,
            wr95: getP(results, 95).winRate,

            // Summary
            robustnessScore: (results.filter(r => r.finalEquity > 50).length / n) * 100,
        };
    }

    /**
     * Quick check: Is strategy robust?
     */
    static isRobust(trades, threshold = 0.8) {
        const result = this.run(trades, 500);
        if (result.error) return { robust: false, reason: result.error };

        // Strategy is robust if 80%+ of simulations remain profitable
        const robust = result.robustnessScore >= (threshold * 100);
        
        return {
            robust,
            robustnessScore: result.robustnessScore,
            worstCaseDD: result.dd95,
            worstCaseEquity: result.equity5,
            recommendation: robust 
                ? '✅ Strategy is ROBUST — results not dependent on trade order'
                : '⚠️ Strategy may be overfit — results vary significantly by trade order'
        };
    }
}

module.exports = MonteCarlo;