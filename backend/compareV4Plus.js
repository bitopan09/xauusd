// V4-Plus vs V4-th65 comparison backtest
const fs = require('fs');
const path = require('path');

async function runBacktestWithStrategy(strategyFile, label, threshold = 6.5) {
    // Clear require caches
    Object.keys(require.cache).forEach(key => {
        if (key.includes('unifiedStrategy') || key.includes('tradingBot')) {
            delete require.cache[key];
        }
    });
    
    // Set threshold
    process.env.CONFLUENCE_THRESHOLD = String(threshold);
    
    // Override the strategy require
    const originalPath = require.resolve('./unifiedStrategyV3');
    require.cache[originalPath] = {
        id: originalPath,
        filename: originalPath,
        loaded: true,
        exports: require(strategyFile)
    };
    
    const TradingBot = require('./tradingBot');
    const bot = new TradingBot(null);
    
    console.log(`\n=== Running ${label} (threshold=${threshold}) ===`);
    const result = await bot.runBacktest(90, 'default');
    
    const { trades } = result;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    
    return {
        label,
        threshold,
        trades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: (wins.length / trades.length * 100).toFixed(1) + '%',
        profitFactor: result.profitFactor?.toFixed(4) || 'N/A',
        totalReturn: result.totalReturn?.toFixed(2) + '%' || 'N/A',
        maxDrawdown: result.maxDrawdown?.toFixed(2) + '%' || 'N/A',
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        winLossRatio: avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A',
        totalPnl: trades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
        trades
    };
}

async function main() {
    console.log('V4-Plus vs V4-th65 Backtest Comparison');
    console.log('=====================================\n');
    
    // Run V4-th65 baseline (backup file without VOF)
    const v4Baseline = await runBacktestWithStrategy('./unifiedStrategyV4.js', 'V4-th65 (baseline)', 6.5);
    
    // Run V4-Plus (current file with VOF)
    const v4Plus = await runBacktestWithStrategy('./unifiedStrategyV3.js', 'V4-Plus (VOF)', 6.5);
    
    // Print comparison
    console.log('\n\n=== COMPARISON RESULTS ===\n');
    console.log('Metric'.padEnd(20), 'V4-th65'.padEnd(15), 'V4-Plus'.padEnd(15), 'Delta');
    console.log('-'.repeat(65));
    
    const metrics = [
        ['Trades', v4Baseline.trades, v4Plus.trades],
        ['Win Rate', v4Baseline.winRate, v4Plus.winRate],
        ['Profit Factor', v4Baseline.profitFactor, v4Plus.profitFactor],
        ['Total Return', v4Baseline.totalReturn, v4Plus.totalReturn],
        ['Max Drawdown', v4Baseline.maxDrawdown, v4Plus.maxDrawdown],
        ['Avg Win ($)', v4Baseline.avgWin, v4Plus.avgWin],
        ['Avg Loss ($)', v4Baseline.avgLoss, v4Plus.avgLoss],
        ['Win/Loss Ratio', v4Baseline.winLossRatio, v4Plus.winLossRatio],
        ['Total PnL ($)', v4Baseline.totalPnl, v4Plus.totalPnl],
    ];
    
    for (const [name, baseline, plus] of metrics) {
        const baseVal = parseFloat(baseline) || 0;
        const plusVal = parseFloat(plus) || 0;
        let delta = '';
        if (!isNaN(baseVal) && !isNaN(plusVal) && baseVal !== 0) {
            const d = ((plusVal - baseVal) / Math.abs(baseVal) * 100).toFixed(1);
            delta = (d > 0 ? '+' : '') + d + '%';
        }
        console.log(name.padEnd(20), String(baseline).padEnd(15), String(plus).padEnd(15), delta);
    }
    
    // Trade-by-trade comparison
    console.log('\n\n=== TRADE-BY-TRADE COMPARISON ===\n');
    console.log('V4-th65 trades:');
    v4Baseline.trades.forEach((t, i) => {
        console.log(`  ${i+1}. ${t.action} ${t.exitReason?.padEnd(20)} PnL: $${t.pnl.toFixed(2)}`);
    });
    
    console.log('\nV4-Plus trades:');
    v4Plus.trades.forEach((t, i) => {
        console.log(`  ${i+1}. ${t.action} ${t.exitReason?.padEnd(20)} PnL: $${t.pnl.toFixed(2)}`);
    });
    
    // Save results to file
    const report = {
        timestamp: new Date().toISOString(),
        baseline: v4Baseline,
        v4Plus: v4Plus,
        comparison: {
            tradesDelta: v4Plus.trades - v4Baseline.trades,
            profitFactorDelta: parseFloat(v4Plus.profitFactor) - parseFloat(v4Baseline.profitFactor),
            totalPnlDelta: parseFloat(v4Plus.totalPnl) - parseFloat(v4Baseline.totalPnl),
        }
    };
    
    fs.writeFileSync('v4plus_comparison_report.json', JSON.stringify(report, null, 2));
    console.log('\n✓ Report saved to v4plus_comparison_report.json');
}

main().catch(console.error);
