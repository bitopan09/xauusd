const fs = require('fs');

// Simplified walk-forward with window=100
async function walkForward() {
    const data = JSON.parse(fs.readFileSync('xau_backtest_cache_2026-07-13_360.json', 'utf8'));
    
    // Split into 3 periods
    const periodSize = Math.floor(data.length / 3);
    const periods = [
        { start: 0, label: 'Period 1' },
        { start: periodSize, label: 'Period 2' },
        { start: periodSize * 2, label: 'Period 3' },
    ];
    
    console.log('Walk-Forward Validation (Window=100)\n');
    
    for (const period of periods) {
        const end = Math.min(period.start + periodSize, data.length);
        const periodData = data.slice(period.start, end);
        
        const clientCandles = periodData.map(d => [
            new Date(d.timestamp).getTime(),
            d.open, d.high, d.low, d.close, d.volume, 0
        ]);
        
        process.env.CONFLUENCE_THRESHOLD = '6.5';
        process.env.MAX_SL_DISTANCE = '8';
        
        Object.keys(require.cache).forEach(key => {
            if (key.includes('unifiedStrategy') || key.includes('tradingBot')) {
                delete require.cache[key];
            }
        });
        
        const TradingBot = require('./tradingBot');
        const bot = new TradingBot(null);
        
        try {
            const result = await bot.runBacktest(30, 'default', clientCandles, null, 50, 100);
            const trades = result.trades || [];
            const wins = trades.filter(t => t.pnl > 0);
            
            console.log(`${period.label}: Trades: ${trades.length} | WR: ${trades.length > 0 ? (wins.length/trades.length*100).toFixed(0) : 0}% | PF: ${result.profitFactor.toFixed(2)} | Return: ${(result.totalReturn*100).toFixed(0)}% | DD: ${(result.maxDrawdown*100).toFixed(0)}%`);
        } catch (e) {
            console.error(`${period.label} failed:`, e.message);
        }
    }
}

walkForward().catch(console.error);
