const fs = require('fs');

// Test different window sizes
async function testWindows() {
    const data = JSON.parse(fs.readFileSync('xau_backtest_cache_2026-07-13_360.json', 'utf8'));
    
    const windows = [50, 100, 150, 200, 250, 300];
    
    for (const windowSize of windows) {
        process.env.CONFLUENCE_THRESHOLD = '6.5';
        process.env.MAX_SL_DISTANCE = '8';
        process.env.TP1_CLOSE_PERCENT = '50';
        process.env.SCORE_MARGIN_MIN = '0.5';
        process.env.BUY_SCORE_MARGIN = '0.5';
        process.env.EMA_ALIGNMENT_REQUIRED = 'false';
        process.env.ZLEMA_5TF_ENABLED = 'false';
        
        Object.keys(require.cache).forEach(key => {
            if (key.includes('unifiedStrategy') || key.includes('tradingBot') || key.includes('tradeEngine')) {
                delete require.cache[key];
            }
        });
        
        const TradingBot = require('./tradingBot');
        const bot = new TradingBot(null);
        
        try {
            const result = await bot.runBacktest(90, 'default', null, null, 50, windowSize);
            const trades = result.trades || [];
            const wins = trades.filter(t => t.pnl > 0);
            
            console.log(`Window ${String(windowSize).padStart(3)}: Trades: ${String(trades.length).padStart(2)} | WR: ${(wins.length/trades.length*100).toFixed(0).padStart(3)}% | PF: ${result.profitFactor.toFixed(2).padStart(5)} | Return: ${(result.totalReturn*100).toFixed(0).padStart(4)}% | DD: ${(result.maxDrawdown*100).toFixed(0).padStart(3)}%`);
        } catch (e) {
            console.error(`Window ${windowSize} failed:`, e.message);
        }
    }
}

testWindows().catch(console.error);
