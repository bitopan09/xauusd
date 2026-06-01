import React, { useState } from 'react';
import { manualTrade, userId } from '../services/api';

const ManualTrade = () => {
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [messageType, setMessageType] = useState('');

    const handleTrade = async (action) => {
        setLoading(true);
        setMessage('');
        setMessageType('');
        try {
            const result = await manualTrade(action, 0.01); // Fixed 0.01 lot
            setMessageType('success');
            setMessage(result.message || `Successfully executed ${action} at ${result.trade?.entry_price?.toFixed(2)}`);
        } catch (error) {
            setMessageType('error');
            setMessage(error.error || error.reason || `Failed to execute ${action}`);
        } finally {
            setLoading(false);
            setTimeout(() => setMessage(''), 4000);
        }
    };

    return (
        <div className="manual-trade-container">
            <h2>Paper Trade (User: {userId.substring(0, 12)}...)</h2>
            <div className="trade-controls">
                <div className="input-group">
                    <label>Quantity (Fixed)</label>
                    <input 
                        type="text" 
                        value="0.01 oz Gold"
                        disabled
                        style={{ opacity: 0.7, cursor: 'not-allowed' }}
                    />
                </div>
                <div className="action-buttons">
                    <button 
                        className="btn-buy" 
                        onClick={() => handleTrade('BUY')}
                        disabled={loading}
                    >
                        {loading ? 'Processing...' : 'BUY GOLD'}
                    </button>
                    <button 
                        className="btn-sell" 
                        onClick={() => handleTrade('SELL')}
                        disabled={loading}
                    >
                        {loading ? 'Processing...' : 'SELL GOLD'}
                    </button>
                </div>
            </div>
            {message && <div className={`trade-message ${messageType}`}>{message}</div>}
        </div>
    );
};

export default ManualTrade;
