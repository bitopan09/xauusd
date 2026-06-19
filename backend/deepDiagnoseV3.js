const UnifiedStrategy = require('./unifiedStrategyV3');
const fs = require('fs');

const cache = JSON.parse(fs.readFileSync(__dirname + '/xau_backtest_cache_2026-06-17.json', 'utf8'));
const candles = cache.candles || cache;

console.log(`Total candles: ${candles.length}`);
console.log(`First: ${candles[0].timestamp}  Last: ${candles[candles.length - 1].timestamp}\n`);

const strategy = new UnifiedStrategy();

// Track every signal that passes threshold 6.5
let buySignals = [], sellSignals = [];

for (let i = 50; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const result = strategy.calculateConfluenceScore(window);
    
    if (result.score >= 6.5) {
        const full = strategy.analyze(window);
        const ts = window[window.length - 1].timestamp;
        const price = window[window.length - 1].price;
        const fb = full.details.filterBreakdown || {};
        
        // Calculate EMA-50 vs EMA-200 for trend context
        const closes = window.map(p => p.close || p.price);
        const ema50 = strategy.calculateEma(closes, 50);
        const ema200 = strategy.calculateEma(closes, Math.min(200, closes.length));
        const ema50Val = ema50[ema50.length - 1];
        const ema200Val = ema200[ema200.length - 1];
        const trendBearish = ema50Val < ema200Val;
        
        // Look ahead 12 candles (48 hours) to see outcome
        let futurePnl = 0;
        let outcome = 'N/A';
        const entry = price;
        const sl = full.details.riskCalculator?.stopLoss;
        const tp = full.details.riskCalculator?.takeProfit;
        
        if (i + 12 < candles.length) {
            const future = candles.slice(i + 1, i + 13);
            if (full.signal === 'BUY') {
                // Check if TP2 or SL hit
                const hitsTP = future.some(c => c.high >= (tp?.tp2Long || 99999));
                const hitsSL = future.some(c => c.low <= (sl?.long || 0));
                if (hitsTP && !hitsSL) { outcome = 'WIN'; futurePnl = 14; }
                else if (hitsSL) { outcome = 'LOSS'; futurePnl = -2.5; }
                else { outcome = 'OPEN'; }
            } else if (full.signal === 'SELL') {
                const hitsTP = future.some(c => c.low <= (tp?.tp2Short || 0));
                const hitsSL = future.some(c => c.high >= (sl?.short || 99999));
                if (hitsTP && !hitsSL) { outcome = 'WIN'; futurePnl = 14; }
                else if (hitsSL) { outcome = 'LOSS'; futurePnl = -2.5; }
                else { outcome = 'OPEN'; }
            }
        }
        
        const entry_data = {
            ts, price: price.toFixed(2), score: result.score, direction: result.direction,
            signal: full.signal, ema50: ema50Val.toFixed(2), ema200: ema200Val.toFixed(2),
            trendBearish, dailyGate: fb.dailyGatePass, rejectedReason: fb.rejectedReason,
            outcome, futurePnl: futurePnl.toFixed(2)
        };
        
        if (full.signal === 'BUY') buySignals.push(entry_data);
        else if (full.signal === 'SELL') sellSignals.push(entry_data);
        else {
            // Log rejected signals too
            console.log(`[${ts}] Price: ${price.toFixed(2)} | Score: ${result.score.toFixed(1)} | Dir: ${result.direction} | ${full.signal} | REASON: ${fb.rejectedReason || 'none'} | EMA50: ${ema50Val.toFixed(0)} vs EMA200: ${ema200Val.toFixed(0)} ${trendBearish ? '(BEAR)' : '(BULL)'}`);
        }
    }
}

console.log(`\n=== ALL BUY SIGNALS (${buySignals.length}) ===`);
buySignals.forEach(s => {
    console.log(`[${s.ts}] $${s.price} | Score: ${s.score.toFixed(1)} | Dir: ${s.direction} | EMA50: ${s.ema50} vs EMA200: ${s.ema200} ${s.trendBearish ? '(TREND:BEAR)' : '(TREND:BULL)'} | DailyGate: ${s.dailyGate} | ${s.outcome} | P&L: $${s.futurePnl} | Reject: ${s.rejectedReason || 'none'}`);
});

console.log(`\n=== ALL SELL SIGNALS (${sellSignals.length}) ===`);
sellSignals.forEach(s => {
    console.log(`[${s.ts}] $${s.price} | Score: ${s.score.toFixed(1)} | Dir: ${s.direction} | EMA50: ${s.ema50} vs EMA200: ${s.ema200} ${s.trendBearish ? '(TREND:BEAR)' : '(TREND:BULL)'} | DailyGate: ${s.dailyGate} | ${s.outcome} | P&L: $${s.futurePnl} | Reject: ${s.rejectedReason || 'none'}`);
});

// Summary
const buyWins = buySignals.filter(s => s.outcome === 'WIN').length;
const buyLosses = buySignals.filter(s => s.outcome === 'LOSS').length;
const sellWins = sellSignals.filter(s => s.outcome === 'WIN').length;
const sellLosses = sellSignals.filter(s => s.outcome === 'LOSS').length;

console.log(`\n=== SUMMARY ===`);
console.log(`BUY:  ${buySignals.length} signals, ${buyWins}W/${buyLosses}L (${buySignals.length ? (buyWins/(buyWins+buyLosses)*100).toFixed(0) : 0}% win)`);
console.log(`SELL: ${sellSignals.length} signals, ${sellWins}W/${sellLosses}L (${sellSignals.length ? (sellWins/(sellWins+sellLosses)*100).toFixed(0) : 0}% win)`);
console.log(`BUY in BEAR trend: ${buySignals.filter(s => s.trendBearish).length}`);
console.log(`BUY in BULL trend: ${buySignals.filter(s => !s.trendBearish).length}`);
console.log(`SELL in BEAR trend: ${sellSignals.filter(s => s.trendBearish).length}`);
console.log(`SELL in BULL trend: ${sellSignals.filter(s => !s.trendBearish).length}`);
