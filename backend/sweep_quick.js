const fs = require('fs');
const path = require('path');

// Quick parameter sweep — test key variables
async function runSweep() {
    const configs = [];
    
    for (const th of [4.0, 4.5, 5.0, 5.5, 6.0]) {
        for (const sl of [10, 12, 15]) {
            for (const tp1 of [40, 50, 60]) {
                configs.push({ threshold: th, sl: sl, tp1: tp1 });
            }
        }
    }
    
    const results = [];
    
    for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        
        process.env.CONFLUENCE_THRESHOLD = String(cfg.threshold);
        process.env.MAX_SL_DISTANCE = String(cfg.sl);
        process.env.TP1_CLOSE_PERCENT = String(cfg.tp1);
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
                config: `th${cfg.threshold}_sl${cfg.sl}_tp${cfg.tp1}`,
                trades: trades.length,
                wr: trades.length > 0 ? wins.length / trades.length : 0,
                pf: result.profitFactor || 0,
                ret: result.totalReturn || 0,
                dd: result.maxDrawdown || 0,
                sharpe: result.sharpeRatio || 0,
            };
            
            const tradeBonus = Math.min(trades.length / 5, 2.0);
            summary.score = summary.pf * (1 - summary.dd) * tradeBonus;
            results.push(summary);
            
            console.log(`[${String(i+1).padStart(2)}/${configs.length}] ${summary.config.padEnd(18)} Trades: ${String(summary.trades).padStart(2)}  WR: ${(summary.wr*100).toFixed(0).padStart(3)}%  PF: ${summary.pf.toFixed(2).padStart(5)}  Return: ${(summary.ret*100).toFixed(1).padStart(5)}%  DD: ${(summary.dd*100).toFixed(1).padStart(4)}%  Score: ${summary.score.toFixed(3)}`);
        } catch (e) {
            console.warn(`Config ${i} failed:`, e.message);
        }
    }
    
    results.sort((a, b) => b.score - a.score);
    
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('              TOP 10 CONFIGURATIONS');
    console.log('════════════════════════════════════════════════════════════\n');
    console.log('Rank  Config              Trades  WR%    PF     Return  DD%     Score');
    console.log('─'.repeat(75));
    results.slice(0, 10).forEach((r, i) => {
        console.log(`${String(i+1).padStart(2)}    ${r.config.padEnd(18)} ${String(r.trades).padStart(2)}    ${(r.wr*100).toFixed(0).padStart(3)}%   ${r.pf.toFixed(2).padStart(5)}  ${(r.ret*100).toFixed(1).padStart(5)}%  ${(r.dd*100).toFixed(1).padStart(4)}%  ${r.score.toFixed(3)}`);
    });
    
    return results[0];
}

runSweep().catch(console.error);
