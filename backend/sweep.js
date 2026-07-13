const fs = require('fs');
const path = require('path');

// Quick focused sweep — only most promising configs
async function runSweep() {
    const cacheFile = path.join(__dirname, 'xau_backtest_cache_2026-07-13_360.json');
    const allCandles = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.log(`Cache: ${allCandles.length} candles`);
    
    const configs = [];
    
    // Test: threshold × session window (core params)
    for (const th of [3.5, 4.0, 4.5, 5.0, 5.5]) {
        for (const session of [
            { start: 0, end: 24, label: '24h' },
            { start: 0, end: 20, label: '0-20' },
        ]) {
            configs.push({
                threshold: th,
                sessionStart: session.start,
                sessionEnd: session.end,
                label: `th${th}_${session.label}`,
            });
        }
    }
    
    const results = [];
    
    for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        
        // Set env vars
        process.env.CONFLUENCE_THRESHOLD = String(cfg.threshold);
        process.env.MAX_SL_DISTANCE = '15';
        process.env.TP1_CLOSE_PERCENT = '50';
        process.env.SCORE_MARGIN_MIN = '0.5';
        process.env.BUY_SCORE_MARGIN = '0.5';
        process.env.EMA_ALIGNMENT_REQUIRED = 'false';
        process.env.ZLEMA_REQUIRED = 'false';
        process.env.ZLEMA_ENTRY_REQUIRED = 'false';
        process.env.ZLEMA_5TF_ENABLED = 'false';
        
        // Clear require cache
        Object.keys(require.cache).forEach(key => {
            if (key.includes('unifiedStrategy') || key.includes('tradingBot') || key.includes('tradeEngine')) {
                delete require.cache[key];
            }
        });
        
        const TradingBot = require('./tradingBot');
        const bot = new TradingBot(null);
        
        // Patch session
        const TradeEngine = require('./tradeEngine');
        const orig = TradeEngine.prototype.evaluateEntry;
        TradeEngine.prototype.evaluateEntry = function(params) {
            const hour = params.currentCandle.timestamp.getUTCHours();
            const minute = params.currentCandle.timestamp.getUTCMinutes();
            const timeInMinutes = hour * 60 + minute;
            const isSessionOpen = (timeInMinutes >= cfg.sessionStart * 60 && timeInMinutes <= cfg.sessionEnd * 60);
            if (!isSessionOpen) {
                return { open: false, reason: 'outside_session', analysis: null };
            }
            return orig.call(this, params);
        };
        
        try {
            const result = await bot.runBacktest(90, 'default');
            const trades = result.trades || [];
            const wins = trades.filter(t => t.pnl > 0);
            
            const summary = {
                label: cfg.label,
                threshold: cfg.threshold,
                session: cfg.sessionEnd === 24 ? '24h' : '0-20',
                trades: trades.length,
                wr: trades.length > 0 ? wins.length / trades.length : 0,
                pf: result.profitFactor || 0,
                ret: result.totalReturn || 0,
                dd: result.maxDrawdown || 0,
            };
            
            results.push(summary);
            console.log(`[${i+1}/${configs.length}] ${summary.label.padEnd(15)} → Trades: ${String(summary.trades).padStart(2)}  WR: ${(summary.wr*100).toFixed(0).padStart(3)}%  PF: ${summary.pf.toFixed(2).padStart(5)}  Return: ${(summary.ret*100).toFixed(1).padStart(5)}%  DD: ${(summary.dd*100).toFixed(1).padStart(4)}%`);
        } catch (e) {
            console.warn(`Config ${i} failed:`, e.message);
        }
    }
    
    // Score and sort
    results.forEach(r => {
        const tradeBonus = Math.min(r.trades / 5, 2.0);
        r.score = r.pf * (1 - r.dd) * tradeBonus;
    });
    results.sort((a, b) => b.score - a.score);
    
    console.log('\n══════════════════════════════════════════════════');
    console.log('              SWEEP RESULTS');
    console.log('══════════════════════════════════════════════════\n');
    console.log('Rank  Config          Trades  WR%    PF     Return  DD%     Score');
    console.log('─'.repeat(75));
    results.forEach((r, i) => {
        console.log(`${String(i+1).padStart(2)}    ${r.label.padEnd(14)} ${String(r.trades).padStart(3)}    ${(r.wr*100).toFixed(0).padStart(3)}%   ${r.pf.toFixed(2).padStart(5)}  ${(r.ret*100).toFixed(1).padStart(5)}%  ${(r.dd*100).toFixed(1).padStart(4)}%  ${r.score.toFixed(3)}`);
    });
    
    return results[0];
}

runSweep().catch(console.error);
