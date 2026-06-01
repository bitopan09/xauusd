import React, { useState, useEffect } from 'react';
import { fetchBalance, fetchPrice, userId } from '../services/api';

const BalanceTracker = () => {
    const [balanceData, setBalanceData] = useState(null);
    const [currentPrice, setCurrentPrice] = useState(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                if (loading) setLoading(true);
                const [balance, price] = await Promise.all([
                    fetchBalance(),
                    fetchPrice()
                ]);
                setBalanceData(balance);
                setCurrentPrice(price.price || 0);
                setLoading(false);
            } catch (error) {
                console.error('Error fetching balance data:', error);
                setLoading(false);
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 10000);
        return () => clearInterval(interval);
    }, []);

    if (loading && !balanceData) {
        return (
            <div className="balance-container">
                <h2>Balance Tracker</h2>
                <p>Loading balance data...</p>
            </div>
        );
    }

    if (!balanceData) {
        return (
            <div className="balance-container">
                <h2>Balance Tracker</h2>
                <p>No balance data available</p>
            </div>
        );
    }

    const { usd_balance, xau_balance } = balanceData;
    const totalValue = usd_balance + ((xau_balance || 0) * currentPrice);

    return (
        <div className="balance-container">
            <h2>Balance Tracker</h2>
            <div className="user-id-small" style={{ fontSize: '0.75em', color: '#64748b', marginBottom: '10px' }}>
                User: {userId.substring(0, 12)}...
            </div>
            <div className="balance-details">
                <div className="balance-item">
                    <h3>USD Balance</h3>
                    <p>${usd_balance.toFixed(2)}</p>
                </div>
                <div className="balance-item">
                    <h3>Gold Balance</h3>
                    <p>{(xau_balance || 0).toFixed(4)} oz</p>
                </div>
                <div className="balance-item">
                    <h3>Total Value (USD)</h3>
                    <p>${totalValue.toFixed(2)}</p>
                    <span>Based on XAU @ ${currentPrice.toLocaleString()}</span>
                </div>
            </div>
        </div>
    );
};

export default BalanceTracker;
