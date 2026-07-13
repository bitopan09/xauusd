import React, { useState, useMemo } from 'react';
import { CartesianGrid, Area, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { API_BASE_URL } from '../services/api';

const DEFAULT_BACKTEST_DAYS = 90;
const PRESETS = [
    { label: '1M', days: 30 },
    { label: '2M', days: 60 },
    { label: '3M', days: 90 },
    { label: '6M', days: 180 },
    { label: '1Y', days: 365 },
];
const MAX_TRADES_SHOWN = 25;

const Backtester = () => {
    const [results, setResults] = useState(null);
    const [isRunning, setIsRunning] = useState(false);
    const [error, setError] = useState(null);
    const [progress, setProgress] = useState('');
    const [progressPct, setProgressPct] = useState(0);
    const [backtestDays, setBacktestDays] = useState(DEFAULT_BACKTEST_DAYS);
    const [activePreset, setActivePreset] = useState(90);

    const fetchCandlesFromBrowser = async (days) => {
        // 6H candles: 4 per day + 150 warmup candles
        const required = Math.ceil(days * 4) + 150;
        const limit = Math.min(required, 1000);
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=360&limit=${limit}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Bybit API: ${response.status}`);
        const json = await response.json();
        if (json.retCode !== 0 || !json.result?.list || json.result.list.length === 0) {
            throw new Error('Bybit API returned no candle data');
        }
        return json.result.list; // [[timestamp, open, high, low, close, volume, turnover], ...]
    };

    const runBacktest = async () => {
        setIsRunning(true);
        setError(null);
        setProgressPct(10);
        setProgress('Fetching candle data from browser...');
        try {
            setProgressPct(20);
            setProgress('Fetching 6H candles from Bybit (browser-side)...');

            let candles;
            try {
                candles = await fetchCandlesFromBrowser(backtestDays);
                setProgressPct(40);
                setProgress(`Got ${candles.length} candles from browser. Running backtest...`);
            } catch (candleErr) {
                console.warn('Browser candle fetch failed:', candleErr.message);
                setProgressPct(30);
                setProgress('Browser fetch failed, trying server fallback...');
                candles = null;
            }

            setProgressPct(50);
            setProgress('Running V4-Plus backtest with DD risk management...');

            const response = await fetch(`${API_BASE_URL}/full-backtest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days: backtestDays, candles })
            });

            setProgressPct(80);
            setProgress('Calculating risk metrics & progressive sizing...');

            if (!response.ok) {
                const errBody = await response.json().catch(() => ({}));
                throw new Error(errBody.error || `Backtest failed with status ${response.status}`);
            }

            const data = await response.json();
            setProgressPct(100);
            setResults(data);
        } catch (err) {
            setError(err.message || 'Backtest failed. Please try again.');
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

    const downloadCsv = () => {
        if (!results) return;
        let csv = `XAU/USD V4-Plus Backtest (${backtestDays} Days)\n`;
        csv += `Metric,Value\n`;
        csv += `Starting Balance,$${results.startingBalance}\n`;
        csv += `Final Balance,$${results.finalBalance}\n`;
        csv += `Total PnL,$${results.totalPnl}\n`;
        csv += `Total Return,${(results.totalReturn * 100).toFixed(1)}%\n`;
        csv += `Win Rate,${(results.winRate * 100).toFixed(1)}%\n`;
        csv += `Profit Factor,${results.profitFactor}\n`;
        csv += `Max Drawdown,${results.maxDrawdownPct}%\n`;
        csv += `Sharpe Ratio,${results.sharpeRatio}\n`;
        csv += `Total Trades,${results.totalTrades}\n`;
        csv += `Config: Threshold=${results.config?.confluenceThreshold}, MaxSL=${results.config?.maxSlDistance}, TP1Close=${results.config?.tp1ClosePercent}%\n`;
        csv += '\nEquity Curve\nDay,Equity\n';
        results.equityCurve.forEach(pt => { csv += `${pt.day},${pt.equity}\n`; });
        csv += '\nTrades\n#,Action,Entry,Exit,SL,ExitSL,TP1,ExitReason,PnL,SizeMult,Regime\n';
        results.trades.forEach((t, i) => {
            csv += `${i+1},${t.action},${t.entryPrice?.toFixed(2)},${t.exitPrice?.toFixed(2) || ''},${t.sl?.toFixed(2) || ''},${t.exitSl?.toFixed(2) || ''},${t.tp1?.toFixed(2) || ''},"${t.exitReason || ''}",${t.pnl?.toFixed(2)},${t.sizeMultiplier || 1},${t.regime || ''}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `xauusd_v4plus_backtest_${backtestDays}d.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    const equityChartData = useMemo(() => {
        return results?.equityCurve?.map((pt) => ({
            day: pt.day,
            equity: Number(pt.equity.toFixed(2))
        })).reduce((acc, pt) => {
            const prevPeak = acc.length > 0 ? acc[acc.length - 1].peak : results.startingBalance;
            const peak = Math.max(prevPeak, pt.equity);
            const drawdown = peak > 0 ? ((peak - pt.equity) / peak) * 100 : 0;
            acc.push({ ...pt, peak, drawdown: Number(drawdown.toFixed(2)) });
            return acc;
        }, []) || [];
    }, [results]);

    return (
        <div className="backtester-container">
            <div className="backtester-header">
                <div>
                    <h2 style={{ borderBottom: 'none', marginBottom: 0 }}>V4-Plus Backtester</h2>
                    <p className="panel-kicker">Full backtest with progressive position sizing (80/60/35) & DD risk management.</p>
                </div>
                {results && (
                    <button onClick={downloadCsv} className="btn-export-small">Download CSV</button>
                )}
            </div>

            <div className="backtester-fixed-lot-banner">
                <strong>Config:</strong> Threshold 6.5 | MaxSL 8pt | TP1 50% | Window 100 | 24h Session | Sizing: 1.0/0.8/0.6/0.35
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
                            onChange={(e) => {
                                const val = Math.max(7, Math.min(365, Number(e.target.value) || DEFAULT_BACKTEST_DAYS));
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
                    <strong>Error:</strong> {error}
                    <br />
                    <button onClick={runBacktest} className="backtest-retry-btn">Retry</button>
                </div>
            )}

            {results && (
                <div className="backtester-results">
                    {results.dataInfo && (
                        <div className="backtest-data-info">
                            <span>Source: {results.dataInfo.source === 'client_browser' ? 'Browser (Bybit)' : results.dataInfo.source === 'cache' ? 'Cached' : 'Live (Server)'}</span>
                            <span>Candles: {results.dataInfo.candleCount}</span>
                            <span>Range: {results.dataInfo.dateRange}</span>
                        </div>
                    )}

                    {/* P&L Banner */}
                    <div className="backtest-pnl-banner">
                        <div className="pnl-banner-main">
                            <span className="pnl-banner-label">Net P&L</span>
                            <span className={`pnl-banner-value ${results.totalPnl >= 0 ? 'profit' : 'loss'}`}>
                                ${results.totalPnl.toFixed(2)}
                            </span>
                            <span className="pnl-banner-sub">
                                ${(results.startingBalance + results.totalPnl).toFixed(2)} final ({(results.totalReturn * 100).toFixed(1)}% return)
                            </span>
                        </div>
                        <div className="pnl-banner-divider" />
                        <div className="pnl-banner-stats">
                            <div className="pnl-banner-stat">
                                <span>Win/Loss</span>
                                <strong>{results.winCount}W / {results.lossCount}L</strong>
                            </div>
                            <div className="pnl-banner-stat">
                                <span>Avg Win</span>
                                <strong className="profit">${results.avgWin.toFixed(2)}</strong>
                            </div>
                            <div className="pnl-banner-stat">
                                <span>Avg Loss</span>
                                <strong className="loss">${results.avgLoss.toFixed(2)}</strong>
                            </div>
                            <div className="pnl-banner-stat">
                                <span>W/L Ratio</span>
                                <strong>{results.winLossRatio}:1</strong>
                            </div>
                        </div>
                    </div>

                    {/* Stats Grid */}
                    <div className="results-grid">
                        <div className="result-item">
                            <h4>Starting</h4>
                            <p>${results.startingBalance}</p>
                        </div>
                        <div className="result-item">
                            <h4>Final</h4>
                            <p>${results.finalBalance}</p>
                        </div>
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
                            <p>{results.profitFactor}</p>
                        </div>
                        <div className="result-item">
                            <h4>Max Drawdown</h4>
                            <p>{results.maxDrawdownPct}%</p>
                        </div>
                        <div className="result-item">
                            <h4>Sharpe Ratio</h4>
                            <p>{results.sharpeRatio}</p>
                        </div>
                        <div className="result-item">
                            <h4>Max Streak W/L</h4>
                            <p>{results.maxConsecWins} / {results.maxConsecLosses}</p>
                        </div>
                        <div className="result-item">
                            <h4>Trades/Day</h4>
                            <p>{results.tradesPerDay}</p>
                        </div>
                    </div>

                    {/* Equity Curve */}
                    <div className="equity-curve-placeholder equity-graph-card">
                        <div className="equity-graph-heading">
                            <div>
                                <h4>Equity / Drawdown Curve</h4>
                                <p>Start: ${results.startingBalance} &rarr; End: ${results.finalBalance}</p>
                            </div>
                            <div className="equity-graph-legend">
                                <span className="equity-line-key">Equity</span>
                                <span className="drawdown-line-key">Drawdown</span>
                            </div>
                            <div className="equity-graph-stat">
                                <span>Max DD</span>
                                <strong>{results.maxDrawdownPct}%</strong>
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
                                    <YAxis yAxisId="equity" stroke="#d4af37" tick={{ fill: '#cbd5e1', fontSize: 11 }} width={52} domain={['auto', 'auto']} />
                                    <YAxis yAxisId="drawdown" orientation="right" stroke="#ef4444" tick={{ fill: '#ef4444', fontSize: 11 }} width={42} />
                                    <Tooltip
                                        contentStyle={{ background: 'rgba(0,0,0,0.92)', border: '1px solid rgba(212,175,55,0.24)', borderRadius: '10px', color: '#f8fafc', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}
                                        formatter={(value, name) => name === 'drawdown' ? [`${Number(value).toFixed(2)}%`, 'Drawdown'] : [`$${Number(value).toFixed(2)}`, 'Equity']}
                                        labelFormatter={(label) => `Trade ${label}`}
                                    />
                                    <Area yAxisId="equity" type="monotone" dataKey="equity" fill="url(#equityGradient)" stroke="none" />
                                    <Line yAxisId="equity" type="monotone" dataKey="equity" stroke="#d4af37" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                                    <Line yAxisId="drawdown" type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Breakdown Tables */}
                    <div className="backtest-breakdowns" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                        {/* Exit Reason Breakdown */}
                        {results.exitReasons && Object.keys(results.exitReasons).length > 0 && (
                            <div style={{ background: 'rgba(15,15,25,0.6)', borderRadius: '10px', padding: '14px', border: '1px solid rgba(212,175,55,0.12)' }}>
                                <h4 style={{ margin: '0 0 10px', fontSize: '0.85rem', color: '#d4af37' }}>Exit Reasons</h4>
                                <table style={{ width: '100%', fontSize: '0.75rem' }}>
                                    <thead>
                                        <tr style={{ color: '#71717a' }}>
                                            <th style={{ textAlign: 'left', padding: '3px 0' }}>Reason</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>Count</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>PnL</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {Object.entries(results.exitReasons)
                                            .sort((a, b) => b[1].count - a[1].count)
                                            .map(([reason, data]) => (
                                                <tr key={reason}>
                                                    <td style={{ padding: '3px 0', color: '#cbd5e1' }}>{reason}</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: '#94a3b8' }}>{data.count}</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: data.pnl >= 0 ? '#4ade80' : '#f87171' }}>
                                                        ${data.pnl.toFixed(2)}
                                                    </td>
                                                </tr>
                                            ))
                                        }
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {/* Regime Breakdown */}
                        {results.regimeStats && Object.keys(results.regimeStats).length > 0 && (
                            <div style={{ background: 'rgba(15,15,25,0.6)', borderRadius: '10px', padding: '14px', border: '1px solid rgba(212,175,55,0.12)' }}>
                                <h4 style={{ margin: '0 0 10px', fontSize: '0.85rem', color: '#d4af37' }}>By Regime</h4>
                                <table style={{ width: '100%', fontSize: '0.75rem' }}>
                                    <thead>
                                        <tr style={{ color: '#71717a' }}>
                                            <th style={{ textAlign: 'left', padding: '3px 0' }}>Regime</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>Trades</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>Win%</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>PnL</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {Object.entries(results.regimeStats)
                                            .sort((a, b) => b[1].count - a[1].count)
                                            .map(([regime, data]) => (
                                                <tr key={regime}>
                                                    <td style={{ padding: '3px 0', color: '#cbd5e1' }}>{regime}</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: '#94a3b8' }}>{data.count}</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: '#94a3b8' }}>{((data.wins / data.count) * 100).toFixed(0)}%</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: data.pnl >= 0 ? '#4ade80' : '#f87171' }}>
                                                        ${data.pnl.toFixed(2)}
                                                    </td>
                                                </tr>
                                            ))
                                        }
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {/* Action Breakdown */}
                        {results.actionStats && Object.keys(results.actionStats).length > 0 && (
                            <div style={{ background: 'rgba(15,15,25,0.6)', borderRadius: '10px', padding: '14px', border: '1px solid rgba(212,175,55,0.12)' }}>
                                <h4 style={{ margin: '0 0 10px', fontSize: '0.85rem', color: '#d4af37' }}>By Action</h4>
                                <table style={{ width: '100%', fontSize: '0.75rem' }}>
                                    <thead>
                                        <tr style={{ color: '#71717a' }}>
                                            <th style={{ textAlign: 'left', padding: '3px 0' }}>Action</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>Trades</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>Win%</th>
                                            <th style={{ textAlign: 'right', padding: '3px 0' }}>PnL</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {Object.entries(results.actionStats)
                                            .sort((a, b) => b[1].count - a[1].count)
                                            .map(([action, data]) => (
                                                <tr key={action}>
                                                    <td style={{ padding: '3px 0', color: action === 'BUY' ? '#4ade80' : '#f87171', fontWeight: 600 }}>{action}</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: '#94a3b8' }}>{data.count}</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: '#94a3b8' }}>{((data.wins / data.count) * 100).toFixed(0)}%</td>
                                                    <td style={{ padding: '3px 0', textAlign: 'right', color: data.pnl >= 0 ? '#4ade80' : '#f87171' }}>
                                                        ${data.pnl.toFixed(2)}
                                                    </td>
                                                </tr>
                                            ))
                                        }
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Trade Table */}
                    {results.trades && results.trades.length > 0 && (
                        <div className="backtest-trades-list">
                            <div className="backtest-trades-header">
                                <h4>Individual Trades</h4>
                                {results.trades.length > MAX_TRADES_SHOWN && (
                                    <span className="backtest-trades-count">
                                        Showing {MAX_TRADES_SHOWN} of {results.trades.length}
                                    </span>
                                )}
                            </div>
                            <table className="trade-table">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Action</th>
                                        <th>Size</th>
                                        <th>Entry</th>
                                        <th>Exit</th>
                                        <th>SL</th>
                                        <th>Exit SL</th>
                                        <th>Regime</th>
                                        <th>ZLEMA 5-TF</th>
                                        <th>PnL</th>
                                        <th>Mult</th>
                                        <th>Reason</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {results.trades.slice(0, MAX_TRADES_SHOWN).map((trade, i) => (
                                        <tr key={i}>
                                            <td style={{ color: '#64748b', fontSize: '0.78rem' }}>{i + 1}</td>
                                            <td className={trade.action.toLowerCase()}>{trade.action}</td>
                                            <td style={{ color: '#d4af37', fontFamily: 'monospace', fontSize: '0.78rem' }}>{(trade.quantity || 0.01).toFixed(4)}</td>
                                            <td>${trade.entryPrice?.toFixed(2)}</td>
                                            <td>${trade.exitPrice?.toFixed(2) || '—'}</td>
                                            <td style={{ color: '#f87171', fontSize: '0.82rem' }}>${trade.sl?.toFixed(2) || '—'}</td>
                                            <td style={{ color: '#94a3b8', fontSize: '0.78rem' }}>${trade.exitSl?.toFixed(2) || '—'}</td>
                                            <td style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{trade.regime || '—'}</td>
                                            <td style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                                                {trade.zlema5TFGate ? (
                                                    <span title={trade.zlema5TFGate.tfStates?.map(s => `${s.tf}: ${s.state}`).join('\n')}>
                                                        {trade.zlema5TFGate.direction === 'BULLISH' ? '🐂' : trade.zlema5TFGate.direction === 'BEARISH' ? '🐻' : '—'}
                                                        {' '}
                                                        {trade.zlema5TFGate.bullishCount}/{trade.zlema5TFGate.bearishCount}/{trade.zlema5TFGate.neutralCount}
                                                    </span>
                                                ) : '—'}
                                            </td>
                                            <td className={trade.pnl >= 0 ? 'profit' : 'loss'}>
                                                ${trade.pnl?.toFixed(2)}
                                            </td>
                                            <td style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.78rem' }}>{trade.sizeMultiplier || 1.0}x</td>
                                            <td style={{ fontSize: '0.7rem', color: '#94a3b8', maxWidth: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trade.exitReason || '—'}</td>
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
                        Select a timeframe and click <strong>Run Backtest</strong> to see V4-Plus performance with DD risk management.
                    </p>
                </div>
            )}
        </div>
    );
};

export default Backtester;
