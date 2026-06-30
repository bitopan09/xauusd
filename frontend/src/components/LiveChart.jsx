import React, { useEffect, useRef, useState } from 'react';

const WIDGET_SCRIPT = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

const getSessionState = () => {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const open = 6 * 60;
    const close = 20 * 60;

    if (minutes >= open && minutes <= close) {
        return { label: 'Session Open', state: 'online' };
    }

    return { label: 'Outside Session', state: 'offline' };
};

const LiveChart = ({ focusMode = false, onToggleFocus }) => {
    const containerRef = useRef(null);
    const widgetRef = useRef(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        if (!containerRef.current || loaded) return;

        const config = {
            autosize: true,
            symbol: 'OANDA:XAUUSD',
            interval: '240',
            timezone: 'Etc/UTC',
            theme: 'dark',
            style: '1',
            locale: 'en',
            backgroundColor: 'rgba(0, 0, 0, 0)',
            gridColor: 'rgba(255, 255, 255, 0.035)',
            hide_top_toolbar: false,
            hide_legend: false,
            save_image: false,
            calendar: false,
            hide_volume: true,
            support_host: 'https://www.tradingview.com'
        };

        const script = document.createElement('script');
        script.src = WIDGET_SCRIPT;
        script.type = 'text/javascript';
        script.async = true;
        script.innerHTML = JSON.stringify(config);

        containerRef.current.appendChild(script);
        widgetRef.current = script;
        setLoaded(true);

        return () => {
            if (widgetRef.current && containerRef.current) {
                containerRef.current.removeChild(widgetRef.current);
                widgetRef.current = null;
            }
        };
    }, []);

    const sessionState = getSessionState();

    return (
        <section className={`chart-container chart-hero-card ${focusMode ? 'chart-focus-active' : ''}`}>
            <div className="live-chart-header">
                <div>
                    <h2>XAU/USD</h2>
                    <div className="live-chart-source">
                        <span className="live-source-dot connected"></span>
                        <span>OANDA Real-Time</span>
                        <span className={`session-pill ${sessionState.state}`}>{sessionState.label}</span>
                    </div>
                </div>
                <div className="chart-toolbar">
                    {onToggleFocus && (
                        <button type="button" onClick={onToggleFocus} className={focusMode ? 'active' : ''}>
                            {focusMode ? 'Exit Focus' : 'Focus'}
                        </button>
                    )}
                </div>
            </div>

            <div className="live-chart-shell">
                <div
                    ref={containerRef}
                    className="tradingview-widget-container live-chart-wrap"
                    style={{ minHeight: '400px' }}
                />
            </div>
        </section>
    );
};

export default LiveChart;
