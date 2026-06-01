import React, { useState, useEffect } from 'react';
import { fetchActiveTrades, closeTrade, createPriceWebSocket } from '../services/api';

const ActiveTrades = () => {
    const [trades, setTrades] = useState([]);
    const [currentPrice, setCurrentPrice] = useState(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadTrades = async () => {
            try {
                const data = await fetchActiveTrades();
                setTrades(data);
            } catch (error) {
                console.error('Failed to fetch active trades', error);
            } finally {
                setLoading(false);
            }
        };

        loadTrades();
        
        const ws = createPriceWebSocket((message) => {
            if (message.type === 'price') {
                setCurrentPrice(message.data.price);
            }
        });

        const interval = setInterval(loadTrades, 5000);
        
        return () => {
            clearInterval(interval);
            ws.close();
        };
    }, []);

    const handleExit = async (id) => {
        try {
            await closeTrade(id);
            setTrades(prev => prev.filter(t => t.id !== id));
        } catch (error) {
            alert('Failed to exit trade: ' + (error.error || error.message));
        }
    };

    const calculatePnL = (trade) => {
        if (!currentPrice) return 0;
        const CONTRACT_SIZE = 100; // 1 lot = 100 oz
        const positionSize = trade.quantity * CONTRACT_SIZE;
        if (trade.action === 'BUY') {
            return (currentPrice - trade.entry_price) * positionSize;
        } else {
            return (trade.entry_price - currentPrice) * positionSize;
        }
    };

    return (
        <div className="active-trades-container">
            <h2>Live Signals & Active Trades</h2>
            {loading ? (
                <p>Loading active trades...</p>
            ) : trades.length === 0 ? (
                <p>No active gold trades right now.</p>
            ) : (
                <div className="active-trades-grid">
                    {trades.map(trade => {
                        const pnl = calculatePnL(trade);
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
                                    <p><strong>SL:</strong> ${trade.sl?.toFixed(2) || 'N/A'}</p>
                                    <p><strong>TP:</strong> ${trade.tp1?.toFixed(2) || 'N/A'}</p>
                                </div>
                                <button 
                                    className="btn-exit" 
                                    onClick={() => handleExit(trade.id)}
                                >
                                    EXIT NOW
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
