const fs = require('fs');

// Quick parameter sweep with MAX_SL_DISTANCE=8
async function runSweep() {
    const configs = [
        { th: 4.5, sl: 6 },
        { th: 4.5, sl: 8 },
        { th: 5.0, sl: 6 },
        { th: 5.0, sl: 8 },
        { th: 5.0, sl: 10 },
        { th: 5.5, sl: 6 },
        { th: 5.5, sl: 8 },
        { th: 5.5, sl: 10 },
        { th: 6.0, sl: 6 },
        { th: 6.0, sl: 8 },
        { th: 6.0, sl: 10 },
        { th: 6.5, sl: 8 },
    ];
    
    const results = [];
    
    for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        
        process.env.CONFLUENCE_THRESHOLD = String(cfg.th);
        process.env.MAX_SL_DISTANCE = String(cfg.sl);
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
            const result = await bot.runBacktest(90, 'default');
            const trades = result.trades || [];
            const wins = trades.filter(t => t.pnl > 0);
            
            const summary = {
                config: `th${cfg.th}_sl${cfg.sl}`,
                trades: trades.length,
                wr: trades.length > 0 ? wins.length / trades.length : 0,
                pf: result.profitFactor || 0,
                ret: result.totalReturn || 0,
                dd: result.maxDrawdown || 0,
                sharpe: result.sharpeRatio || 0,
            };
            results.push(summary);
            
            console.log(`${summary.config.padEnd(12)} Trades: ${String(summary.trades).padStart(2)}  WR: ${(summary.wr*100).toFixed(0).padStart(3)}%  PF: ${summary.pf.toFixed(2).padStart(5)}  Return: ${(summary.ret*100).toFixed(0).padStart(4)}%  DD: ${(summary.dd*100).toFixed(0).padStart(3)}%  Sharpe: ${summary.sharpe.toFixed(2)}`);
        } catch (e) {
            console.warn(`Config failed:`, e.message);
        }
    }
    
    // Sort by composite score: PF * (1 - DD) * tradeBonus
    results.forEach(r => {
        const tradeBonus = Math.min(r.trades / 5, 2.0);
        r.score = r.pf * (1 - r.dd) * tradeBonus;
    });
    results.sort((a, b) => b.score - a.score);
    
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('              TOP CONFIGURATIONS');
    console.log('════════════════════════════════════════════════════════════\n');
    console.log('Rank  Config        Trades  WR%    PF     Return  DD%    Sharpe  Score');
    console.log('─'.repeat(75));
    results.forEach((r, i) => {
        console.log(`${String(i+1).padStart(2)}    ${r.config.padEnd(12)} ${String(r.trades).padStart(2)}    ${(r.wr*100).toFixed(0).padStart(3)}%  ${r.pf.toFixed(2).padStart(5)}  ${(r.ret*100).toFixed(0).padStart(4)}%  ${(r.dd*100).toFixed(0).padStart(3)}%   ${r.sharpe.toFixed(2).padStart(5)}  ${r.score.toFixed(3)}`);
    });
    
    return results[0];
}

runSweep().catch(console.error);
