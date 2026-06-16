import React, { useState, useEffect, useCallback } from 'react';
import { fetchActiveTrades, closeTrade, fetchPrice } from '../services/api';

const POLL_INTERVAL = 5000;

const ActiveTrades = () => {
    const [trades, setTrades] = useState([]);
    const [currentPrice, setCurrentPrice] = useState(0);
    const [loading, setLoading] = useState(true);
    const [exitError, setExitError] = useState(null);
    const [exitingId, setExitingId] = useState(null);

    const loadData = useCallback(async () => {
        try {
            const [tradesData, priceData] = await Promise.all([
                fetchActiveTrades(),
                fetchPrice().catch(() => null)
            ]);
            setTrades(tradesData);
            if (priceData?.price) setCurrentPrice(priceData.price);
        } catch (error) {
            // ignore polling errors
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
        const interval = setInterval(loadData, POLL_INTERVAL);
        return () => clearInterval(interval);
    }, [loadData]);

    const handleExit = async (id) => {
        setExitingId(id);
        setExitError(null);
        try {
            await closeTrade(id);
            setTrades(prev => prev.filter(t => t.id !== id));
        } catch (error) {
            setExitError(error.error || error.message || 'Failed to exit trade');
            setTimeout(() => setExitError(null), 4000);
        } finally {
            setExitingId(null);
        }
    };

    const calculatePnL = (trade) => {
        if (!currentPrice) return 0;
        const CONTRACT_SIZE = 100; // 1 lot = 100 oz
        const remainingQuantity = trade.remaining_quantity ?? trade.remainingQuantity ?? trade.quantity;
        const realizedPnl = trade.realized_pnl ?? trade.realizedPnl ?? 0;
        const positionSize = remainingQuantity * CONTRACT_SIZE;
        if (trade.action === 'BUY') {
            return realizedPnl + ((currentPrice - trade.entry_price) * positionSize);
        } else {
            return realizedPnl + ((trade.entry_price - currentPrice) * positionSize);
        }
    };

    return (
        <div className="active-trades-container">
            <h2>Live Signals & Active Trades</h2>
            {exitError && (
                <div style={{ padding: '8px 12px', marginBottom: '10px', background: 'rgba(239,68,68,0.12)', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: '0.85rem' }}>
                    {exitError}
                </div>
            )}
            {loading ? (
                <p>Loading active trades...</p>
            ) : trades.length === 0 ? (
                <p>No active gold trades right now.</p>
            ) : (
                <div className="active-trades-grid">
                    {trades.map(trade => {
                        const pnl = calculatePnL(trade);
                        const remainingQuantity = trade.remaining_quantity ?? trade.quantity;
                        return (
                            <div key={trade.id} className={`active-trade-card ${trade.action.toLowerCase()}`}>
                                <div className="trade-header">
                                    <span className="action">{trade.action}</span>
                                    <span className={`pnl ${pnl >= 0 ? 'profit' : 'loss'}`}>
                                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                                    </span>
                                </div>
                                <div className="trade-details">
                                    <p><strong>Entry:</strong> ${trade.entry_price?.toFixed(2)}</p>
                                    <p><strong>Live Price:</strong> ${currentPrice.toFixed(2)}</p>
                                    <p><strong>Remaining:</strong> {(remainingQuantity || 0).toFixed(4)} lot</p>
                                    <p><strong>SL:</strong> ${trade.sl?.toFixed(2) || 'N/A'}</p>
                                    <p><strong>TP1 / TP2:</strong> ${trade.tp1?.toFixed(2) || 'N/A'} / ${trade.tp2?.toFixed(2) || 'N/A'}</p>
                                    {trade.tp1_hit ? <p><strong>TP1:</strong> Partial booked</p> : null}
                                </div>
                                <button 
                                    className="btn-exit" 
                                    onClick={() => handleExit(trade.id)}
                                    disabled={exitingId === trade.id}
                                >
                                    {exitingId === trade.id ? 'EXITING...' : 'EXIT NOW'}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default ActiveTrades;
