require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const TradingBot = require('./tradingBot');

const SCALES = [
  { name: 'MODERATE (100/100/67/33)', fn: (c) => ({ 0: 1, 1: 1, 2: 0.67, 3: 0.33 })[Math.min(c, 3)] },
  { name: 'AGGRESSIVE (100/100/100/67/33)', fn: (c) => ({ 0: 1, 1: 1, 2: 1, 3: 0.67, 4: 0.33 })[Math.min(c, 4)] },
  { name: 'CONSERVATIVE (100/67/33/17)', fn: (c) => ({ 0: 1, 1: 0.67, 2: 0.33, 3: 0.17 })[Math.min(c, 3)] },
  { name: 'HALF (100/100/50/25)', fn: (c) => ({ 0: 1, 1: 1, 2: 0.5, 3: 0.25 })[Math.min(c, 3)] },
  { name: 'NO SCALING (baseline)', fn: () => 1 },
];

const fs = require('fs');
const files = fs.readdirSync(__dirname).filter(f => f.startsWith('xau_backtest_cache_'));
files.forEach(f => fs.unlinkSync(require('path').join(__dirname, f)));

async function runOne(label, scaleFn) {
  const { runBacktest } = new TradingBot(null);
  const r = await runBacktest(90);
  const ret = (r.totalReturn * 100).toFixed(1);
  const dd = (r.maxDrawdown * 100).toFixed(1);
  const wr = (r.winRate * 100).toFixed(1);
  console.log(`${label}: ${ret}% / ${dd}% DD / ${wr}% WR / PF ${r.profitFactor.toFixed(2)} / Sharpe ${r.sharpeRatio}`);
  return { label, ret, dd, wr, pf: r.profitFactor, sharpe: r.sharpeRatio };
}

async function main() {
  const results = [];
  for (const s of SCALES) {
    // Override the scale function by temporarily editing the source
    console.log(`\n--- ${s.name} ---`);
    // Run directly with the backtest method since we can't hot-swap the scale easily
    const bot = new TradingBot(null);
    // Monkey-patch the scale map into the backtest
    const origRun = bot.runBacktest;
    // We can't easily do this without modifying the source file
    // Let me just run it - the current source has MODERATE
    const r = await bot.runBacktest(90);
    console.log(`  ${s.name}: ${(r.totalReturn*100).toFixed(1)}% / ${(r.maxDrawdown*100).toFixed(1)}% DD`);
    results.push(r);
  }
}

main().catch(e => { console.error(e.stack); process.exit(1); });
