const fs = require('fs');
const path = require('path');

function aggregateTo30m(candles15m) {
    const candles30m = [];
    // Skip leading dummy candles (volume < 0.01)
    const startIdx = candles15m.findIndex(c => c.volume > 0.01);
    const clean = startIdx > 0 ? candles15m.slice(startIdx) : candles15m;

    for (let i = 0; i < clean.length - 1; i += 2) {
        const a = clean[i];
        const b = clean[i + 1];
        candles30m.push({
            timestamp: b.timestamp,
            open: a.open,
            high: Math.max(a.high, b.high),
            low: Math.min(a.low, b.low),
            close: b.close,
            volume: (a.volume || 0) + (b.volume || 0),
            price: b.price || b.close,
        });
    }
    return candles30m;
}

async function runBacktest30m() {
    const START_CAPITALS = [50, 100, 150];
    const results = [];

    process.env.CONFLUENCE_THRESHOLD = '5.5';
    process.env.MAX_SL_DISTANCE = '15';

    const cacheFile30 = path.join(__dirname, 'xau_backtest_cache_2026-06-18_30.json');
    if (!fs.existsSync(cacheFile30)) {
        console.error('ERROR: 30m cache file not found at', cacheFile30);
        process.exit(1);
    }

    const candles30m = JSON.parse(fs.readFileSync(cacheFile30, 'utf8'));
    console.log(`Loaded ${candles30m.length} 30m candles\n`);

    for (const START_EQ of START_CAPITALS) {

    Object.keys(require.cache).forEach(key => {
        if (key.includes('unifiedStrategy') || key.includes('tradingBot')) {
            delete require.cache[key];
        }
    });
    const TradingBot = require('./tradingBot');
    const bot = new TradingBot(null);

    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log(`║     V4-PLUS (VOF) 30m BACKTEST — $${START_EQ} Start               ║`);
    console.log('║     90 Days | 0.01 Min Lots | Threshold 6.5            ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const clientCandles = candles30m.map(k => [
        new Date(k.timestamp).getTime().toString(),
        String(k.open),
        String(k.high),
        String(k.low),
        String(k.close),
        String(k.volume || 0),
        '0'
    ]);

    const result = await bot.runBacktest(90, 'default', clientCandles, '30', START_EQ);
    const { trades } = result;

    // ── TRADE LOG ──
    console.log('═══ TRADE-BY-TRADE LOG ═══\n');
    console.log(
        '#'.padEnd(4),
        'Date'.padEnd(12),
        'Action'.padEnd(6),
        'Entry'.padEnd(10),
        'Exit'.padEnd(10),
        'SL'.padEnd(10),
        'TP1'.padEnd(10),
        'TP2'.padEnd(10),
        'Exit Reason'.padEnd(22),
        'PnL'.padEnd(10),
        'Equity'
    );
    console.log('─'.repeat(100));

    let equity = START_EQ;
    const equityCurve = [START_EQ];
    const dailyEquity = {};

    trades.forEach((t, i) => {
        equity += t.pnl;
        equityCurve.push(equity);

        const date = t.entryTime?.toISOString().split('T')[0] || 'N/A';
        if (!dailyEquity[date]) dailyEquity[date] = { start: equity, end: equity, trades: 0 };
        dailyEquity[date].end = equity;
        dailyEquity[date].trades++;

        const action = t.action?.padEnd(5) || 'N/A';
        const entry = t.entryPrice?.toFixed(2) || 'N/A';
        const exit = t.exitPrice?.toFixed(2) || 'N/A';
        const sl = t.sl?.toFixed(2) || 'N/A';
        const tp1 = t.tp1?.toFixed(2) || 'N/A';
        const tp2 = t.tp2?.toFixed(2) || 'N/A';
        const exitReason = (t.exitReason || 'N/A').padEnd(22);
        const pnl = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
        const emoji = t.pnl >= 0 ? '✅' : '❌';

        console.log(
            `${String(i+1).padEnd(4)}`,
            `${date.padEnd(12)}`,
            `${action.padEnd(6)}`,
            `$${entry}`.padEnd(10),
            `$${exit}`.padEnd(10),
            `$${sl}`.padEnd(10),
            `$${tp1}`.padEnd(10),
            `$${tp2}`.padEnd(10),
            `${exitReason}`,
            `${pnl}`.padEnd(10),
            `$${equity.toFixed(2)}`,
            emoji
        );
    });

    // ── STATISTICS ──
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
    const avgWin = wins.length ? grossWins / wins.length : 0;
    const avgLoss = losses.length ? grossLosses / losses.length : 0;
    const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

    let peak = START_EQ, maxDD = 0, maxDDPct = 0;
    equityCurve.forEach(eq => {
        if (eq > peak) peak = eq;
        const dd = peak - eq;
        const ddPct = (dd / peak) * 100;
        if (ddPct > maxDDPct) { maxDD = dd; maxDDPct = ddPct; }
    });

    let maxConsecWin = 0, maxConsecLoss = 0, curWin = 0, curLoss = 0;
    trades.forEach(t => {
        if (t.pnl > 0) { curWin++; curLoss = 0; maxConsecWin = Math.max(maxConsecWin, curWin); }
        else { curLoss++; curWin = 0; maxConsecLoss = Math.max(maxConsecLoss, curLoss); }
    });

    const exitReasons = {};
    trades.forEach(t => {
        const r = t.exitReason || 'Unknown';
        if (!exitReasons[r]) exitReasons[r] = { count: 0, pnl: 0 };
        exitReasons[r].count++;
        exitReasons[r].pnl += t.pnl;
    });

    const regimeStats = {};
    trades.forEach(t => {
        const r = t.regime || 'unknown';
        if (!regimeStats[r]) regimeStats[r] = { count: 0, wins: 0, pnl: 0 };
        regimeStats[r].count++;
        if (t.pnl > 0) regimeStats[r].wins++;
        regimeStats[r].pnl += t.pnl;
    });

    const actionStats = {};
    trades.forEach(t => {
        const a = t.action || 'unknown';
        if (!actionStats[a]) actionStats[a] = { count: 0, wins: 0, pnl: 0 };
        actionStats[a].count++;
        if (t.pnl > 0) actionStats[a].wins++;
        actionStats[a].pnl += t.pnl;
    });

    console.log('\n\n═══ PERFORMANCE STATISTICS (30m) ═══\n');
    console.log(`Starting Balance:     $${START_EQ.toFixed(2)}`);
    console.log(`Final Balance:        $${equity.toFixed(2)}`);
    console.log(`Total PnL:            ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`Total Return:         ${((totalPnl / START_EQ) * 100).toFixed(2)}%`);
    console.log(`Max Drawdown:         $${maxDD.toFixed(2)} (${maxDDPct.toFixed(2)}%)`);
    console.log(`Profit Factor:        ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
    console.log(`Win Rate:             ${(wins.length / trades.length * 100).toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
    console.log(`Avg Win:              $${avgWin.toFixed(2)}`);
    console.log(`Avg Loss:             $${avgLoss.toFixed(2)}`);
    console.log(`Win/Loss Ratio:       ${winLossRatio.toFixed(2)}:1`);
    console.log(`Avg PnL/Trade:        $${(totalPnl / trades.length).toFixed(2)}`);
    console.log(`Max Consec Wins:      ${maxConsecWin}`);
    console.log(`Max Consec Losses:    ${maxConsecLoss}`);
    console.log(`Total Trades:         ${trades.length}`);
    console.log(`Trades/Day:           ${(trades.length / 90).toFixed(2)}`);

    console.log('\n\n═══ EXIT REASON BREAKDOWN ═══\n');
    console.log('Reason'.padEnd(25), 'Count'.padEnd(8), 'Win%'.padEnd(8), 'Total PnL');
    console.log('─'.repeat(55));
    Object.entries(exitReasons).sort((a,b) => b[1].count - a[1].count).forEach(([reason, data]) => {
        const wr = trades.length ? (data.count / trades.length * 100).toFixed(0) : '0';
        const pnl = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        console.log(reason.padEnd(25), String(data.count).padEnd(8), (wr + '%').padEnd(8), pnl);
    });

    console.log('\n\n═══ REGIME BREAKDOWN ═══\n');
    console.log('Regime'.padEnd(15), 'Trades'.padEnd(10), 'Win%'.padEnd(10), 'Total PnL');
    console.log('─'.repeat(50));
    Object.entries(regimeStats).sort((a,b) => b[1].count - a[1].count).forEach(([regime, data]) => {
        const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(1) : '0.0';
        const pnl = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        console.log(regime.padEnd(15), String(data.count).padEnd(10), (wr + '%').padEnd(10), pnl);
    });

    console.log('\n\n═══ ACTION BREAKDOWN ═══\n');
    console.log('Action'.padEnd(10), 'Trades'.padEnd(10), 'Win%'.padEnd(10), 'Total PnL');
    console.log('─'.repeat(45));
    Object.entries(actionStats).sort((a,b) => b[1].count - a[1].count).forEach(([action, data]) => {
        const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(1) : '0.0';
        const pnl = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        console.log(action.padEnd(10), String(data.count).padEnd(10), (wr + '%').padEnd(10), pnl);
    });

    // ── EQUITY CURVE (ASCII) ──
    console.log('\n\n═══ EQUITY CURVE ═══\n');
    const minEq = Math.min(...equityCurve);
    const maxEq = Math.max(...equityCurve);
    const range = maxEq - minEq || 1;
    const chartWidth = 50;

    equityCurve.forEach((eq, i) => {
        const barLen = Math.round(((eq - minEq) / range) * chartWidth);
        const bar = '█'.repeat(barLen);
        const marker = eq >= START_EQ ? '▲' : '▼';
        if (i % 5 === 0 || i === equityCurve.length - 1) {
            console.log(`$${eq.toFixed(0).padStart(6)} │${bar} ${marker}`);
        }
    });
    console.log(`       └${'─'.repeat(chartWidth)}`);
    console.log(`        $${minEq.toFixed(0)}${' '.repeat(chartWidth - String(minEq.toFixed(0)).length - String(maxEq.toFixed(0)).length)}$${maxEq.toFixed(0)}`);

    const intervalInfo = `30m (${candles30m.length} candles, ${new Date(candles30m[0]?.timestamp).toISOString().split('T')[0]} to ${new Date(candles30m[candles30m.length-1]?.timestamp).toISOString().split('T')[0]})`;
    console.log(`\n  Interval: ${intervalInfo}`);
    console.log(`  Trades: ${trades.length} | Win Rate: ${wins.length ? (wins.length/trades.length*100).toFixed(1) : '0.0'}% | PF: ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
    console.log(`  Final: $${equity.toFixed(2)} | DD: ${maxDDPct.toFixed(1)}%`);

    // Save report
    const report = {
        timestamp: new Date().toISOString(),
        interval: '30',
        config: { startingBalance: START_EQ, minLots: 0.01, threshold: 5.5, days: 90, maxSL: 15 },
        statistics: {
            finalBalance: equity,
            totalPnl,
            totalReturn: ((totalPnl / START_EQ) * 100).toFixed(2) + '%',
            maxDrawdown: maxDD,
            maxDrawdownPct: maxDDPct.toFixed(2) + '%',
            profitFactor: pf === Infinity ? 'Infinity' : pf.toFixed(2),
            winRate: trades.length ? (wins.length / trades.length * 100).toFixed(1) + '%' : '0.0%',
            avgWin, avgLoss, winLossRatio,
            totalTrades: trades.length,
            maxConsecWins: maxConsecWin,
            maxConsecLosses: maxConsecLoss
        },
        trades,
        exitReasons,
        regimeStats,
        actionStats
    };

    fs.writeFileSync(`v4plus_30m_backtest_report_$${START_EQ}.json`, JSON.stringify(report, null, 2));
    console.log(`\n✓ Report saved to v4plus_30m_backtest_report_$${START_EQ}.json\n`);

    results.push({ capital: START_EQ, final: equity, return: ((totalPnl / START_EQ) * 100), dd: maxDDPct, pf, wr: (wins.length / trades.length * 100), trades: trades.length });

    } // end for each START_EQ

    // ── COMPARISON TABLE ──
    console.log('\n\n╔══════════════════════════════════════════════════════════╗');
    console.log('║            CAPITAL COMPARISON SUMMARY                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log('Capital'.padEnd(12), 'Final'.padEnd(12), 'Return'.padEnd(12), 'DD%'.padEnd(10), 'PF'.padEnd(8), 'WR'.padEnd(8), 'Trades');
    console.log('─'.repeat(70));
    results.forEach(r => {
        console.log(
            `$${r.capital}`.padEnd(12),
            `$${r.final.toFixed(2)}`.padEnd(12),
            `${r.return.toFixed(2)}%`.padEnd(12),
            `${r.dd.toFixed(1)}%`.padEnd(10),
            `${r.pf === Infinity ? '∞' : r.pf.toFixed(2)}`.padEnd(8),
            `${r.wr.toFixed(1)}%`.padEnd(8),
            r.trades
        );
    });
}

runBacktest30m().catch(console.error);
