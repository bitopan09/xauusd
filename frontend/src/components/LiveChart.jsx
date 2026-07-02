import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, CandlestickSeries, createSeriesMarkers } from 'lightweight-charts';
import { fetchCandles, fetchActiveTrades, createPriceWebSocket, KLINE_INTERVAL_SEC } from '../services/api';

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

const TIMEFRAMES = [
    { label: '6H', key: '6H' },
    { label: '5m', key: '5min' },
    { label: '1m', key: '1min' },
];

const BINANCE_INTERVAL = { '6H': '6h', '5min': '5m', '1min': '1m' };

const LiveChart = ({ focusMode = false, onToggleFocus }) => {
    const containerRef = useRef(null);
    const chartRef = useRef(null);
    const seriesRef = useRef(null);
    const markersPluginRef = useRef(null);
    const wsRef = useRef(null);
    const resizeRef = useRef(null);
    const [activeTF, setActiveTF] = useState('6H');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [connected, setConnected] = useState(false);

    const sessionState = getSessionState();

    const buildMarkers = useCallback((trades) => {
        if (!trades || trades.length === 0) return [];
        const markers = [];
        for (const t of trades) {
            if (!t.entry_price) continue;
            const time = Math.floor(new Date(t.created_at || t.opened_at || Date.now()).getTime() / 1000);
            const isBuy = t.action === 'BUY';
            markers.push({
                time,
                position: isBuy ? 'belowBar' : 'aboveBar',
                color: isBuy ? '#22c55e' : '#ef4444',
                shape: isBuy ? 'arrowUp' : 'arrowDown',
                text: t.action,
            });
        }
        return markers.sort((a, b) => a.time - b.time);
    }, []);

    const updatePriceLines = useCallback((series, trades) => {
        if (!series || !trades) return;
        const lines = series.priceLines?.() || [];
        for (const line of lines) {
            series.removePriceLine(line);
        }
        for (const t of trades) {
            if (t.sl) {
                series.createPriceLine({
                    price: t.sl,
                    color: '#ef4444',
                    lineWidth: 1,
                    lineStyle: 2,
                    axisLabelVisible: true,
                    title: `SL ${t.action}`,
                });
            }
            if (t.tp1) {
                series.createPriceLine({
                    price: t.tp1,
                    color: '#22c55e',
                    lineWidth: 1,
                    lineStyle: 2,
                    axisLabelVisible: true,
                    title: 'TP1',
                });
            }
            if (t.tp2) {
                series.createPriceLine({
                    price: t.tp2,
                    color: '#10b981',
                    lineWidth: 1,
                    lineStyle: 2,
                    axisLabelVisible: true,
                    title: 'TP2',
                });
            }
        }
    }, []);

    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: 'rgba(0, 0, 0, 0)' },
                textColor: '#8a8f98',
                fontSize: 12,
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.035)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.035)' },
            },
            crosshair: {
                vertLine: { color: 'rgba(212, 175, 55, 0.4)', width: 1, style: 2, labelBackgroundColor: '#d4af37' },
                horzLine: { color: 'rgba(212, 175, 55, 0.4)', width: 1, style: 2, labelBackgroundColor: '#d4af37' },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
                borderColor: 'rgba(255, 255, 255, 0.08)',
            },
            rightPriceScale: {
                borderColor: 'rgba(255, 255, 255, 0.08)',
            },
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: '#22c55e',
            downColor: '#ef4444',
            borderUpColor: '#22c55e',
            borderDownColor: '#ef4444',
            wickUpColor: '#22c55e',
            wickDownColor: '#ef4444',
        });

        chartRef.current = chart;
        seriesRef.current = series;
        markersPluginRef.current = createSeriesMarkers(series);

        resizeRef.current = new ResizeObserver(() => {
            if (chartRef.current && containerRef.current) {
                chartRef.current.applyOptions({
                    width: containerRef.current.clientWidth,
                    height: containerRef.current.clientHeight,
                });
            }
        });
        resizeRef.current.observe(containerRef.current);

        return () => {
            if (resizeRef.current) resizeRef.current.disconnect();
            if (chartRef.current) {
                chartRef.current.remove();
                chartRef.current = null;
                seriesRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!seriesRef.current) return;
        let cancelled = false;

        const load = async () => {
            setLoading(true);
            setError(null);
            try {
                const limit = activeTF === '6H' ? 200 : activeTF === '5min' ? 500 : 500;
                const candles = await fetchCandles(activeTF, limit);
                if (cancelled) return;
                seriesRef.current.setData(candles);
                chartRef.current?.timeScale().fitContent();
                setLoading(false);

                try {
                    const trades = await fetchActiveTrades();
                    if (cancelled || !trades) return;
                    const markers = buildMarkers(trades);
                    if (markersPluginRef.current) {
                        markersPluginRef.current.setMarkers(markers);
                    }
                    updatePriceLines(seriesRef.current, trades);
                } catch {
                    // trades load is optional
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err.message || 'Failed to load candles');
                    setLoading(false);
                }
            }
        };

        load();
        return () => { cancelled = true; };
    }, [activeTF, buildMarkers, updatePriceLines]);

    // Real-time kline updates from Binance via server WebSocket relay
    useEffect(() => {
        if (!seriesRef.current) return;

        const klineInterval = BINANCE_INTERVAL[activeTF] || '6h';

        const ws = createPriceWebSocket((msg) => {
            if (msg.type === 'kline' && msg.data) {
                const k = msg.data;
                if (k.interval !== klineInterval) return;

                setConnected(true);
                const series = seriesRef.current;
                if (!series) return;
                const lastData = series.data?.();
                if (!lastData || lastData.length === 0) return;

                const candleTime = k.time;
                const lastCandle = lastData[lastData.length - 1];

                if (k.isFinal) {
                    if (candleTime >= lastCandle.time) {
                        series.update({
                            time: candleTime,
                            open: k.open,
                            high: k.high,
                            low: k.low,
                            close: k.close,
                        });
                    }
                } else {
                    if (candleTime === lastCandle.time) {
                        series.update({
                            time: candleTime,
                            open: lastCandle.open,
                            high: Math.max(lastCandle.high, k.high),
                            low: Math.min(lastCandle.low, k.low),
                            close: k.close,
                        });
                    } else if (candleTime > lastCandle.time) {
                        series.update({
                            time: candleTime,
                            open: k.open,
                            high: k.high,
                            low: k.low,
                            close: k.close,
                        });
                    }
                }
            }
            // Use ticker price to keep forming candle accurate in real-time
            if (msg.type === 'price' && msg.data && msg.data.price) {
                setConnected(true);
                const series = seriesRef.current;
                if (!series) return;
                const lastData = series.data?.();
                if (!lastData || lastData.length === 0) return;
                const lastCandle = lastData[lastData.length - 1];
                const now = Math.floor(Date.now() / 1000);
                const intervalSec = KLINE_INTERVAL_SEC[activeTF] || 21600;
                // Only update if the last candle is the forming one (within current interval window)
                const currentCandleStart = Math.floor(now / intervalSec) * intervalSec;
                if (lastCandle.time === currentCandleStart || lastCandle.time >= currentCandleStart - intervalSec) {
                    series.update({
                        time: lastCandle.time,
                        open: lastCandle.open,
                        high: Math.max(lastCandle.high, msg.data.price),
                        low: Math.min(lastCandle.low, msg.data.price),
                        close: msg.data.price,
                    });
                }
            }
        });

        wsRef.current = ws;
        return () => {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [activeTF]);

    return (
        <section className={`chart-container chart-hero-card ${focusMode ? 'chart-focus-active' : ''}`}>
            <div className="live-chart-header">
                <div>
                    <h2>XAU/USD</h2>
                    <div className="live-chart-source">
                        <span className={`live-source-dot ${connected ? 'connected' : 'disconnected'}`}></span>
                        <span>Binance WS{activeTF !== '6H' ? ` ${activeTF}` : ''}</span>
                        <span className={`session-pill ${sessionState.state}`}>{sessionState.label}</span>
                    </div>
                </div>
                <div className="chart-toolbar">
                    <div className="timeframe-tabs">
                        {TIMEFRAMES.map(tf => (
                            <button
                                key={tf.key}
                                className={`tf-btn ${activeTF === tf.key ? 'active' : ''}`}
                                onClick={() => setActiveTF(tf.key)}
                            >
                                {tf.label}
                            </button>
                        ))}
                    </div>
                    {onToggleFocus && (
                        <button type="button" onClick={onToggleFocus} className={`chart-focus-btn ${focusMode ? 'active' : ''}`}>
                            {focusMode ? 'Exit Focus' : 'Focus'}
                        </button>
                    )}
                </div>
            </div>

            <div className="live-chart-shell">
                <div ref={containerRef} className="live-chart-wrap" style={{ minHeight: '400px' }} />
                {loading && (
                    <div className="chart-loading-overlay">
                        <span>Loading {activeTF} candles...</span>
                    </div>
                )}
                {error && (
                    <div className="chart-error-overlay">
                        <span>{error}</span>
                    </div>
                )}
            </div>
        </section>
    );
};

export default LiveChart;
