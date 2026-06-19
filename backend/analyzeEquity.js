/**
 * analyzeEquity.js — V4-Plus Backtest Equity & Trade Analysis
 *
 * Runs the UnifiedStrategyV4Plus (V4-Plus with VOF) backtest on cached XAU/USD
 * data and produces detailed analytics:
 *   a. Equity curve
 *   b. Trade distribution by direction (BUY vs SELL, win rates)
 *   c. Trade distribution by regime (trending vs ranging, win rates)
 *   d. SL vs TP proximity analysis (losing trades)
 *   e. Trade duration (in candles)
 *   f. Losing streaks
 *   g. Average bars held (winning vs losing)
 *   h. Biggest single loss
 *   i. Trailing stop analysis (trailing SL vs hard SL vs TP)
 */

const fs = require('fs');
const path = require('path');

// ── Imports ──────────────────────────────────────────────────────────────
const UnifiedStrategyV4Plus = require('./unifiedStrategyV3');
const TradingBot = require('./tradingBot');

// ── Helpers ──────────────────────────────────────────────────────────────

function printHeader(title) {
    console.log('\n' + '═'.repeat(70));
    console.log(`  ${title}`);
    console.log('═'.repeat(70));
}

function printTable(headers, rows, colWidths) {
    if (!colWidths) {
        colWidths = headers.map((h, i) => {
            const maxData = rows.reduce((m, r) => Math.max(m, String(r[i]).length), 0);
            return Math.max(h.length, maxData) + 2;
        });
    }
    const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('');
    const separator = colWidths.map(w => '─'.repeat(w)).join('');
    console.log(headerLine);
    console.log(separator);
    for (const row of rows) {
        console.log(row.map((c, i) => String(c).padEnd(colWidths[i])).join(''));
    }
}

function fmt(n, decimals = 2) {
    if (n == null || isNaN(n)) return 'N/A';
    return Number(n).toFixed(decimals);
}

function fmtPct(n) {
    if (n == null || isNaN(n)) return 'N/A';
    return (n * 100).toFixed(1) + '%';
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║     V4-Plus (VOF) Backtest — Equity Curve & Trade Analysis         ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    // ── Load cached data (same pattern as compareV4Plus.js) ──────────
    const cacheFile360 = path.join(__dirname, 'xau_backtest_cache_2026-06-18_360.json');
    const cacheFile15  = path.join(__dirname, 'xau_backtest_cache_2026-06-18_15.json');

    console.log(`\nLoading cached data...`);
    console.log(`  6H cache:  ${cacheFile360}`);
    console.log(`  15m cache: ${cacheFile15}`);

    if (!fs.existsSync(cacheFile360)) {
        console.error('ERROR: 6H cache file not found. Run a backtest first to generate it.');
        process.exit(1);
    }

    // Read the cached candle data and convert to raw Bybit format for clientCandles
    const cached6h = JSON.parse(fs.readFileSync(cacheFile360, 'utf8'));
    console.log(`  Loaded ${cached6h.length} cached 6H candles`);

    // Convert parsed cache back to raw Bybit array format:
    //   [[timestamp, open, high, low, close, volume, turnover], ...]
    const clientCandles = cached6h.map(c => [
        new Date(c.timestamp).getTime().toString(),
        String(c.open),
        String(c.high),
        String(c.low),
        String(c.close),
        String(c.volume || 0),
        '0'  // turnover not in cache
    ]);

    // Also keep parsed data for SL-vs-TP analysis
    const parsedCandles = cached6h.map(c => ({
        ...c,
        timestamp: new Date(c.timestamp)
    }));

    // ── Configure strategy (V4-Plus with confluence threshold 6.5) ───
    process.env.CONFLUENCE_THRESHOLD = '6.5';
    console.log(`\nStrategy: UnifiedStrategyV4Plus (V4-Plus with VOF)`);
    console.log(`Confluence threshold: 6.5`);
    console.log(`Instantiated: new UnifiedStrategyV4Plus({ confluenceThreshold: 6.5 })`);

    // ── Run backtest via TradingBot ──────────────────────────────────
    console.log(`\nRunning backtest via tradingBot.runBacktest(candles, strategy)...`);
    const bot = new TradingBot(null);
    const result = await bot.runBacktest(90, 'default', clientCandles);

    const trades = result.trades || [];
    if (trades.length === 0) {
        console.error('\nNo trades generated. Cannot analyze.');
        process.exit(1);
    }

    console.log(`\nBacktest complete: ${trades.length} trades returned`);
    console.log(`  Data source: ${result.dataInfo?.source || 'unknown'}`);
    console.log(`  Date range:  ${result.dataInfo?.dateRange || 'unknown'}`);
    console.log(`  Candles:     ${result.dataInfo?.candleCount || 'unknown'}`);

    // ═══════════════════════════════════════════════════════════════════
    // a. EQUITY CURVE
    // ═══════════════════════════════════════════════════════════════════
    printHeader('A. EQUITY CURVE — Running Balance After Each Trade');

    let equity = 50; // initial equity matches backtest
    const equityCurve = [{ trade: 0, equity: 50, pnl: 0 }];
    const equityRows = [];

    for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        const pnl = t.pnl;
        equity += pnl;
        equityCurve.push({ trade: i + 1, equity, pnl });

        equityRows.push([
            `#${t.id || i + 1}`,
            t.action,
            fmt(t.entryPrice, 2),
            fmt(t.exitPrice, 2),
            (pnl >= 0 ? '+' : '') + fmt(pnl, 2),
            fmt(equity, 2),
            t.exitReason || 'N/A'
        ]);
    }

    printTable(
        ['Trade', 'Side', 'Entry', 'Exit', 'P&L ($)', 'Equity ($)', 'Exit Reason'],
        equityRows
    );

    // Equity curve sparkline (ASCII)
    console.log('\n  Equity curve shape:');
    const minEq = Math.min(...equityCurve.map(e => e.equity));
    const maxEq = Math.max(...equityCurve.map(e => e.equity));
    const range = maxEq - minEq || 1;
    const barWidth = 40;
    for (const pt of equityCurve) {
        const normalized = (pt.equity - minEq) / range;
        const barLen = Math.round(normalized * barWidth);
        const bar = '█'.repeat(barLen) + '░'.repeat(barWidth - barLen);
        const marker = pt.pnl < 0 ? '▼' : pt.pnl > 0 ? '▲' : '─';
        console.log(`  ${String(pt.trade).padStart(3)} │${bar}│ ${fmt(pt.equity, 2)} ${marker}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // b. TRADE DISTRIBUTION BY DIRECTION
    // ═══════════════════════════════════════════════════════════════════
    printHeader('B. TRADE DISTRIBUTION BY DIRECTION (BUY vs SELL)');

    const buys  = trades.filter(t => t.action === 'BUY');
    const sells = trades.filter(t => t.action === 'SELL');
    const buyWins  = buys.filter(t => t.pnl > 0);
    const buyLosses  = buys.filter(t => t.pnl <= 0);
    const sellWins = sells.filter(t => t.pnl > 0);
    const sellLosses = sells.filter(t => t.pnl <= 0);

    const buyPnlTotal  = buys.reduce((s, t) => s + t.pnl, 0);
    const sellPnlTotal = sells.reduce((s, t) => s + t.pnl, 0);

    printTable(
        ['Metric', 'BUY', 'SELL', 'Total'],
        [
            ['Total Trades',     buys.length,  sells.length,  trades.length],
            ['Wins',             buyWins.length, sellWins.length, buyWins.length + sellWins.length],
            ['Losses',           buyLosses.length, sellLosses.length, buyLosses.length + sellLosses.length],
            ['Win Rate',         buys.length ? fmtPct(buyWins.length / buys.length) : 'N/A',
                                 sells.length ? fmtPct(sellWins.length / sells.length) : 'N/A',
                                 fmtPct(trades.filter(t => t.pnl > 0).length / trades.length)],
            ['Total P&L ($)',    fmt(buyPnlTotal), fmt(sellPnlTotal), fmt(buyPnlTotal + sellPnlTotal)],
            ['Avg P&L ($)',      buys.length ? fmt(buyPnlTotal / buys.length) : 'N/A',
                                 sells.length ? fmt(sellPnlTotal / sells.length) : 'N/A',
                                 fmt((buyPnlTotal + sellPnlTotal) / trades.length)],
            ['Avg Win ($)',      buyWins.length ? fmt(buyWins.reduce((s, t) => s + t.pnl, 0) / buyWins.length) : 'N/A',
                                 sellWins.length ? fmt(sellWins.reduce((s, t) => s + t.pnl, 0) / sellWins.length) : 'N/A',
                                 fmt(trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) /
                                     Math.max(1, trades.filter(t => t.pnl > 0).length))],
            ['Avg Loss ($)',     buyLosses.length ? fmt(buyLosses.reduce((s, t) => s + t.pnl, 0) / buyLosses.length) : 'N/A',
                                 sellLosses.length ? fmt(sellLosses.reduce((s, t) => s + t.pnl, 0) / sellLosses.length) : 'N/A',
                                 fmt(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) /
                                     Math.max(1, trades.filter(t => t.pnl <= 0).length))],
        ]
    );

    // ═══════════════════════════════════════════════════════════════════
    // c. TRADE DISTRIBUTION BY REGIME
    // ═══════════════════════════════════════════════════════════════════
    printHeader('C. TRADE DISTRIBUTION BY REGIME');

    console.log('  (Regime counts from signal generation — from backtest result)\n');

    const regimeCounts = result.regimeCounts || {};
    printTable(
        ['Regime', 'Signal Count'],
        Object.entries(regimeCounts).map(([r, c]) => [r, c])
    );

    // Regime-per-trade analysis: re-run regime detection on each trade's entry window
    console.log('\n  Per-trade regime classification (re-analyzed from entry candle data):');

    const strategy = new UnifiedStrategyV4Plus({ confluenceThreshold: 6.5 });
    const regimeTradeMap = {};  // regime -> { trades: [], wins: 0, losses: 0, totalPnl: 0 }

    for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        // Find entry candle index in parsed data
        const entryTs = new Date(t.entryTimestamp).getTime();
        let entryIdx = parsedCandles.findIndex(c => c.timestamp.getTime() >= entryTs);
        if (entryIdx < 0) entryIdx = parsedCandles.length - 1;

        // Need at least 50 candles for regime detection
        if (entryIdx < 50) {
            const regime = 'unknown';
            if (!regimeTradeMap[regime]) regimeTradeMap[regime] = { count: 0, wins: 0, totalPnl: 0 };
            regimeTradeMap[regime].count++;
            if (t.pnl > 0) regimeTradeMap[regime].wins++;
            regimeTradeMap[regime].totalPnl += t.pnl;
            continue;
        }

        const window = parsedCandles.slice(entryIdx - 49, entryIdx + 1);
        const regimeInfo = strategy.detectRegime(window);
        const regime = regimeInfo.regime || 'unknown';

        if (!regimeTradeMap[regime]) regimeTradeMap[regime] = { count: 0, wins: 0, totalPnl: 0 };
        regimeTradeMap[regime].count++;
        if (t.pnl > 0) regimeTradeMap[regime].wins++;
        regimeTradeMap[regime].totalPnl += t.pnl;
    }

    const regimeRows = [];
    for (const [regime, data] of Object.entries(regimeTradeMap)) {
        regimeRows.push([
            regime,
            data.count,
            data.wins,
            data.count - data.wins,
            data.count > 0 ? fmtPct(data.wins / data.count) : 'N/A',
            fmt(data.totalPnl)
        ]);
    }
    printTable(
        ['Regime', 'Trades', 'Wins', 'Losses', 'Win Rate', 'Total P&L ($)'],
        regimeRows
    );

    // ═══════════════════════════════════════════════════════════════════
    // d. SL vs TP PROXIMITY ANALYSIS (Losing Trades)
    // ═══════════════════════════════════════════════════════════════════
    printHeader('D. SL vs TP PROXIMITY — How Close Did Price Get to TP Before SL?');

    const losingTrades = trades.filter(t => t.pnl <= 0);
    console.log(`  Analyzing ${losingTrades.length} losing trades...\n`);

    const slTpRows = [];
    for (const t of losingTrades) {
        const entryTs = new Date(t.entryTimestamp).getTime();
        const exitTs  = new Date(t.exitTimestamp).getTime();

        // Find the candles during this trade
        const tradeCandles = parsedCandles.filter(c => {
            const ts = c.timestamp.getTime();
            return ts >= entryTs && ts <= exitTs;
        });

        if (tradeCandles.length === 0) {
            slTpRows.push([`#${t.id}`, t.action, fmt(t.entryPrice), fmt(t.exitPrice), 'N/A', 'N/A', 'N/A', 'N/A']);
            continue;
        }

        let closestToTp = 0;
        let maxAdverseFavorable = 0;
        for (const c of tradeCandles) {
            if (t.action === 'BUY') {
                // How close high got to TP1
                const distToTp = Math.abs(t.tp1 - c.high);
                const pctOfSlToTp = Math.abs(t.tp1 - t.entryPrice);
                closestToTp = Math.max(closestToTp, ((c.high - t.entryPrice) / (pctOfSlToTp || 1)) * 100);
                // Adverse excursion (how close low got to SL)
                const distToSl = Math.abs(c.low - t.sl);
                maxAdverseFavorable = Math.max(maxAdverseFavorable,
                    ((t.entryPrice - c.low) / (Math.abs(t.entryPrice - t.sl) || 1)) * 100);
            } else {
                const distToTp = Math.abs(c.low - t.tp1);
                const pctOfSlToTp = Math.abs(t.entryPrice - t.tp1);
                closestToTp = Math.max(closestToTp, ((t.entryPrice - c.low) / (pctOfSlToTp || 1)) * 100);
                const distToSl = Math.abs(c.high - t.sl);
                maxAdverseFavorable = Math.max(maxAdverseFavorable,
                    ((c.high - t.entryPrice) / (Math.abs(t.sl - t.entryPrice) || 1)) * 100);
            }
        }

        const exitReason = t.exitReason || 'Unknown';
        slTpRows.push([
            `#${t.id}`,
            t.action,
            fmt(t.entryPrice),
            fmt(t.tp1),
            fmt(t.sl),
            fmt(Math.min(closestToTp, 100), 0) + '%',
            fmt(Math.min(maxAdverseFavorable, 100), 0) + '%',
            exitReason.substring(0, 25)
        ]);
    }

    printTable(
        ['Trade', 'Side', 'Entry', 'TP1', 'SL', 'Max % to TP', 'Max % to SL', 'Exit Reason'],
        slTpRows,
        [6, 5, 10, 10, 10, 12, 12, 25]
    );

    // Summary
    if (losingTrades.length > 0) {
        const avgCloseToTp = losingTrades.reduce((s, t) => {
            const entryTs = new Date(t.entryTimestamp).getTime();
            const exitTs  = new Date(t.exitTimestamp).getTime();
            const tradeCandles = parsedCandles.filter(c => c.timestamp.getTime() >= entryTs && c.timestamp.getTime() <= exitTs);
            let closest = 0;
            for (const c of tradeCandles) {
                if (t.action === 'BUY') {
                    const range = Math.abs(t.tp1 - t.entryPrice) || 1;
                    closest = Math.max(closest, ((c.high - t.entryPrice) / range) * 100);
                } else {
                    const range = Math.abs(t.entryPrice - t.tp1) || 1;
                    closest = Math.max(closest, ((t.entryPrice - c.low) / range) * 100);
                }
            }
            return s + Math.min(closest, 100);
        }, 0) / losingTrades.length;

        console.log(`\n  Summary: Losing trades reached an average of ${fmt(avgCloseToTp, 0)}% of the way to TP1`);
        console.log(`  before being stopped out.`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // e. TRADE DURATION (in candles)
    // ═══════════════════════════════════════════════════════════════════
    printHeader('E. TRADE DURATION (in 6H candles)');

    const durations = trades.map(t => {
        const entryTs = new Date(t.entryTimestamp).getTime();
        const exitTs  = new Date(t.exitTimestamp).getTime();
        const candlesHeld = Math.round((exitTs - entryTs) / (6 * 3600000));
        return { ...t, candlesHeld };
    });

    const durRows = durations.map(t => [
        `#${t.id}`,
        t.action,
        fmt(t.entryPrice),
        t.candlesHeld,
        t.candlesHeld * 6 + 'h',
        t.pnl >= 0 ? 'WIN' : 'LOSS',
        (t.pnl >= 0 ? '+' : '') + fmt(t.pnl),
        t.exitReason || 'N/A'
    ]);

    printTable(
        ['Trade', 'Side', 'Entry', 'Candles', 'Duration', 'Result', 'P&L ($)', 'Exit Reason'],
        durRows
    );

    const avgDuration = durations.reduce((s, t) => s + t.candlesHeld, 0) / durations.length;
    const minDur = Math.min(...durations.map(t => t.candlesHeld));
    const maxDur = Math.max(...durations.map(t => t.candlesHeld));
    const medDur = durations.map(t => t.candlesHeld).sort((a, b) => a - b)[Math.floor(durations.length / 2)];

    console.log(`\n  Duration stats:`);
    console.log(`    Average: ${fmt(avgDuration, 1)} candles (${fmt(avgDuration * 6, 0)} hours)`);
    console.log(`    Median:  ${medDur} candles (${medDur * 6}h)`);
    console.log(`    Min:     ${minDur} candles (${minDur * 6}h)`);
    console.log(`    Max:     ${maxDur} candles (${maxDur * 6}h)`);

    // ═══════════════════════════════════════════════════════════════════
    // f. LOSING STREAKS
    // ═══════════════════════════════════════════════════════════════════
    printHeader('F. LOSING STREAKS');

    let maxLosingStreak = 0;
    let currentStreak = 0;
    let maxWinningStreak = 0;
    let currentWinStreak = 0;
    const streaks = [];
    let streakStart = 0;

    for (let i = 0; i < trades.length; i++) {
        const isLoss = trades[i].pnl <= 0;
        if (isLoss) {
            currentStreak++;
            currentWinStreak = 0;
            if (currentStreak > maxLosingStreak) {
                maxLosingStreak = currentStreak;
                streakStart = i - currentStreak + 1;
            }
        } else {
            currentWinStreak++;
            currentStreak = 0;
            if (currentWinStreak > maxWinningStreak) {
                maxWinningStreak = currentWinStreak;
            }
        }
    }

    console.log(`  Max losing streak:  ${maxLosingStreak} consecutive loss(es)`);
    console.log(`  Max winning streak: ${maxWinningStreak} consecutive win(s)`);

    // Show all streaks
    currentStreak = 0;
    currentWinStreak = 0;
    const allStreaks = [];
    let streakType = null;
    let streakCount = 0;
    let streakStartIdx = 0;

    for (let i = 0; i < trades.length; i++) {
        const isLoss = trades[i].pnl <= 0;
        const type = isLoss ? 'LOSS' : 'WIN';
        if (type !== streakType) {
            if (streakType !== null) {
                allStreaks.push({ type: streakType, count: streakCount, start: streakStartIdx, end: i - 1 });
            }
            streakType = type;
            streakCount = 1;
            streakStartIdx = i;
        } else {
            streakCount++;
        }
    }
    if (streakType !== null) {
        allStreaks.push({ type: streakType, count: streakCount, start: streakStartIdx, end: trades.length - 1 });
    }

    console.log('\n  Streak timeline:');
    for (const s of allStreaks) {
        const symbol = s.type === 'WIN' ? '🟢' : '🔴';
        const bar = '█'.repeat(s.count) + ` (${s.count})`;
        console.log(`    ${symbol} ${s.type.padEnd(5)} #${s.start + 1}–#${s.end + 1}: ${bar}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // g. AVERAGE BARS HELD — Winning vs Losing
    // ═══════════════════════════════════════════════════════════════════
    printHeader('G. AVERAGE BARS HELD — Winning vs Losing Trades');

    const winDurations = durations.filter(t => t.pnl > 0);
    const lossDurations = durations.filter(t => t.pnl <= 0);

    const avgWinBars = winDurations.length
        ? winDurations.reduce((s, t) => s + t.candlesHeld, 0) / winDurations.length : 0;
    const avgLossBars = lossDurations.length
        ? lossDurations.reduce((s, t) => s + t.candlesHeld, 0) / lossDurations.length : 0;

    const medianWinBars = winDurations.length
        ? winDurations.map(t => t.candlesHeld).sort((a, b) => a - b)[Math.floor(winDurations.length / 2)] : 0;
    const medianLossBars = lossDurations.length
        ? lossDurations.map(t => t.candlesHeld).sort((a, b) => a - b)[Math.floor(lossDurations.length / 2)] : 0;

    printTable(
        ['Metric', 'Winning Trades', 'Losing Trades'],
        [
            ['Count',            winDurations.length, lossDurations.length],
            ['Avg Candles Held', fmt(avgWinBars, 1),  fmt(avgLossBars, 1)],
            ['Avg Hours Held',   fmt(avgWinBars * 6, 0), fmt(avgLossBars * 6, 0)],
            ['Median Candles',   medianWinBars, medianLossBars],
            ['Min Candles',      winDurations.length ? Math.min(...winDurations.map(t => t.candlesHeld)) : 'N/A',
                                 lossDurations.length ? Math.min(...lossDurations.map(t => t.candlesHeld)) : 'N/A'],
            ['Max Candles',      winDurations.length ? Math.max(...winDurations.map(t => t.candlesHeld)) : 'N/A',
                                 lossDurations.length ? Math.max(...lossDurations.map(t => t.candlesHeld)) : 'N/A'],
        ]
    );

    console.log(`\n  Insight: Winning trades avg ${fmt(avgWinBars, 1)} candles vs losing trades avg ${fmt(avgLossBars, 1)} candles`);
    if (avgWinBars > avgLossBars) {
        console.log('  → Winners tend to run longer than losers (good — winners let profits run).');
    } else if (avgWinBars < avgLossBars) {
        console.log('  → Losers tend to run longer than winners (warning — cut losses too slowly?).');
    } else {
        console.log('  → Winners and losers have similar duration.');
    }

    // ═══════════════════════════════════════════════════════════════════
    // h. BIGGEST SINGLE LOSS
    // ═══════════════════════════════════════════════════════════════════
    printHeader('H. BIGGEST SINGLE LOSS — What Happened?');

    const sortedLosses = [...trades].filter(t => t.pnl <= 0).sort((a, b) => a.pnl - b.pnl);
    if (sortedLosses.length > 0) {
        const worst = sortedLosses[0];
        const entryTs = new Date(worst.entryTimestamp).getTime();
        const exitTs  = new Date(worst.exitTimestamp).getTime();
        const entryIdx = parsedCandles.findIndex(c => c.timestamp.getTime() >= entryTs);
        const slDistance = Math.abs(worst.entryPrice - worst.sl);

        let regimeAtEntry = 'unknown';
        if (entryIdx >= 50) {
            const window = parsedCandles.slice(entryIdx - 49, entryIdx + 1);
            const regimeInfo = strategy.detectRegime(window);
            regimeAtEntry = regimeInfo.regime || 'unknown';
        }

        const barsHeld = Math.round((exitTs - entryTs) / (6 * 3600000));

        console.log(`  Trade #${worst.id}`);
        console.log(`  ├─ Side:            ${worst.action}`);
        console.log(`  ├─ Entry Price:     ${fmt(worst.entryPrice)}`);
        console.log(`  ├─ Exit Price:      ${fmt(worst.exitPrice)}`);
        console.log(`  ├─ Entry Score:     ${fmt(worst.score, 1)}`);
        console.log(`  ├─ SL:              ${fmt(worst.sl)}`);
        console.log(`  ├─ SL Distance:     ${fmt(slDistance)} ($${fmt(slDistance * 100 * (worst.quantity || 0.01), 2)} risk)`);
        console.log(`  ├─ TP1:             ${fmt(worst.tp1)}`);
        console.log(`  ├─ TP2:             ${fmt(worst.tp2)}`);
        console.log(`  ├─ Exit Reason:     ${worst.exitReason || 'N/A'}`);
        console.log(`  ├─ P&L:             $${fmt(worst.pnl)}`);
        console.log(`  ├─ Quantity:        ${fmt(worst.quantity, 2)} lots`);
        console.log(`  ├─ Regime at Entry: ${regimeAtEntry}`);
        console.log(`  ├─ Duration:        ${barsHeld} candles (${barsHeld * 6}h)`);
        console.log(`  ├─ TP1 Hit:         ${worst.tp1Hit ? 'Yes (partial close)' : 'No'}`);
        console.log(`  └─ Confluence:      ${(worst.confluence || '').substring(0, 80)}`);

        if (sortedLosses.length > 1) {
            console.log('\n  Top 3 biggest losses:');
            for (let i = 0; i < Math.min(3, sortedLosses.length); i++) {
                const t = sortedLosses[i];
                console.log(`    ${i + 1}. Trade #${t.id}: ${t.action} — $${fmt(t.pnl)} (${t.exitReason}) score=${fmt(t.score, 1)}`);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // i. TRAILING STOP ANALYSIS
    // ═══════════════════════════════════════════════════════════════════
    printHeader('I. TRAILING STOP ANALYSIS — Exit Type Breakdown');

    const exitTypeMap = {};
    for (const t of trades) {
        const reason = t.exitReason || 'Unknown';
        if (!exitTypeMap[reason]) exitTypeMap[reason] = { count: 0, wins: 0, totalPnl: 0, pnlList: [] };
        exitTypeMap[reason].count++;
        if (t.pnl > 0) exitTypeMap[reason].wins++;
        exitTypeMap[reason].totalPnl += t.pnl;
        exitTypeMap[reason].pnlList.push(t.pnl);
    }

    // Categorize exit types
    const trailingSL = trades.filter(t => (t.exitReason || '').includes('Trailing'));
    const hardSL     = trades.filter(t => t.exitReason === 'Stop Loss');
    const tp1Partial = trades.filter(t => (t.exitReason || '').includes('TP1'));
    const tp2        = trades.filter(t => (t.exitReason || '').includes('Take Profit 2'));
    const backtestEnd = trades.filter(t => t.exitReason === 'Backtest End');

    const exitRows = [];
    for (const [reason, data] of Object.entries(exitTypeMap).sort((a, b) => b[1].count - a[1].count)) {
        exitRows.push([
            reason,
            data.count,
            fmtPct(data.count / trades.length),
            data.wins,
            data.count - data.wins,
            data.count > 0 ? fmtPct(data.wins / data.count) : 'N/A',
            fmt(data.totalPnl)
        ]);
    }
    printTable(
        ['Exit Reason', 'Count', '% of Total', 'Wins', 'Losses', 'Win Rate', 'Total P&L ($)'],
        exitRows
    );

    console.log('\n  Exit category summary:');
    console.log(`    Trailing SL (BE+):  ${trailingSL.length} trades — ${trailingSL.filter(t => t.pnl > 0).length} wins, ${trailingSL.filter(t => t.pnl <= 0).length} losses`);
    console.log(`    Hard Stop Loss:     ${hardSL.length} trades — ${hardSL.filter(t => t.pnl > 0).length} wins, ${hardSL.filter(t => t.pnl <= 0).length} losses`);
    console.log(`    TP1 Partial:        ${tp1Partial.length} trades — ${tp1Partial.filter(t => t.pnl > 0).length} wins, ${tp1Partial.filter(t => t.pnl <= 0).length} losses`);
    console.log(`    Take Profit 2:      ${tp2.length} trades — ${tp2.filter(t => t.pnl > 0).length} wins, ${tp2.filter(t => t.pnl <= 0).length} losses`);
    if (backtestEnd.length > 0) {
        console.log(`    Backtest End:       ${backtestEnd.length} trades (forced close)`);
    }

    // Trailing stop effectiveness
    if (trailingSL.length > 0) {
        const trailingWins = trailingSL.filter(t => t.pnl > 0);
        console.log(`\n  Trailing stop effectiveness:`);
        console.log(`    ${trailingWins.length}/${trailingSL.length} trailing SL exits were profitable`);
        console.log(`    Average trailing SL P&L: $${fmt(trailingSL.reduce((s, t) => s + t.pnl, 0) / trailingSL.length)}`);
    }

    if (hardSL.length > 0) {
        console.log(`\n  Hard stop loss analysis:`);
        const hardSLWins = hardSL.filter(t => t.pnl > 0);
        const hardSLLosses = hardSL.filter(t => t.pnl <= 0);
        console.log(`    ${hardSLWins.length}/${hardSL.length} hard SL exits were actually profitable (SL at breakeven+)`);
        console.log(`    Average hard SL loss: $${fmt(hardSLLosses.length ? hardSLLosses.reduce((s, t) => s + t.pnl, 0) / hardSLLosses.length : 0)}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // OVERALL SUMMARY
    // ═══════════════════════════════════════════════════════════════════
    printHeader('OVERALL BACKTEST SUMMARY');

    const allWins = trades.filter(t => t.pnl > 0);
    const allLosses = trades.filter(t => t.pnl <= 0);
    const totalProfit = allWins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = Math.abs(allLosses.reduce((s, t) => s + t.pnl, 0));

    console.log(`  Total Trades:         ${trades.length}`);
    console.log(`  Win/Loss:             ${allWins.length}W / ${allLosses.length}L`);
    console.log(`  Win Rate:             ${fmtPct(allWins.length / trades.length)}`);
    console.log(`  Profit Factor:        ${result.profitFactor != null ? fmt(result.profitFactor) : 'N/A'}`);
    console.log(`  Total P&L:            $${fmt(trades.reduce((s, t) => s + t.pnl, 0))}`);
    console.log(`  Total Return:         ${result.totalReturn != null ? fmtPct(result.totalReturn) : 'N/A'}`);
    console.log(`  Max Drawdown:         ${result.maxDrawdown != null ? fmtPct(result.maxDrawdown) : 'N/A'}`);
    console.log(`  Sharpe Ratio:         ${result.sharpeRatio != null ? fmt(result.sharpeRatio) : 'N/A'}`);
    console.log(`  Avg Win:              $${fmt(allWins.length ? totalProfit / allWins.length : 0)}`);
    console.log(`  Avg Loss:             $${fmt(allLosses.length ? -totalLoss / allLosses.length : 0)}`);
    console.log(`  Win/Loss Ratio:       ${allLosses.length > 0 && totalLoss > 0 ? fmt((totalProfit / allWins.length) / (totalLoss / allLosses.length)) : 'N/A'}`);
    console.log(`  Avg Score (wins):     ${fmt(allWins.length ? allWins.reduce((s, t) => s + (t.score || 0), 0) / allWins.length : 0, 1)}`);
    console.log(`  Avg Score (losses):   ${fmt(allLosses.length ? allLosses.reduce((s, t) => s + (t.score || 0), 0) / allLosses.length : 0, 1)}`);
    console.log(`  Broker Costs:         $${fmt(result.costs?.totalCosts || 0)}`);
    console.log(`    ├─ Spread:          $${fmt(result.costs?.totalSpreadCost || 0)}`);
    console.log(`    ├─ Slippage:        $${fmt(result.costs?.totalSlippageCost || 0)}`);
    console.log(`    └─ Commission:      $${fmt(result.costs?.totalCommission || 0)}`);

    console.log('\n' + '═'.repeat(70));
    console.log('  Analysis complete.');
    console.log('═'.repeat(70));
}

main().catch(err => {
    console.error('Analysis failed:', err);
    process.exit(1);
});
