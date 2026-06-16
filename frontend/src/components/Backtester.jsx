import React, { useState, useMemo } from 'react';
import { CartesianGrid, Area, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { API_BASE_URL, userId } from '../services/api';

const DEFAULT_BACKTEST_DAYS = 90;
const PRESETS = [
    { label: '1M', days: 30 },
    { label: '2M', days: 60 },
    { label: '3M', days: 90 },
    { label: '6M', days: 180 },
    { label: '1Y', days: 365 },
];
const MAX_TRADES_SHOWN = 20;

const Backtester = () => {
    const [results, setResults] = useState(null);
    const [isRunning, setIsRunning] = useState(false);
    const [error, setError] = useState(null);
    const [progress, setProgress] = useState('');
    const [progressPct, setProgressPct] = useState(0);
    const [backtestDays, setBacktestDays] = useState(DEFAULT_BACKTEST_DAYS);
    const [activePreset, setActivePreset] = useState(90);

    const fetchCandlesFromBrowser = async () => {
        const symbol = 'XAUUSDT';
        const interval = '360';
        const totalLimit = Math.ceil(backtestDays * 4) + 50;

        const now = new Date();
        const anchoredEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        let end = anchoredEnd.getTime();
        let allCandles = [];
        let remaining = totalLimit;

        while (remaining > 0) {
            const chunkLimit = Math.min(remaining, 200);
            const pct = Math.min(90, Math.round((allCandles.length / totalLimit) * 90));
            setProgressPct(pct);
            setProgress(`Fetching candles... ${allCandles.length}/${totalLimit}`);

            const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${chunkLimit}&end=${end}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Bybit API returned ${response.status}`);

            const json = await response.json();
            if (!json || json.retCode !== 0 || !json.result?.list || json.result.list.length === 0) break;

            allCandles = allCandles.concat(json.result.list);

            const lastTimestamp = parseInt(json.result.list[json.result.list.length - 1][0]);
            end = lastTimestamp;
            remaining -= chunkLimit;

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (allCandles.length === 0) {
            throw new Error('No candle data returned from Bybit');
        }

        setProgressPct(92);
        setProgress(`Processing ${allCandles.length} candles...`);
        return allCandles;
    };

    const runBacktest = async () => {
        setIsRunning(true);
        setError(null);
        setProgressPct(2);
        setProgress('Fetching historical data from Bybit...');
        try {
            const candles = await fetchCandlesFromBrowser();

            setProgressPct(93);
            setProgress('Running backtest simulation...');
            const response = await fetch(`${API_BASE_URL}/backtest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    days: backtestDays,
                    strategy: 'confluence_scoring',
                    userId: userId,
                    candles: candles
                })
            });

            if (!response.ok) {
                const errBody = await response.json().catch(() => ({}));
                throw new Error(errBody.error || `Backtest failed with status ${response.status}`);
            }

            const data = await response.json();
            setProgressPct(100);
            setResults(data);
        } catch (error) {
            setError(error.message || 'Backtest failed. Please try again.');
            setResults(null);
        } finally {
            setIsRunning(false);
            setProgress('');
            setProgressPct(0);
        }
    };

    const selectPreset = (days) => {
        setBacktestDays(days);
        setActivePreset(days);
    };

    const stats = useMemo(() => {
        if (!results?.trades?.length) return null;
        const trades = results.trades;
        const pnls = trades.map(t => t.pnl || 0);
        const wins = trades.filter(t => t.pnl > 0);
        const losses = trades.filter(t => t.pnl <= 0);
        const totalPnl = pnls.reduce((s, p) => s + p, 0);
        const avgPnl = totalPnl / trades.length;
        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
        const bestTrade = Math.max(...pnls);
        const worstTrade = Math.min(...pnls);
        const avgScore = trades.filter(t => t.score).reduce((s, t) => s + t.score, 0) / Math.max(trades.filter(t => t.score).length, 1);
        return {
            totalPnl, avgPnl, avgWin, avgLoss, bestTrade, worstTrade,
            winCount: wins.length, lossCount: losses.length, avgScore
        };
    }, [results]);

    const downloadCsv = () => {
        if (!results) return;

        let csv = `XAU/USD Backtest Summary (${backtestDays} Days)\n`;
        csv += `Metric,Value\n`;
        csv += `Total Trades,${results.totalTrades}\n`;
        csv += `Win Rate,${(results.winRate * 100).toFixed(1)}%\n`;
        csv += `Profit Factor,${results.profitFactor.toFixed(2)}\n`;
        csv += `Max Drawdown,${(results.maxDrawdown * 100).toFixed(1)}%\n`;
        csv += `Sharpe Ratio,${results.sharpeRatio.toFixed(2)}\n`;
        csv += `Total Return,${(results.totalReturn * 100).toFixed(1)}%\n`;
        csv += `Lot Size,Fixed 0.01 lot (~1 oz)\n`;
        if (results.dataInfo) {
            csv += `Data Source,${results.dataInfo.source}\n`;
            csv += `Candle Count,${results.dataInfo.candleCount}\n`;
            csv += `Date Range,${results.dataInfo.dateRange}\n`;
            csv += `Data Hash,${results.dataInfo.hash}\n`;
        }
        csv += '\n';

        csv += 'Equity Curve\n';
        csv += 'Day,Equity\n';
        results.equityCurve.forEach(point => {
            csv += `${point.day},${point.equity.toFixed(2)}\n`;
        });

        if (results.trades && results.trades.length > 0) {
            csv += '\nIndividual Trades\n';
            csv += 'ID,Timestamp,Exit Timestamp,Action,Lot Size,Entry Price,Exit Price,SL,TP1,TP2,TP1 Hit,PnL,Score,Confluence,Reason\n';
            results.trades.forEach(trade => {
                const entryTime = trade.entryTimestamp || trade.timestamp;
                const exitTime = trade.exitTimestamp || '';
                const score = trade.score || '';
                const confluence = trade.confluence ? `"${trade.confluence}"` : '';
                const reason = trade.exitReason || '';
                csv += `${trade.id},${entryTime},${exitTime},${trade.action},${trade.quantity?.toFixed(4) || '0.01'},${trade.entryPrice.toFixed(2)},${trade.exitPrice?.toFixed(2) || ''},${trade.sl?.toFixed(2) || ''},${trade.tp1?.toFixed(2) || ''},${trade.tp2?.toFixed(2) || ''},${trade.tp1Hit ? 'Yes' : 'No'},${trade.pnl?.toFixed(2) || ''},${score},${confluence},${reason}\n`;
            });
        }

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', 'xauusd_backtest_results.csv');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const equityChartData = useMemo(() => {
        return results?.equityCurve?.map((point) => ({
            day: point.day,
            equity: Number(point.equity.toFixed(2))
        })).reduce((acc, point) => {
            const previousPeak = acc.length > 0 ? acc[acc.length - 1].peak : 50;
            const peak = Math.max(previousPeak, point.equity);
            const drawdown = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
            acc.push({ ...point, peak, drawdown: Number(drawdown.toFixed(2)) });
            return acc;
        }, []) || [];
    }, [results]);

    return (
        <div className="backtester-container">
            <div className="backtester-header">
                <div>
                    <h2 style={{ borderBottom: 'none', marginBottom: 0 }}>Backtester</h2>
                    <p className="panel-kicker">Historical strategy readout using current configured parameters.</p>
                </div>
                {results && (
                    <button onClick={downloadCsv} className="btn-export-small">
                        Download CSV
                    </button>
                )}
            </div>

            <div className="backtester-fixed-lot-banner">
                <strong>⚡ Fixed Lot:</strong> 0.01 lot Gold (~1 oz) per trade
            </div>

            <div className="backtester-note">
                <strong>Unified Logic:</strong> Backtest and bot use the same closed-candle signal logic, realistic trade accounting, and risk settings.
            </div>

            <div className="backtester-settings-grid compact-backtest-settings">
                <label>
                    Days
                    <div className="backtest-days-input-row">
                        <input
                            type="number"
                            min="7"
                            max="365"
                            value={backtestDays}
                            onChange={(event) => {
                                const val = Math.max(7, Math.min(365, Number(event.target.value) || DEFAULT_BACKTEST_DAYS));
                                setBacktestDays(val);
                                setActivePreset(PRESETS.find(p => p.days === val) ? val : null);
                            }}
                        />
                    </div>
                </label>
                <div className="backtest-presets">
                    {PRESETS.map(p => (
                        <button
                            key={p.days}
                            className={`backtest-preset-btn ${activePreset === p.days ? 'active' : ''}`}
                            onClick={() => selectPreset(p.days)}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="backtester-controls">
                <button
                    onClick={runBacktest}
                    disabled={isRunning}
                    className={isRunning ? 'running' : ''}
                >
                    {isRunning ? (progress || 'Running...') : `Run ${backtestDays}-Day Backtest`}
                </button>
            </div>

            {isRunning && (
                <div className="backtest-progress-wrap">
                    <div className="backtest-progress-bar">
                        <div className="backtest-progress-fill" style={{ width: `${progressPct}%` }} />
                    </div>
                    <span className="backtest-progress-label">{progressPct}%</span>
                </div>
            )}

            {error && (
                <div className="backtest-error-box">
                    <strong>⚠ Backtest Error:</strong> {error}
                    <br />
                    <button onClick={runBacktest} className="backtest-retry-btn">
                        Retry
                    </button>
                </div>
            )}

            {results && (
                <div className="backtester-results">
                    {results.dataInfo && (
                        <div className="backtest-data-info">
                            <span>📊 <strong>Source:</strong> {results.dataInfo.source === 'cache' ? 'Cached (Bybit)' : 'Bybit Live'}</span>
                            <span>🕯 <strong>Candles:</strong> {results.dataInfo.candleCount}</span>
                            <span>📅 <strong>Range:</strong> {results.dataInfo.dateRange}</span>
                        </div>
                    )}

                    {stats && (
                        <div className="backtest-pnl-banner">
                            <div className="pnl-banner-main">
                                <span className="pnl-banner-label">Net P&L</span>
                                <span className={`pnl-banner-value ${stats.totalPnl >= 0 ? 'profit' : 'loss'}`}>
                                    ${stats.totalPnl.toFixed(2)}
                                </span>
                                <span className="pnl-banner-sub">
                                    {(results.totalReturn * 100).toFixed(1)}% return
                                </span>
                            </div>
                            <div className="pnl-banner-divider" />
                            <div className="pnl-banner-stats">
                                <div className="pnl-banner-stat">
                                    <span>Win/Loss</span>
                                    <strong>{stats.winCount}W / {stats.lossCount}L</strong>
                                </div>
                                <div className="pnl-banner-stat">
                                    <span>Avg P&L</span>
                                    <strong className={stats.avgPnl >= 0 ? 'profit' : 'loss'}>${stats.avgPnl.toFixed(2)}</strong>
                                </div>
                                <div className="pnl-banner-stat">
                                    <span>Best</span>
                                    <strong className="profit">${stats.bestTrade.toFixed(2)}</strong>
                                </div>
                                <div className="pnl-banner-stat">
                                    <span>Worst</span>
                                    <strong className="loss">${stats.worstTrade.toFixed(2)}</strong>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="results-grid">
                        <div className="result-item">
                            <h4>Total Trades</h4>
                            <p>{results.totalTrades}</p>
                        </div>
                        <div className="result-item">
                            <h4>Win Rate</h4>
                            <p>{(results.winRate * 100).toFixed(1)}%</p>
                        </div>
                        <div className="result-item">
                            <h4>Profit Factor</h4>
                            <p>{results.profitFactor.toFixed(2)}</p>
                        </div>
                        <div className="result-item">
                            <h4>Max Drawdown</h4>
                            <p>{(results.maxDrawdown * 100).toFixed(1)}%</p>
                        </div>
                        <div className="result-item">
                            <h4>Sharpe Ratio</h4>
                            <p>{results.sharpeRatio.toFixed(2)}</p>
                        </div>
                        <div className="result-item">
                            <h4>Total Return</h4>
                            <p>{(results.totalReturn * 100).toFixed(1)}%</p>
                        </div>
                    </div>

                    <div className="equity-curve-placeholder equity-graph-card">
                        <div className="equity-graph-heading">
                            <div>
                                <h4>Equity / Drawdown Graph</h4>
                                <p>Total Equity: ${(50 + results.totalReturn * 50).toFixed(2)} (Initial: $50.00)</p>
                            </div>
                            <div className="equity-graph-legend">
                                <span className="equity-line-key">Equity</span>
                                <span className="drawdown-line-key">Drawdown</span>
                            </div>
                            <div className="equity-graph-stat">
                                <span>Max DD</span>
                                <strong>{(results.maxDrawdown * 100).toFixed(1)}%</strong>
                            </div>
                        </div>

                        <div className="equity-chart-wrap">
                            <ResponsiveContainer width="100%" height={340}>
                                <LineChart data={equityChartData} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="#d4af37" stopOpacity={0.35} />
                                            <stop offset="100%" stopColor="#d4af37" stopOpacity={0.0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                                    <XAxis dataKey="day" stroke="#71717a" tick={{ fill: '#71717a', fontSize: 11 }} minTickGap={20} />
                                    <YAxis yAxisId="equity" stroke="#d4af37" tick={{ fill: '#cbd5e1', fontSize: 11 }} width={48} domain={['auto', 'auto']} />
                                    <YAxis yAxisId="drawdown" orientation="right" stroke="#ef4444" tick={{ fill: '#ef4444', fontSize: 11 }} width={42} />
                                    <Tooltip
                                        contentStyle={{ background: 'rgba(0,0,0,0.92)', border: '1px solid rgba(212,175,55,0.24)', borderRadius: '10px', color: '#f8fafc', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                                        formatter={(value, name) => name === 'drawdown' ? [`${Number(value).toFixed(2)}%`, 'Drawdown'] : [`$${Number(value).toFixed(2)}`, 'Equity']}
                                        labelFormatter={(label) => `Sample ${label}`}
                                    />
                                    <Area yAxisId="equity" type="monotone" dataKey="equity" fill="url(#equityGradient)" stroke="none" />
                                    <Line yAxisId="equity" type="monotone" dataKey="equity" stroke="#d4af37" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                                    <Line yAxisId="drawdown" type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {results.trades && results.trades.length > 0 && (
                        <div className="backtest-trades-list">
                            <div className="backtest-trades-header">
                                <h4>Individual Trades</h4>
                                {results.trades.length > MAX_TRADES_SHOWN && (
                                    <span className="backtest-trades-count">
                                        Showing {MAX_TRADES_SHOWN} of {results.trades.length} — download CSV for full list
                                    </span>
                                )}
                            </div>
                            <table className="trade-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Action</th>
                                        <th>Lot</th>
                                        <th>Entry</th>
                                        <th>Exit</th>
                                        <th>SL</th>
                                        <th>TP1</th>
                                        <th>PnL</th>
                                        <th>Score</th>
                                        <th>Reason</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {results.trades.slice(0, MAX_TRADES_SHOWN).map(trade => (
                                        <tr key={trade.id}>
                                            <td>{new Date(trade.entryTimestamp || trade.timestamp).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</td>
                                            <td className={trade.action.toLowerCase()}>{trade.action}</td>
                                            <td style={{ color: '#d4af37', fontFamily: 'monospace', fontSize: '0.8rem' }}>{(trade.quantity || 0.01).toFixed(4)}</td>
                                            <td>${trade.entryPrice.toFixed(2)}</td>
                                            <td>${trade.exitPrice?.toFixed(2) || '—'}</td>
                                            <td style={{ color: '#f87171', fontSize: '0.82rem' }}>${trade.sl?.toFixed(2) || '—'}</td>
                                            <td>{trade.tp1Hit ? <span className="tp1-hit-badge">✓ Hit</span> : <span style={{ color: '#64748b' }}>—</span>}</td>
                                            <td className={trade.pnl >= 0 ? 'profit' : 'loss'}>
                                                ${trade.pnl.toFixed(2)}
                                            </td>
                                            <td style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.82rem' }}>{trade.score || '—'}</td>
                                            <td style={{ fontSize: '0.72rem', color: '#94a3b8', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.exitReason || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {!results && !isRunning && !error && (
                <div className="backtest-empty-state">
                    <div className="backtest-empty-icon">
                        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="4" y="8" width="40" height="32" rx="4" stroke="rgba(212,175,55,0.3)" strokeWidth="2" fill="none" />
                            <path d="M12 28L18 20L24 24L30 16L36 22" stroke="#d4af37" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                            <circle cx="18" cy="20" r="2" fill="#d4af37" />
                            <circle cx="24" cy="24" r="2" fill="#d4af37" />
                            <circle cx="30" cy="16" r="2" fill="#d4af37" />
                            <circle cx="36" cy="22" r="2" fill="#d4af37" />
                        </svg>
                    </div>
                    <p className="backtest-empty-text">
                        Select a timeframe and click <strong>Run Backtest</strong> to see historical XAU/USD performance.
                    </p>
                </div>
            )}
        </div>
    );
};

export default Backtester;
