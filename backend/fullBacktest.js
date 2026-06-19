// Full V4-Plus Backtest — detailed output
const fs = require('fs');

async function runFullBacktest() {
    Object.keys(require.cache).forEach(key => {
        if (key.includes('unifiedStrategy') || key.includes('tradingBot')) {
            delete require.cache[key];
        }
    });
    
    process.env.CONFLUENCE_THRESHOLD = '5.5';
    process.env.MAX_SL_DISTANCE = '15';
    process.env.TP1_CLOSE_PERCENT = '50';
    
    const TradingBot = require('./tradingBot');
    const bot = new TradingBot(null);
    
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║     V4-PLUS (VOF) FULL BACKTEST + DD RISK MGMT        ║');
    console.log('║  90 Days | $50 Start | 0.01 Min Lots | Cooldown+DynSiz║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    
    const result = await bot.runBacktest(90, 'default');
    const { trades: rawTrades } = result;

    // ═══════════════════════════════════════════════════════════════════
    // Post-trade risk management: Progressive Position Sizing
    // ═══════════════════════════════════════════════════════════════════
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
        const adjustedTrade = { ...t, pnl: adjustedPnl, sizeMultiplier };
        trades.push(adjustedTrade);

        equity += adjustedPnl;
        if (equity > peak) peak = equity;
    }

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
    
    // equity already tracked above in risk management loop; reset for display
    equity = 50;
    const equityCurve = [50];
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
    
    // Max drawdown
    let maxDD = 0, maxDDPct = 0;
    peak = 50;
    equityCurve.forEach(eq => {
        if (eq > peak) peak = eq;
        const dd = peak - eq;
        const ddPct = (dd / peak) * 100;
        if (ddPct > maxDDPct) { maxDD = dd; maxDDPct = ddPct; }
    });
    
    // Consecutive streaks
    let maxConsecWin = 0, maxConsecLoss = 0, curWin = 0, curLoss = 0;
    trades.forEach(t => {
        if (t.pnl > 0) { curWin++; curLoss = 0; maxConsecWin = Math.max(maxConsecWin, curWin); }
        else { curLoss++; curWin = 0; maxConsecLoss = Math.max(maxConsecLoss, curLoss); }
    });
    
    // Exit reason breakdown
    const exitReasons = {};
    trades.forEach(t => {
        const r = t.exitReason || 'Unknown';
        if (!exitReasons[r]) exitReasons[r] = { count: 0, pnl: 0 };
        exitReasons[r].count++;
        exitReasons[r].pnl += t.pnl;
    });
    
    // Regime breakdown
    const regimeStats = {};
    trades.forEach(t => {
        const r = t.regime || 'unknown';
        if (!regimeStats[r]) regimeStats[r] = { count: 0, wins: 0, pnl: 0 };
        regimeStats[r].count++;
        if (t.pnl > 0) regimeStats[r].wins++;
        regimeStats[r].pnl += t.pnl;
    });
    
    // Action breakdown
    const actionStats = {};
    trades.forEach(t => {
        const a = t.action || 'unknown';
        if (!actionStats[a]) actionStats[a] = { count: 0, wins: 0, pnl: 0 };
        actionStats[a].count++;
        if (t.pnl > 0) actionStats[a].wins++;
        actionStats[a].pnl += t.pnl;
    });
    
    console.log('\n\n═══ PERFORMANCE STATISTICS ═══\n');
    console.log(`Starting Balance:     $50.00`);
    console.log(`Final Balance:        $${equity.toFixed(2)}`);
    console.log(`Total PnL:            ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`Total Return:         ${((totalPnl / 50) * 100).toFixed(2)}%`);
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
        const wr = (data.count / trades.length * 100).toFixed(0);
        const pnl = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        console.log(reason.padEnd(25), String(data.count).padEnd(8), (wr + '%').padEnd(8), pnl);
    });
    
    console.log('\n\n═══ REGIME BREAKDOWN ═══\n');
    console.log('Regime'.padEnd(15), 'Trades'.padEnd(10), 'Win%'.padEnd(10), 'Total PnL');
    console.log('─'.repeat(50));
    Object.entries(regimeStats).sort((a,b) => b[1].count - a[1].count).forEach(([regime, data]) => {
        const wr = (data.wins / data.count * 100).toFixed(1);
        const pnl = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        console.log(regime.padEnd(15), String(data.count).padEnd(10), (wr + '%').padEnd(10), pnl);
    });
    
    console.log('\n\n═══ ACTION BREAKDOWN ═══\n');
    console.log('Action'.padEnd(10), 'Trades'.padEnd(10), 'Win%'.padEnd(10), 'Total PnL');
    console.log('─'.repeat(45));
    Object.entries(actionStats).sort((a,b) => b[1].count - a[1].count).forEach(([action, data]) => {
        const wr = (data.wins / data.count * 100).toFixed(1);
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
        const marker = eq >= 50 ? '▲' : '▼';
        if (i % 5 === 0 || i === equityCurve.length - 1) {
            console.log(`$${eq.toFixed(0).padStart(6)} │${bar} ${marker}`);
        }
    });
    console.log(`       └${'─'.repeat(chartWidth)}`);
    console.log(`        $${minEq.toFixed(0)}${' '.repeat(chartWidth - String(minEq.toFixed(0)).length - String(maxEq.toFixed(0)).length)}$${maxEq.toFixed(0)}`);
    
    // Save full report
    const report = {
        timestamp: new Date().toISOString(),
        config: { startingBalance: 50, minLots: 0.01, threshold: 6.5, days: 90 },
        statistics: {
            finalBalance: equity,
            totalPnl: totalPnl,
            totalReturn: ((totalPnl / 50) * 100).toFixed(2) + '%',
            maxDrawdown: maxDD,
            maxDrawdownPct: maxDDPct.toFixed(2) + '%',
            profitFactor: pf === Infinity ? 'Infinity' : pf.toFixed(2),
            winRate: (wins.length / trades.length * 100).toFixed(1) + '%',
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
    
    fs.writeFileSync('v4plus_full_backtest_report.json', JSON.stringify(report, null, 2));
    console.log('\n✓ Full report saved to v4plus_full_backtest_report.json');
}

runFullBacktest().catch(console.error);
