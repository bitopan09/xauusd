import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { formatTimeIST } from '../utils/timeFormatter';
import { API_BASE_URL } from '../services/api';

const BotStatus = () => {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [emailTesting, setEmailTesting] = useState(false);
    const [emailMessage, setEmailMessage] = useState(null);

    const testEmail = async () => {
        setEmailTesting(true);
        setEmailMessage(null);
        try {
            await axios.post(`${API_BASE_URL}/email/test`);
            setEmailMessage({ type: 'success', text: 'Test email triggered successfully! Check your inbox.' });
        } catch (error) {
            setEmailMessage({ type: 'error', text: 'Failed to trigger test email.' });
        }
        setEmailTesting(false);
        setTimeout(() => setEmailMessage(null), 5000);
    };

    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const response = await axios.get(`${API_BASE_URL}/bot/status`);
                setStatus(response.data);
                setLoading(false);
            } catch (error) {
                console.error('Error fetching bot status:', error);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 10000);
        return () => clearInterval(interval);
    }, []);

    // Push Bybit candle data from browser to backend every 60s
    // This bypasses Bybit REST API being blocked on Railway's server IPs
    useEffect(() => {
        const pushCandles = async () => {
            try {
                const url = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=360&limit=200';
                const response = await fetch(url);
                if (!response.ok) return;
                const json = await response.json();
                if (!json || json.retCode !== 0 || !json.result?.list) return;

                await axios.post(`${API_BASE_URL}/bot/candles`, {
                    candles: json.result.list
                });
            } catch (err) {
                // Silent — the bot's own fetch may work on some hosts
            }
        };

        pushCandles();
        const interval = setInterval(pushCandles, 60000);
        return () => clearInterval(interval);
    }, []);

    if (loading || !status) return <div className="bot-status-container">Loading bot status...</div>;

    const { bot, todayTrade } = status;

    return (
        <div className="bot-status-container">
            <h2>Today's Gold Activity</h2>
            <div className="status-grid">
                <div className="status-card">
                    <p><strong>Bot Status:</strong> <span className={bot.isRunning ? 'status-online' : 'status-offline'}>{bot.isRunning ? '🟡 ONLINE' : '🔴 OFFLINE'}</span></p>
                    <p><strong>Daily Trade Taken:</strong> {bot.dailyTradeTaken ? '✅ Yes' : '❌ No'}</p>
                    <p><strong>Live Confluence:</strong> {bot.currentScore}/10 
                        <span style={{ fontSize: '0.8rem', marginLeft: '8px', color: bot.currentSignal === 'NEUTRAL' ? '#94a3b8' : (bot.currentSignal === 'BUY' ? '#4ade80' : '#f87171') }}>
                            ({bot.currentSignal})
                        </span>
                    </p>
                    
                    {bot.lastAnalysisTime && (
                        <p style={{ fontSize: '0.8rem', marginTop: '8px', color: '#cbd5e0' }}>
                            Last Analysis: {formatTimeIST(bot.lastAnalysisTime, 'date-time')} IST
                        </p>
                    )}
                    
                    <button 
                        onClick={testEmail} 
                        disabled={emailTesting}
                        style={{ marginTop: '12px', padding: '6px 12px', background: '#d4af37', color: '#0a0b10', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}
                    >
                        {emailTesting ? 'Sending...' : 'Test Email Alert'}
                    </button>
                    {emailMessage && (
                        <p style={{ fontSize: '0.8rem', marginTop: '6px', color: emailMessage.type === 'success' ? '#4ade80' : '#f87171' }}>
                            {emailMessage.text}
                        </p>
                    )}
                </div>
                
                <div className="today-trade-card">
                    <h4 style={{ margin: '0 0 8px 0', color: '#e2e8f0' }}>Today's Single Trade</h4>
                    {todayTrade ? (
                        <div className={`mini-trade-details ${todayTrade.action.toLowerCase()}`}>
                            <p><strong>{todayTrade.action}</strong> at ${todayTrade.entry_price.toFixed(2)}</p>
                            <p>Status: <span className={`status-${todayTrade.status.toLowerCase()}`}>{todayTrade.status}</span></p>
                            {todayTrade.pnl !== null && <p>Result: <span className={todayTrade.pnl >= 0 ? 'profit' : 'loss'}>${todayTrade.pnl.toFixed(2)}</span></p>}
                            <p style={{ fontSize: '0.8rem', marginTop: '6px' }}>{formatTimeIST(todayTrade.timestamp, 'date-time')}</p>
                        </div>
                    ) : (
                        <p className="no-trade">No gold trade taken yet today.</p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default BotStatus;
