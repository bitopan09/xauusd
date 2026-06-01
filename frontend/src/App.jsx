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
        <div className="App">
            <header className="app-header">
                <div className="header-brand">
                    <div className="header-logo">GF</div>
                    <div>
                        <div className="header-title">GoldForge</div>
                        <div className="header-subtitle">XAU/USD Automated Terminal</div>
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
                    <div style={{ fontSize: '11px', color: '#94a3b8', minWidth: '140px', textAlign: 'right' }}>
                        User: {userId.substring(5, 17)}...
                    </div>
                </div>
            </header>

            <main>
                <div className="dashboard-grid">
                    <div className="grid-left-column">
                        <LiveChart />
                        <BotStatus />
                        <ActiveTrades />
                        <ManualTrade />
                    </div>
                    <div className="grid-right-column">
                        <BalanceTracker />
                        <Backtester />
                    </div>
                </div>
                <div className="full-width-panel">
                    <TradeJournal />
                </div>
            </main>
        </div>
    );
}

export default App;
