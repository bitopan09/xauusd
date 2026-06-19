// Parameter sweep: find best MTF config
const fs = require('fs');

const tests = [
  // 1. Pure V4 variations (MTF disabled)
  {label:'V4-th50', mtf:false, threshold:5.0},
  {label:'V4-th60', mtf:false, threshold:6.0},
  {label:'V4-th65', mtf:false, threshold:6.5},
  {label:'V4-th70', mtf:false, threshold:7.0},

  // 2. MTF with default ORB params
  {label:'MTF-th50', mtf:true, threshold:5.0, orbCandles:2, prox:0.15},
  {label:'MTF-th60', mtf:true, threshold:6.0, orbCandles:2, prox:0.15},

  // 3. MTF with different proximity
  {label:'MTF-prox10', mtf:true, threshold:5.0, orbCandles:2, prox:0.10},
  {label:'MTF-prox20', mtf:true, threshold:5.0, orbCandles:2, prox:0.20},
  {label:'MTF-prox25', mtf:true, threshold:5.0, orbCandles:2, prox:0.25},

  // 4. MTF with different opening range candles
  {label:'MTF-orb1', mtf:true, threshold:5.0, orbCandles:1, prox:0.15},
  {label:'MTF-orb3', mtf:true, threshold:5.0, orbCandles:3, prox:0.15},
  {label:'MTF-orb4', mtf:true, threshold:5.0, orbCandles:4, prox:0.15},
];

async function main() {
  const results = [];
  for (const t of tests) {
    process.env.CONFLUENCE_THRESHOLD = String(t.threshold);
    
    // Create modified copy to disable MTF or set params
    let code = fs.readFileSync('tradingBot.js', 'utf8');
    
    if (!t.mtf) {
      code = code.replace('sub15.length >= 4', 'false && sub15.length >= 4');
    } else {
      // Set ORB params via replacing in the analyzeMTF call
      code = code.replace(
        /orbCandles: \d+/,
        `orbCandles: ${t.orbCandles || 2}`
      );
      // For proximity, need to modify goldSpecialist.js parameter
    }
    
    // Write temp file
    const tmpFile = 'tradingBot.sweep.js';
    fs.writeFileSync(tmpFile, code);
    
    // Delete require cache
    delete require.cache[require.resolve('./tradingBot')];
    const TradingBot = require('./tradingBot.sweep.js');
    // Also need to delete cache for its dependencies
    delete require.cache[require.resolve('./unifiedStrategyV3')];
    
    const bot = new TradingBot(null);
    try {
      const r = await bot.runBacktest(90, 'default');
      const {trades} = r;
      const wins = trades.filter(t => t.pnl > 0);
      const avgWin = wins.length ? wins.reduce((s,t) => s+t.pnl,0)/wins.length : 0;
      const avgLoss = (trades.length-wins.length) ? Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)/(trades.length-wins.length)) : 0;
      results.push({
        label: t.label,
        trades: trades.length,
        wr: (wins.length/trades.length*100).toFixed(1)+'%',
        pf: r.profitFactor?.toFixed(4) || 'N/A',
        ret: r.totalReturn?.toFixed(2)+'%' || 'N/A',
        dd: r.maxDrawdown?.toFixed(2)+'%' || 'N/A',
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        ratio: avgLoss > 0 ? (avgWin/avgLoss).toFixed(2) : 'N/A',
      });
      console.log('OK:', t.label);
    } catch(e) {
      results.push({label:t.label, error: e.message});
      console.log('FAIL:', t.label, e.message);
    }
    
    // Clean up
    fs.unlinkSync(tmpFile);
    // Give GC time
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log('\n=== SWEEP RESULTS ===');
  console.log('Label'.padEnd(16),'Trades','WR'.padEnd(6),'PF'.padEnd(8),'Return'.padEnd(10),'DD'.padEnd(10),'AvgW','AvgL','R:R');
  console.log('-'.repeat(95));
  for (const r of results) {
    if (r.error) {
      console.log(r.label.padEnd(16),'ERROR:', r.error.substring(0,40));
    } else {
      console.log(r.label.padEnd(16),String(r.trades).padEnd(6),r.wr.padEnd(6),r.pf.padEnd(8),r.ret.padEnd(10),r.dd.padEnd(10),r.avgWin,r.avgLoss,r.ratio);
    }
  }
  
  // Generate summary
  const best = results.filter(r => !r.error && parseFloat(r.pf) > 0).sort((a,b) => parseFloat(b.pf) - parseFloat(a.pf));
  console.log('\n=== TOP 3 by PF ===');
  best.slice(0,3).forEach(r => console.log(r.label, '- PF:', r.pf, 'Trades:', r.trades, 'WR:', r.wr, 'Return:', r.ret));
}

main().catch(e => console.error(e));
