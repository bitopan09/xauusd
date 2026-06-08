import React, { useState } from 'react';
import { API_BASE_URL, userId } from '../services/api';

const Backtester = () => {
    const [results, setResults] = useState(null);
    const [isRunning, setIsRunning] = useState(false);
    const [error, setError] = useState(null);

    const runBacktest = async () => {
        setIsRunning(true);
        setError(null);
        try {
            const response = await fetch(`${API_BASE_URL}/backtest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    days: 90,
                    strategy: 'confluence_scoring',
                    userId: userId
                })
            });

            if (!response.ok) {
                const errBody = await response.json().catch(() => ({}));
                throw new Error(errBody.error || `Backtest failed with status ${response.status}`);
            }

            const data = await response.json();
            setResults(data);
        } catch (error) {
            console.error('Backtest failed:', error);
            setError(error.message || 'Backtest failed. Please try again.');
            setResults(null);
        } finally {
            setIsRunning(false);
        }
    };

    const downloadCsv = () => {
        if (!results) return;

        let csv = 'XAU/USD Backtest Summary (90 Days)\n';
        csv += `Metric,Value\n`;
        csv += `Total Trades,${results.totalTrades}\n`;
        csv += `Win Rate,${(results.winRate * 100).toFixed(1)}%\n`;
        csv += `Profit Factor,${results.profitFactor.toFixed(2)}\n`;
        csv += `Max Drawdown,${(results.maxDrawdown * 100).toFixed(1)}%\n`;
        csv += `Sharpe Ratio,${results.sharpeRatio.toFixed(2)}\n`;
        csv += `Total Return,${(results.totalReturn * 100).toFixed(1)}%\n`;
        csv += `Lot Size,Fixed 0.01\n`;
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
            csv += 'ID,Timestamp,Exit Timestamp,Action,Lot Size,Entry Price,Exit Price,SL,TP1,PnL,Score,Confluence,Reason\n';
            results.trades.forEach(trade => {
                const entryTime = trade.entryTimestamp || trade.timestamp;
                const exitTime = trade.exitTimestamp || '';
                const score = trade.score || '';
                const confluence = trade.confluence ? `"${trade.confluence}"` : '';
                const reason = trade.exitReason || '';
                csv += `${trade.id},${entryTime},${exitTime},${trade.action},${trade.quantity?.toFixed(4) || '0.01'},${trade.entryPrice.toFixed(2)},${trade.exitPrice?.toFixed(2) || ''},${trade.sl?.toFixed(2) || ''},${trade.tp1?.toFixed(2) || ''},${trade.pnl?.toFixed(2) || ''},${score},${confluence},${reason}\n`;
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

    return (
        <div className="backtester-container">
            <div className="backtester-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(212,175,55,0.08)', marginBottom: '15px' }}>
                <h2 style={{ borderBottom: 'none', marginBottom: 0 }}>Gold Backtester</h2>
                {results && (
                    <button onClick={downloadCsv} className="btn-export-small">
                        Download CSV
                    </button>
                )}
            </div>

            <div style={{ marginBottom: '10px', padding: '6px 10px', background: 'rgba(212, 175, 55, 0.08)', borderRadius: '6px', border: '1px solid rgba(212, 175, 55, 0.15)', fontSize: '0.78rem', color: '#d4af37' }}>
                <strong>⚡ Fixed Lot:</strong> 0.01 oz Gold per trade
            </div>

            <div className="backtester-controls">
                <button
                    onClick={runBacktest}
                    disabled={isRunning}
                    className={isRunning ? 'running' : ''}
                >
                    {isRunning ? 'Running...' : 'Run 90-Day Gold Backtest'}
                </button>
            </div>

            {error && (
                <div style={{ marginTop: '12px', padding: '10px 14px', background: 'rgba(239,68,68,0.12)', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: '0.85rem' }}>
                    <strong>⚠ Backtest Error:</strong> {error}
                    <br />
                    <button
                        onClick={runBacktest}
                        style={{ marginTop: '8px', padding: '4px 12px', background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '6px', color: '#f87171', cursor: 'pointer', fontSize: '0.8rem' }}
                    >
                        Retry
                    </button>
                </div>
            )}

            {results && (
                <div className="backtester-results">
                    <h3>Backtest Results (90 days)</h3>

                    {results.dataInfo && (
                        <div style={{ marginBottom: '12px', padding: '6px 10px', background: 'rgba(34,197,94,0.08)', borderRadius: '6px', border: '1px solid rgba(34,197,94,0.2)', fontSize: '0.72rem', color: '#86efac', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                            <span>📊 <strong>Source:</strong> {results.dataInfo.source === 'cache' ? 'Cached (Bybit)' : 'Bybit Live'}</span>
                            <span>🕯 <strong>Candles:</strong> {results.dataInfo.candleCount}</span>
                            <span>📅 <strong>Range:</strong> {results.dataInfo.dateRange}</span>
                            <span>🔒 <strong>Hash:</strong> {results.dataInfo.hash}</span>
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

                    <div className="equity-curve-placeholder">
                        <h4>Equity Curve</h4>
                        <p>Total Equity: ${(50 + results.totalReturn * 50).toFixed(2)} (Initial: $50.00)</p>
                    </div>

                    {results.trades && results.trades.length > 0 && (
                        <div className="backtest-trades-list">
                            <h4>Individual Trades</h4>
                            <table className="trade-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Action</th>
                                        <th>Lot</th>
                                        <th>Entry</th>
                                        <th>Exit</th>
                                        <th>PnL</th>
                                        <th>Reason</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {results.trades.slice(0, 15).map(trade => (
                                        <tr key={trade.id}>
                                            <td>{new Date(trade.entryTimestamp || trade.timestamp).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</td>
                                            <td className={trade.action.toLowerCase()}>{trade.action}</td>
                                            <td style={{ color: '#d4af37', fontFamily: 'monospace', fontSize: '0.8rem' }}>{(trade.quantity || 0.01).toFixed(4)}</td>
                                            <td>${trade.entryPrice.toFixed(2)}</td>
                                            <td>${trade.exitPrice.toFixed(2)}</td>
                                            <td className={trade.pnl >= 0 ? 'profit' : 'loss'}>
                                                ${trade.pnl.toFixed(2)}
                                            </td>
                                            <td style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{trade.exitReason || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {results.trades.length > 15 && (
                                <p style={{ fontSize: '0.8rem', color: '#718096', textAlign: 'center' }}>
                                    Showing first 15 of {results.trades.length} trades. Download CSV for full data.
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {!results && !isRunning && !error && (
                <p>Click "Run 90-Day Gold Backtest" to see historical XAU/USD performance</p>
            )}
        </div>
    );
};

export default Backtester;
