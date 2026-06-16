import React, { useState, useEffect } from 'react';
import { formatTimeIST } from '../utils/timeFormatter';
import { API_BASE_URL } from '../services/api';

const PUSH_INTERVAL = 60000;
const STATUS_INTERVAL = 10000;

const BotStatus = () => {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/bot/status`);
                if (!response.ok) throw new Error('Status fetch failed');
                const data = await response.json();
                setStatus(data);
            } catch (error) {
                // ignore polling errors
            } finally {
                setLoading(false);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, STATUS_INTERVAL);
        return () => clearInterval(interval);
    }, []);

    // Push Bybit candle data from browser to backend every 60s
    useEffect(() => {
        const pushCandles = async () => {
            try {
                const url = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=360&limit=200';
                const response = await fetch(url);
                if (!response.ok) return;
                const json = await response.json();
                if (!json || json.retCode !== 0 || !json.result?.list) return;

                await fetch(`${API_BASE_URL}/bot/candles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ candles: json.result.list })
                });
            } catch (err) {
                // Silent — the bot's own fetch may work on some hosts
            }
        };

        pushCandles();
        const interval = setInterval(pushCandles, PUSH_INTERVAL);
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
                    <p><strong>Candle Data:</strong> <span className={bot.candleStale ? 'status-offline' : 'status-online'}>{bot.candleStale ? 'STALE' : 'FRESH'}</span>{bot.candleSource ? ` (${bot.candleSource})` : ''}</p>
                    {bot.lastCandleTimestamp && (
                        <p style={{ fontSize: '0.8rem', color: '#cbd5e0' }}>
                            Last Candle: {formatTimeIST(bot.lastCandleTimestamp, 'date-time')} IST
                        </p>
                    )}

                    {bot.lastAnalysisTime && (
                        <p style={{ fontSize: '0.8rem', marginTop: '8px', color: '#cbd5e0' }}>
                            Last Analysis: {formatTimeIST(bot.lastAnalysisTime, 'date-time')} IST
                        </p>
                    )}
                    
                    {bot.filterBreakdown && (
                        <div className="signal-filter-details">
                            <h5 style={{ margin: '12px 0 6px', color: '#e2e8f0', fontSize: '0.85rem' }}>Signal Filter Breakdown</h5>
                            <table style={{ width: '100%', fontSize: '0.78rem', borderCollapse: 'collapse' }}>
                                <tbody>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>Score</td><td style={{ textAlign: 'right' }}>{bot.filterBreakdown.score.toFixed(1)}/{bot.filterBreakdown.threshold}</td></tr>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>Price</td><td style={{ textAlign: 'right' }}>${Number(bot.filterBreakdown.currentPrice).toFixed(2)}</td></tr>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>EMA9</td><td style={{ textAlign: 'right', color: bot.filterBreakdown.bullishEma ? '#4ade80' : '#f87171' }}>${Number(bot.filterBreakdown.ema9Val).toFixed(2)}</td></tr>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>EMA21</td><td style={{ textAlign: 'right', color: bot.filterBreakdown.bearishEma ? '#4ade80' : '#f87171' }}>${Number(bot.filterBreakdown.ema21Val).toFixed(2)}</td></tr>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>EMA50</td><td style={{ textAlign: 'right' }}>${Number(bot.filterBreakdown.ema50Val).toFixed(2)}</td></tr>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>Dir</td><td style={{ textAlign: 'right' }}>{bot.filterBreakdown.confluenceDirection}</td></tr>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>EMA9>21</td><td style={{ textAlign: 'right', color: bot.filterBreakdown.bullishEma ? '#4ade80' : '#94a3b8' }}>{bot.filterBreakdown.bullishEma ? 'YES' : 'NO'}</td></tr>
                                    <tr><td style={{ padding: '2px 4px', color: '#94a3b8' }}>Price>50</td><td style={{ textAlign: 'right', color: bot.filterBreakdown.bullishPrice ? '#4ade80' : '#94a3b8' }}>{bot.filterBreakdown.bullishPrice ? 'YES' : 'NO'}</td></tr>
                                </tbody>
                            </table>
                            {bot.filterBreakdown.rejectedReason && (
                                <p style={{ fontSize: '0.75rem', marginTop: '6px', color: '#fbbf24', lineHeight: '1.3' }}>
                                    ⚠ {bot.filterBreakdown.rejectedReason}
                                </p>
                            )}
                        </div>
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
