// EUR/USD Backtest — 0.01 lots on $50
// Uses correct strategy API: analyze(priceData) → { signal, score, details }
// Custom exit function with EUR/USD contract size (100,000 units per standard lot)
const fs = require('fs');

async function runEurusdBacktest() {
    Object.keys(require.cache).forEach(key => {
        if (key.includes('unifiedStrategy') || key.includes('tradingBot')) {
            delete require.cache[key];
        }
    });

    process.env.CONFLUENCE_THRESHOLD = '6.5';

    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       EUR/USD BACKTEST — 0.01 Lots | $50 Start          ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Load EUR/USD data
    const eurusdData = JSON.parse(fs.readFileSync('eurusd_backtest_cache.json', 'utf8'));
    const allCandles = eurusdData.candles.map(c => ({
        ...c,
        timestamp: new Date(c.timestamp),
        price: c.close
    }));

    const candlesNeeded = 360;
    const historicalData = allCandles.slice(-candlesNeeded);

    console.log(`Loaded ${historicalData.length} EUR/USD 6H candles`);
    console.log(`Date range: ${historicalData[0].timestamp.toISOString().split('T')[0]} to ${historicalData[historicalData.length-1].timestamp.toISOString().split('T')[0]}`);
    console.log(`Price range: ${Math.min(...historicalData.map(c=>c.low)).toFixed(5)} — ${Math.max(...historicalData.map(c=>c.high)).toFixed(5)}\n`);

    // ATR for context
    const atrs = [];
    for (let i = 14; i < historicalData.length; i++) {
        let tr = 0;
        for (let j = i - 13; j <= i; j++) {
            const h = historicalData[j].high;
            const l = historicalData[j].low;
            const pc = historicalData[j-1].close;
            tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        atrs.push(tr / 14);
    }
    const avgAtr = atrs.reduce((a,b) => a+b, 0) / atrs.length;
    console.log(`Average ATR (14): ${avgAtr.toFixed(5)} (${(avgAtr * 10000).toFixed(1)} pips)`);
    console.log(`At 0.01 lots: 1 pip = $0.10, so ATR risk = $${(avgAtr * 10000 * 0.10).toFixed(2)}\n`);

    // ── EUR/USD specific constants ──
    const EURUSD_CONTRACT_SIZE = 100000; // 1 standard lot = 100k units
    const MIN_LOT = 0.01;

    // Initialize strategy
    const UnifiedStrategy = require('./unifiedStrategyV3');
    const strategy = new UnifiedStrategy();

    // ── Custom exit function for EUR/USD (overrides gold's CONTRACT_SIZE=100) ──
    function checkEurusdExit(activeTrade, currentCandle) {
        // Apply trailing stop via strategy
        strategy.applyTrailingStop(activeTrade, currentCandle);

        // Same-candle prevention
        const entryTs = activeTrade.timestamp ? new Date(activeTrade.timestamp).getTime() : 0;
        const candleTs = currentCandle.timestamp ? new Date(currentCandle.timestamp).getTime() : 0;
        if (entryTs === candleTs) return { closed: false };

        const CONTRACT_SIZE = EURUSD_CONTRACT_SIZE;
        const quantity = activeTrade.quantity;
        const positionSize = quantity * CONTRACT_SIZE;

        const calculatePnl = (price) => {
            return activeTrade.action === 'BUY'
                ? (price - activeTrade.entryPrice) * positionSize
                : (activeTrade.entryPrice - price) * positionSize;
        };

        const tp1Hit = activeTrade.tp1Hit || false;

        if (activeTrade.action === 'BUY') {
            // TP before SL (liberal fill)
            if (!tp1Hit && currentCandle.high >= activeTrade.tp1) {
                activeTrade.tp1Hit = true;
                activeTrade.sl = Math.max(activeTrade.sl, activeTrade.entryPrice); // move to BE
                return { closed: false, partial: true, exitPrice: activeTrade.tp1, exitReason: 'TP1 Partial' };
            }
            if (activeTrade.tp1Hit && activeTrade.tp2 && currentCandle.high >= activeTrade.tp2) {
                return { closed: true, exitPrice: activeTrade.tp2, exitReason: 'Take Profit 2', pnl: calculatePnl(activeTrade.tp2) };
            }
            if (currentCandle.low <= activeTrade.sl) {
                return { closed: true, exitPrice: activeTrade.sl, exitReason: activeTrade.sl >= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss', pnl: calculatePnl(activeTrade.sl) };
            }
        } else {
            // SELL trade
            if (!tp1Hit && currentCandle.low <= activeTrade.tp1) {
                activeTrade.tp1Hit = true;
                activeTrade.sl = Math.min(activeTrade.sl, activeTrade.entryPrice); // move to BE
                return { closed: false, partial: true, exitPrice: activeTrade.tp1, exitReason: 'TP1 Partial' };
            }
            if (activeTrade.tp1Hit && activeTrade.tp2 && currentCandle.low <= activeTrade.tp2) {
                return { closed: true, exitPrice: activeTrade.tp2, exitReason: 'Take Profit 2', pnl: calculatePnl(activeTrade.tp2) };
            }
            if (currentCandle.high >= activeTrade.sl) {
                return { closed: true, exitPrice: activeTrade.sl, exitReason: activeTrade.sl <= activeTrade.entryPrice ? 'Trailing SL (BE+)' : 'Stop Loss', pnl: calculatePnl(activeTrade.sl) };
            }
        }

        return { closed: false };
    }

    // ── Backtest loop ──
    let equity = 50;
    const trades = [];
    let activeTrade = null;
    let currentTradeDate = null;
    let dailyLossCount = 0;
    let signalsAnalyzed = 0;
    let signalsBlocked = 0;
    let signalBreakdown = { BUY: 0, SELL: 0, NEUTRAL: 0 };

    for (let i = 49; i < historicalData.length; i++) {
        const currentWindow = historicalData.slice(i - 49, i + 1);
        const currentCandle = historicalData[i];

        const candleDate = currentCandle.timestamp.toISOString().split('T')[0];
        if (currentTradeDate !== candleDate) {
            currentTradeDate = candleDate;
            dailyLossCount = 0;
        }

        // Check active trade exit
        if (activeTrade) {
            const exitResult = checkEurusdExit(activeTrade, currentCandle);
            if (exitResult.closed) {
                equity += exitResult.pnl;
                trades.push({
                    ...activeTrade,
                    exitPrice: exitResult.exitPrice,
                    exitReason: exitResult.exitReason,
                    pnl: exitResult.pnl,
                    exitTime: currentCandle.timestamp
                });
                activeTrade = null;

                if (exitResult.pnl < 0) {
                    dailyLossCount++;
                }
            }
        }

        // Check for new entry
        if (!activeTrade && isSessionOpen(currentCandle.timestamp) && dailyLossCount < 2) {
            try {
                const analysis = strategy.analyze(currentWindow);
                signalsAnalyzed++;

                if (analysis && analysis.signal !== 'NEUTRAL' && analysis.signal !== 'PENDING_BUY' && analysis.signal !== 'PENDING_SELL') {
                    signalBreakdown[analysis.signal] = (signalBreakdown[analysis.signal] || 0) + 1;
                    const rp = analysis.details?.riskCalculator;

                    if (rp && rp.stopLoss && rp.takeProfit) {
                        const signal = analysis.signal;
                        const sl = signal === 'BUY' ? rp.stopLoss.long : rp.stopLoss.short;
                        const tp1 = signal === 'BUY' ? rp.takeProfit.tp1Long : rp.takeProfit.tp1Short;
                        const tp2 = signal === 'BUY' ? rp.takeProfit.tp2Long : rp.takeProfit.tp2Short;

                        // Position sizing: 0.01 lots for EUR/USD
                        const quantity = MIN_LOT;
                        const entryPrice = currentCandle.close;

                        activeTrade = {
                            action: signal,
                            entryPrice: entryPrice,
                            timestamp: currentCandle.timestamp,
                            quantity: quantity,
                            initialQuantity: quantity,
                            remainingQuantity: quantity,
                            realizedPnl: 0,
                            tp1Hit: false,
                            sl: sl,
                            originalSl: sl,
                            tp1: tp1,
                            tp2: tp2,
                            atr: rp.atr,
                            score: analysis.score,
                            confluence: analysis.details?.confluenceScorer?.details || '',
                            regime: analysis.details?.regime?.regime || 'unknown',
                            status: 'OPEN'
                        };
                    }
                } else {
                    signalBreakdown[analysis?.signal || 'NEUTRAL'] = (signalBreakdown[analysis?.signal || 'NEUTRAL'] || 0) + 1;
                }
            } catch (e) {
                signalsBlocked++;
            }
        }
    }

    // Close any open trade at backtest end
    if (activeTrade) {
        const finalCandle = historicalData[historicalData.length - 1];
        const positionSize = activeTrade.quantity * EURUSD_CONTRACT_SIZE;
        const pnl = activeTrade.action === 'BUY'
            ? (finalCandle.close - activeTrade.entryPrice) * positionSize
            : (activeTrade.entryPrice - finalCandle.close) * positionSize;
        equity += pnl;
        activeTrade.pnl = pnl;
        activeTrade.exitPrice = finalCandle.close;
        activeTrade.exitReason = 'Backtest End';
        activeTrade.exitTime = finalCandle.timestamp;
        activeTrade.status = 'CLOSED';
        trades.push({ ...activeTrade });
    }

    // ── RESULTS ──
    console.log(`\nSignals analyzed: ${signalsAnalyzed} | Errors: ${signalsBlocked}`);
    console.log(`Signal breakdown: BUY=${signalBreakdown.BUY || 0} SELL=${signalBreakdown.SELL || 0} NEUTRAL=${signalBreakdown.NEUTRAL || 0}\n`);

    console.log('\n═══ TRADE-BY-TRADE LOG ═══\n');
    console.log(
        '#'.padEnd(4),
        'Date'.padEnd(12),
        'Action'.padEnd(6),
        'Entry'.padEnd(12),
        'Exit'.padEnd(12),
        'SL'.padEnd(12),
        'TP1'.padEnd(12),
        'TP2'.padEnd(12),
        'Exit Reason'.padEnd(22),
        'PnL'.padEnd(10),
        'Equity'
    );
    console.log('─'.repeat(110));

    let eq = 50;
    const equityCurve = [50];

    trades.forEach((t, i) => {
        eq += t.pnl;
        equityCurve.push(eq);

        const date = t.timestamp?.toISOString?.().split('T')[0] || (t.timestamp ? String(t.timestamp).split('T')[0] : 'N/A');
        const action = (t.action || 'N/A').padEnd(5);
        const entry = t.entryPrice?.toFixed(5) || 'N/A';
        const exit = t.exitPrice?.toFixed(5) || 'N/A';
        const sl = t.sl?.toFixed(5) || 'N/A';
        const tp1 = t.tp1?.toFixed(5) || 'N/A';
        const tp2 = t.tp2?.toFixed(5) || 'N/A';
        const exitReason = (t.exitReason || 'N/A').padEnd(22);
        const pnl = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
        const emoji = t.pnl >= 0 ? '✅' : '❌';

        console.log(
            `${String(i+1).padEnd(4)}`,
            `${date.padEnd(12)}`,
            `${action.padEnd(6)}`,
            `${entry}`.padEnd(12),
            `${exit}`.padEnd(12),
            `${sl}`.padEnd(12),
            `${tp1}`.padEnd(12),
            `${tp2}`.padEnd(12),
            `${exitReason}`,
            `${pnl}`.padEnd(10),
            `$${eq.toFixed(2)}`,
            emoji
        );
    });

    // ── STATS ──
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
    const avgWin = wins.length ? grossWins / wins.length : 0;
    const avgLoss = losses.length ? grossLosses / losses.length : 0;

    let peak = 50, maxDD = 0, maxDDPct = 0;
    equityCurve.forEach(e => {
        if (e > peak) peak = e;
        const dd = peak - e;
        const ddPct = (dd / peak) * 100;
        if (ddPct > maxDDPct) { maxDD = dd; maxDDPct = ddPct; }
    });

    // Exit reasons
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

    console.log('\n\n═══ PERFORMANCE STATISTICS ═══\n');
    console.log(`Starting Balance:     $50.00`);
    console.log(`Final Balance:        $${eq.toFixed(2)}`);
    console.log(`Total PnL:            ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
    console.log(`Total Return:         ${((totalPnl / 50) * 100).toFixed(2)}%`);
    console.log(`Max Drawdown:         $${maxDD.toFixed(2)} (${maxDDPct.toFixed(2)}%)`);
    console.log(`Profit Factor:        ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
    console.log(`Win Rate:             ${trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 0}% (${wins.length}W / ${losses.length}L)`);
    console.log(`Avg Win:              $${avgWin.toFixed(2)}`);
    console.log(`Avg Loss:             $${avgLoss.toFixed(2)}`);
    console.log(`Win/Loss Ratio:       ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}:1`);
    console.log(`Total Trades:         ${trades.length}`);
    console.log(`Trades/Day:           ${(trades.length / 90).toFixed(2)}`);

    console.log('\n\n═══ EXIT REASON BREAKDOWN ═══\n');
    console.log('Reason'.padEnd(25), 'Count'.padEnd(8), 'Total PnL');
    console.log('─'.repeat(45));
    Object.entries(exitReasons).sort((a,b) => b[1].count - a[1].count).forEach(([reason, data]) => {
        const pnl = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        console.log(reason.padEnd(25), String(data.count).padEnd(8), pnl);
    });

    console.log('\n\n═══ REGIME BREAKDOWN ═══\n');
    console.log('Regime'.padEnd(15), 'Count'.padEnd(8), 'Wins'.padEnd(8), 'WR'.padEnd(8), 'PnL');
    console.log('─'.repeat(50));
    Object.entries(regimeStats).sort((a,b) => b[1].count - a[1].count).forEach(([regime, data]) => {
        const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(1) : 0;
        const pnl = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
        console.log(regime.padEnd(15), String(data.count).padEnd(8), String(data.wins).padEnd(8), `${wr}%`.padEnd(8), pnl);
    });

    // Equity curve
    console.log('\n\n═══ EQUITY CURVE ═══\n');
    const minEq = Math.min(...equityCurve);
    const maxEq = Math.max(...equityCurve);
    const range = maxEq - minEq || 1;

    equityCurve.forEach((e, idx) => {
        const barLen = Math.round(((e - minEq) / range) * 50);
        const bar = '█'.repeat(Math.max(1, barLen));
        const marker = e >= 50 ? '▲' : '▼';
        if (idx % 3 === 0 || idx === equityCurve.length - 1) {
            console.log(`$${e.toFixed(2).padStart(7)} │${bar} ${marker}`);
        }
    });
}

function isSessionOpen(timestamp) {
    const h = timestamp.getUTCHours();
    // Forex sessions: London (7-16 UTC), New York (12-21 UTC)
    return (h >= 1 && h < 21);
}

runEurusdBacktest().catch(console.error);
