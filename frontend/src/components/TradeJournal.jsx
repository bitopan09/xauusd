import React, { useState, useEffect } from 'react';
import { fetchTrades, exportTradesCsvUrl, userId } from '../services/api';
import { formatTimeIST } from '../utils/timeFormatter';

const TradeJournal = () => {
    const [trades, setTrades] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchTradesData = async () => {
            try {
                setLoading(true);
                const data = await fetchTrades();
                setTrades(data);
                setLoading(false);
            } catch (error) {
                setLoading(false);
            }
        };

        fetchTradesData();
        const interval = setInterval(fetchTradesData, 30000);
        return () => clearInterval(interval);
    }, []);

    if (loading) {
        return (
            <div className="journal-container">
                <h2>Trade Journal</h2>
                <p>Loading trade data...</p>
            </div>
        );
    }

    return (
        <div className="journal-container">
            <div className="journal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <h2 style={{ marginBottom: '4px' }}>Gold Trade Journal (Paper Trading)</h2>
                    <small style={{ color: '#94a3b8', fontSize: '12px' }}>User: {userId.substring(0, 16)}...</small>
                </div>
                <a href={exportTradesCsvUrl} className="btn-export" download="xauusd_trade_journal.csv">
                    📥 Export to Excel
                </a>
            </div>
            {trades.length === 0 ? (
                <p>No gold trades recorded yet.</p>
            ) : (
                <table className="trade-table">
                    <thead>
                        <tr>
                            <th>Date (IST)</th>
                            <th>Action</th>
                            <th>Entry</th>
                            <th>Exit</th>
                            <th>SL / TP1 / TP2</th>
                            <th>Status</th>
                            <th>Qty (lots)</th>
                            <th>P&L</th>
                            <th>Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {trades.map(trade => (
                            <tr key={trade.id}>
                                <td>{formatTimeIST(trade.timestamp, 'date-time')}</td>
                                <td><strong>{trade.action}</strong></td>
                                <td>${trade.entry_price?.toFixed(2) || 'N/A'}</td>
                                <td>{trade.exit_price ? '$'+trade.exit_price.toFixed(2) : 'Open'}</td>
                                <td style={{fontSize: '0.85em'}}>
                                    SL: {trade.sl ? trade.sl.toFixed(2) : '-'} <br/>
                                    TP1: {trade.tp1 ? trade.tp1.toFixed(2) : '-'} <br/>
                                    TP2: {trade.tp2 ? trade.tp2.toFixed(2) : '-'}
                                </td>
                                <td><span className={`status-${trade.status?.toLowerCase() || 'open'}`}>{trade.status || 'OPEN'}</span></td>
                                <td>{trade.quantity}</td>
                                <td className={trade.pnl >= 0 ? 'profit' : 'loss'}>
                                    {trade.pnl !== null ? '$' + trade.pnl.toFixed(2) : 'Open'}
                                </td>
                                <td>{trade.tp1_hit ? 'TP1 partial booked; ' : ''}{trade.exit_reason || trade.notes || '-'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
};

export default TradeJournal;
