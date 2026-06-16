import React, { useState, useEffect } from 'react';
import './App.css';
import LiveChart from './components/LiveChart';
import BalanceTracker from './components/BalanceTracker';
import TradeJournal from './components/TradeJournal';
import Backtester from './components/Backtester';
import ManualTrade from './components/ManualTrade';
import ActiveTrades from './components/ActiveTrades';
import BotStatus from './components/BotStatus';
import { userId } from './services/api';

function App() {
    const [clock, setClock] = useState('');
    const [botOnline, setBotOnline] = useState(false);
    const [apiConnected, setApiConnected] = useState(false);
    const [chartFocus, setChartFocus] = useState(false);

    useEffect(() => {
        const tick = () => {
            setClock(new Date().toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false,
                day: 'numeric', month: 'short'
            }) + ' IST');
        };
        tick();
        const id = setInterval(tick, 1000);

        const checkAPI = async () => {
            try {
                const res = await fetch('/api/price');
                setApiConnected(res.ok);
            } catch { 
                setApiConnected(false); 
            }
        };

        const checkBot = async () => {
            try {
                const res = await fetch('/api/bot/status');
                const data = await res.json();
                setBotOnline(data.bot?.isRunning || false);
            } catch { setBotOnline(false); }
        };

        checkAPI();
        checkBot();
        const apiInterval = setInterval(checkAPI, 15000);
        const botInterval = setInterval(checkBot, 15000);

        return () => { 
            clearInterval(id); 
            clearInterval(apiInterval); 
            clearInterval(botInterval); 
        };
    }, []);

    return (
        <div className={`App ${chartFocus ? 'chart-focus-mode' : ''}`}>
            <header className="app-header">
                <div className="header-brand">
                    <div className="header-logo">
                        <img src="/goldforge-logo.svg" alt="GoldForge" />
                    </div>
                    <div>
                        <div className="header-title">GoldForge</div>
                        <div className="header-subtitle">XAU/USD Chart Trading Terminal</div>
                    </div>
                </div>
                <div className="header-right">
                    <div className="header-clock">{clock}</div>
                    <div className="header-status">
                        <span className={`status-dot ${apiConnected ? 'online' : 'offline'}`}></span>
                        <span style={{ color: apiConnected ? '#10b981' : '#ef4444', fontSize: '12px' }}>
                            {apiConnected ? 'API ✓' : 'API ✗'}
                        </span>
                    </div>
                    <div className="header-status">
                        <span className={`status-dot ${botOnline ? 'online' : 'offline'}`}></span>
                        <span style={{ color: botOnline ? '#d4af37' : '#ef4444' }}>
                            {botOnline ? 'BOT LIVE' : 'BOT OFF'}
                        </span>
                    </div>
                    <button
                        type="button"
                        className={`chart-focus-toggle ${chartFocus ? 'active' : ''}`}
                        onClick={() => setChartFocus(prev => !prev)}
                    >
                        {chartFocus ? 'Full Dashboard' : 'Chart Focus'}
                    </button>
                    <div className="terminal-header-pill">
                        <div className="terminal-header-avatar">G</div>
                        <div className="terminal-header-copy">
                            <span>Active Terminal</span>
                            <strong>{userId.substring(5, 17)}...</strong>
                        </div>
                    </div>
                </div>
            </header>

            <main className="terminal-main">
                {chartFocus ? (
                    <div className="chart-focus-stack">
                        <LiveChart focusMode={chartFocus} onToggleFocus={() => setChartFocus(prev => !prev)} />
                        <div className="chart-focus-graphs">
                            <Backtester />
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="terminal-template-layout">
                            <div className="terminal-chart-column">
                                <LiveChart focusMode={chartFocus} onToggleFocus={() => setChartFocus(prev => !prev)} />
                            </div>
                            <aside className="terminal-side-column">
                                <BalanceTracker />
                                <Backtester />
                            </aside>
                        </div>

                        <div className="terminal-lower-grid">
                            <BotStatus />
                            <ActiveTrades />
                            <ManualTrade />
                        </div>

                        <div className="full-width-panel">
                            <TradeJournal />
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}

export default App;
