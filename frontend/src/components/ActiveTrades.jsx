import React, { useState, useEffect, useCallback } from 'react';
import { fetchActiveTrades, closeTrade, partialCloseTrade, fetchPrice } from '../services/api';

const POLL_INTERVAL = 5000;

const ActiveTrades = () => {
    const [trades, setTrades] = useState([]);
    const [currentPrice, setCurrentPrice] = useState(0);
    const [loading, setLoading] = useState(true);
    const [exitError, setExitError] = useState(null);
    const [exitingId, setExitingId] = useState(null);
    const [partialId, setPartialId] = useState(null);
    const [showPartialMenu, setShowPartialMenu] = useState(null);

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

    const handlePartialClose = async (id, percent) => {
        setPartialId(id);
        setShowPartialMenu(null);
        setExitError(null);
        try {
            const result = await partialCloseTrade(id, percent);
            if (result.remainingQuantity <= 0) {
                setTrades(prev => prev.filter(t => t.id !== id));
            } else {
                setTrades(prev => prev.map(t =>
                    t.id === id ? { ...t, remaining_quantity: result.remainingQuantity, realized_pnl: result.pnl } : t
                ));
            }
        } catch (error) {
            setExitError(error.error || error.message || 'Failed to partial close trade');
            setTimeout(() => setExitError(null), 4000);
        } finally {
            setPartialId(null);
        }
    };

    const calculatePnL = (trade) => {
        if (!currentPrice) return 0;
        const CONTRACT_SIZE = 100;
        const remainingQuantity = trade.remaining_quantity ?? trade.remainingQuantity ?? trade.quantity;
        const realizedPnl = trade.realized_pnl ?? trade.realizedPnl ?? 0;
        const positionSize = remainingQuantity * CONTRACT_SIZE;
        if (trade.action === 'BUY') {
            return realizedPnl + ((currentPrice - trade.entry_price) * positionSize);
        } else {
            return realizedPnl + ((trade.entry_price - currentPrice) * positionSize);
        }
    };

    const calculatePips = (trade) => {
        if (!currentPrice) return 0;
        if (trade.action === 'BUY') {
            return (currentPrice - trade.entry_price) * 10;
        } else {
            return (trade.entry_price - currentPrice) * 10;
        }
    };

    const pipsToSL = (trade) => {
        if (!currentPrice || !trade.sl) return null;
        if (trade.action === 'BUY') {
            return (trade.sl - currentPrice) * 10;
        } else {
            return (currentPrice - trade.sl) * 10;
        }
    };

    const pipsToTP1 = (trade) => {
        if (!currentPrice || !trade.tp1) return null;
        if (trade.action === 'BUY') {
            return (trade.tp1 - currentPrice) * 10;
        } else {
            return (currentPrice - trade.tp1) * 10;
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
                        const pips = calculatePips(trade);
                        const remainingQuantity = trade.remaining_quantity ?? trade.quantity;
                        const tp1Hit = trade.tp1_hit || trade.tp1Hit;
                        const distanceSL = pipsToSL(trade);
                        const distanceTP1 = pipsToTP1(trade);

                        return (
                            <div key={trade.id} className={`active-trade-card ${trade.action.toLowerCase()}`}>
                                <div className="trade-header">
                                    <span className="action">{trade.action}</span>
                                    <span className={`pnl ${pnl >= 0 ? 'profit' : 'loss'}`}>
                                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                                        <span style={{ fontSize: '0.75em', marginLeft: '4px', opacity: 0.8 }}>
                                            ({pips >= 0 ? '+' : ''}{pips.toFixed(1)} pips)
                                        </span>
                                    </span>
                                </div>
                                <div className="trade-details">
                                    <p><strong>Entry:</strong> ${trade.entry_price?.toFixed(2)}</p>
                                    <p><strong>Live:</strong> ${currentPrice.toFixed(2)}</p>
                                    <p><strong>Remaining:</strong> {(remainingQuantity || 0).toFixed(4)} lot</p>
                                    <p>
                                        <strong>SL:</strong> ${trade.sl?.toFixed(2) || 'N/A'}
                                        {distanceSL !== null && (
                                            <span style={{ marginLeft: '6px', fontSize: '0.8em', color: distanceSL < 0 ? '#f87171' : '#10b981' }}>
                                                ({distanceSL.toFixed(1)} pips away)
                                            </span>
                                        )}
                                    </p>
                                    <p>
                                        <strong>TP1:</strong> ${trade.tp1?.toFixed(2) || 'N/A'}
                                        {distanceTP1 !== null && (
                                            <span style={{ marginLeft: '6px', fontSize: '0.8em', color: distanceTP1 > 0 ? '#10b981' : '#f87171' }}>
                                                ({distanceTP1.toFixed(1)} pips away)
                                            </span>
                                        )}
                                    </p>
                                    <p><strong>TP2:</strong> ${trade.tp2?.toFixed(2) || 'N/A'}</p>
                                    {tp1Hit ? (
                                        <p style={{ color: '#10b981', fontWeight: 700 }}>
                                            TP1: Partial booked — SL moved to BE
                                        </p>
                                    ) : null}
                                </div>
                                <div className="trade-actions">
                                    <div className="partial-close-wrapper">
                                        <button
                                            className="btn-partial"
                                            onClick={() => setShowPartialMenu(showPartialMenu === trade.id ? null : trade.id)}
                                            disabled={partialId === trade.id || exitingId === trade.id || tp1Hit}
                                            title={tp1Hit ? 'TP1 already partially closed' : 'Partial close a portion'}
                                        >
                                            {partialId === trade.id ? '...' : '25% / 50%'}
                                        </button>
                                        {showPartialMenu === trade.id && (
                                            <div className="partial-close-menu">
                                                <button onClick={() => handlePartialClose(trade.id, 25)}>Close 25%</button>
                                                <button onClick={() => handlePartialClose(trade.id, 50)}>Close 50%</button>
                                                <button onClick={() => handlePartialClose(trade.id, 75)}>Close 75%</button>
                                                <button onClick={() => handlePartialClose(trade.id, 100)}>Close 100%</button>
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        className="btn-exit"
                                        onClick={() => handleExit(trade.id)}
                                        disabled={exitingId === trade.id || partialId === trade.id}
                                    >
                                        {exitingId === trade.id ? 'EXITING...' : 'EXIT ALL'}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default ActiveTrades;
