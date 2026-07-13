// Run backtest starting from 50% of available data
const fs = require('fs');
const path = require('path');

async function run() {
    process.env.CONFLUENCE_THRESHOLD = '5.5';
    process.env.MAX_SL_DISTANCE = '15';
    process.env.TP1_CLOSE_PERCENT = '50';

    // Find the most recent cache file for 6H (360m) data
    const cacheDir = __dirname;
    const cacheFiles = fs.readdirSync(cacheDir)
        .filter(f => f.startsWith('xau_backtest_cache_') && f.includes('_360.json'))
        .sort()
        .reverse();
    if (cacheFiles.length === 0) {
        throw new Error('No 6H cache files found in ' + cacheDir);
    }
    const cacheFile = path.join(__dirname, cacheFiles[0]);
    console.log(`Using cache file: ${cacheFiles[0]}`);
    const allCandles = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    
    const halfIdx = Math.floor(allCandles.length / 2);
    const secondHalf = allCandles.slice(halfIdx);
    
    console.log(`Total candles: ${allCandles.length}, using last ${secondHalf.length} (from index ${halfIdx})`);
    
    Object.keys(require.cache).forEach(key => {
        if (key.includes('unifiedStrategy') || key.includes('tradingBot')) {
            delete require.cache[key];
        }
    });

    const TradingBot = require('./tradingBot');
    const bot = new TradingBot(null);
    
    // Convert cache format to clientCandle format [[ts,o,h,l,c,v,turnover],...]
    const clientCandles = secondHalf.map(d => [
        new Date(d.timestamp).getTime(),
        d.open,
        d.high,
        d.low,
        d.close,
        d.volume,
        0
    ]);

    const result = await bot.runBacktest(90, 'default', clientCandles);
    const { trades: rawTrades } = result;

    const CIRCUIT_BREAKER = 15;
    let equity = 50;
    let peak = 50;
    const trades = [];

    for (const t of rawTrades) {
        if (equity < CIRCUIT_BREAKER) {
            console.log(`  ⚠ CIRCUIT BREAKER: Equity $${equity.toFixed(2)} < $${CIRCUIT_BREAKER} — stopping.`);
            break;
        }
        const ddPct = (peak - equity) / peak;
        let sizeMultiplier;
        if (ddPct < 0.10)      sizeMultiplier = 1.0;
        else if (ddPct < 0.20) sizeMultiplier = 0.80;
        else if (ddPct < 0.30) sizeMultiplier = 0.60;
        else                    sizeMultiplier = 0.35;

        const adjustedPnl = t.pnl * sizeMultiplier;
        trades.push({ ...t, pnl: adjustedPnl, sizeMultiplier });
        equity += adjustedPnl;
        if (equity > peak) peak = equity;
    }

    console.log('\n═══ TRADE-BY-TRADE LOG ═══\n');
    equity = 50;
    trades.forEach((t, i) => {
        equity += t.pnl;
        const date = t.entryTime?.toISOString().split('T')[0] || 'N/A';
        const pnl = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
        console.log(`${String(i+1).padEnd(3)} ${date} ${(t.action||'').padEnd(5)} entry:$${(t.entryPrice||0).toFixed(2)} exit:$${(t.exitPrice||0).toFixed(2)} ${(t.exitReason||'').padEnd(22)} ${pnl} eq:$${equity.toFixed(2)}`);
    });

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    console.log('\n═══ RESULTS ═══');
    console.log(`Trades: ${trades.length} | WR: ${(wins.length/trades.length*100).toFixed(1)}% | PF: ${pf.toFixed(2)}`);
    console.log(`Final: $${equity.toFixed(2)} | PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`Avg Win: $${(grossWins/wins.length).toFixed(2)} | Avg Loss: $${(grossLosses/losses.length).toFixed(2)}`);
}

run().catch(console.error);
