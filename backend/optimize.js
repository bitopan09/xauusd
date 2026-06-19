const TradingBot = require('./tradingBot');

const CONFIGS = [
  { XAU_QUANTITY: 0.005, label: '0.005 lots (current)' },
  { XAU_QUANTITY: 0.003, label: '0.003 lots' },
  { XAU_QUANTITY: 0.002, label: '0.002 lots' },
  { XAU_QUANTITY: 0.001, label: '0.001 lots' },
];

async function runAll() {
  const results = [];
  for (const cfg of CONFIGS) {
    process.env.XAU_QUANTITY = String(cfg.XAU_QUANTITY);
    const bot = new TradingBot(null);
    const res = await bot.runBacktest(90);
    const ret = (res.totalReturn * 100).toFixed(1);
    const dd = (res.maxDrawdown * 100).toFixed(1);
    const wr = (res.winRate * 100).toFixed(1);
    const score = res.totalReturn - 0.4 * res.maxDrawdown;
    results.push({ cfg, res, score });
    console.log(`${cfg.label}: ${ret}% ret | ${dd}% DD | ${wr}% WR | PF ${res.profitFactor.toFixed(2)} | Sharpe ${res.sharpeRatio} | score=${score.toFixed(3)}`);
  }
  console.log('\n=== RANKING ===');
  results.sort((a, b) => b.score - a.score);
  results.forEach((r, i) => {
    const res = r.res;
    const ret = (res.totalReturn * 100).toFixed(1);
    const dd = (res.maxDrawdown * 100).toFixed(1);
    console.log(`#${i+1} ${r.cfg.label}: ${ret}% / ${dd}% DD / PF ${res.profitFactor.toFixed(2)} / Sharpe ${res.sharpeRatio} / score=${r.score.toFixed(3)}`);
  });
}

runAll().catch(e => { console.error(e.stack); process.exit(1); });
