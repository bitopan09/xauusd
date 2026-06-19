import React, { useEffect, useRef, useState } from 'react';
import {
    CandlestickSeries,
    createChart
} from 'lightweight-charts';
import { createPriceWebSocket } from '../services/api';

const TIMEFRAMES = [
    { label: '1m', interval: '1', seconds: 60, limit: 220 },
    { label: '5m', interval: '5', seconds: 300, limit: 220 },
    { label: '15m', interval: '15', seconds: 900, limit: 200 },
    { label: '1h', interval: '60', seconds: 3600, limit: 180 },
    { label: '6h', interval: '360', seconds: 21600, limit: 160 }
];

const formatIst = (timestamp) => new Date(timestamp).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
});

const toChartTime = (timestampMs) => Math.floor(Number(timestampMs) / 1000);

const bucketTime = (timestampMs, timeframe) => {
    const seconds = Math.floor(Number(timestampMs) / 1000);
    return Math.floor(seconds / timeframe.seconds) * timeframe.seconds;
};

const normalizeBybitCandle = (k) => ({
    time: toChartTime(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5] || 0)
});

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
    const chartRef = useRef(null);
    const candleSeriesRef = useRef(null);
    const candlesRef = useRef([]);
    const liveFollowRef = useRef(true);
    const uiFrameRef = useRef(null);
    const pendingUiRef = useRef(null);
    const lastTickTimeRef = useRef(null);
    const wsConnectedRef = useRef(false);

    const [timeframe, setTimeframe] = useState(TIMEFRAMES[4]);
    const [candles, setCandles] = useState([]);
    const [ohlc, setOhlc] = useState(null);
    const [currentPrice, setCurrentPrice] = useState(null);
    const [liveFollow, setLiveFollow] = useState(true);
    const [hoveredCandle, setHoveredCandle] = useState(null);
    const [latencyMs, setLatencyMs] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [candleFresh, setCandleFresh] = useState(true);
    const [wsConnected, setWsConnected] = useState(false);
    const [lastTickAge, setLastTickAge] = useState(null);

    useEffect(() => {
        liveFollowRef.current = liveFollow;
    }, [liveFollow]);

    useEffect(() => {
        chartRef.current?.applyOptions({
            timeScale: {
                timeVisible: true,
                secondsVisible: timeframe.seconds <= 300
            }
        });
    }, [timeframe]);

    useEffect(() => {
        if (!containerRef.current) return undefined;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: 'transparent' },
                textColor: '#cbd5e1',
                fontFamily: 'JetBrains Mono, monospace'
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.035)' },
                horzLines: { color: 'rgba(255,255,255,0.035)' }
            },
            crosshair: { mode: 1 },
            rightPriceScale: {
                borderColor: 'rgba(255,255,255,0.08)',
                scaleMargins: { top: 0.08, bottom: 0.2 }
            },
            timeScale: {
                borderColor: 'rgba(255,255,255,0.08)',
                timeVisible: true,
                secondsVisible: timeframe.seconds <= 300,
                rightOffset: 8,
                barSpacing: 8
            },
            handleScroll: true,
            handleScale: true,
            autoSize: true
        });

        const candleSeries = chart.addSeries(CandlestickSeries, {
            upColor: '#f8fafc',
            downColor: '#4f6bff',
            borderUpColor: '#f8fafc',
            borderDownColor: '#86a0ff',
            wickUpColor: '#fef3c7',
            wickDownColor: '#86a0ff',
            priceLineColor: '#ffffff',
            priceLineWidth: 2,
            lastValueVisible: true
        });

        const handleCrosshairMove = (param) => {
            if (!param?.time) {
                setHoveredCandle(null);
                return;
            }

            const candle = param.seriesData.get(candleSeries);
            if (!candle) {
                setHoveredCandle(null);
                return;
            }

            setHoveredCandle(candle);
        };

        chart.subscribeCrosshairMove(handleCrosshairMove);

        chartRef.current = chart;
        candleSeriesRef.current = candleSeries;

        const resize = () => {
            if (!containerRef.current) return;
            chart.applyOptions({ width: containerRef.current.clientWidth });
        };

        window.addEventListener('resize', resize);

        return () => {
            window.removeEventListener('resize', resize);
            chart.unsubscribeCrosshairMove(handleCrosshairMove);
            if (uiFrameRef.current) cancelAnimationFrame(uiFrameRef.current);
            chart.remove();
            chartRef.current = null;
            candleSeriesRef.current = null;
            uiFrameRef.current = null;
        };
    }, []);

    useEffect(() => {
        const loadCandles = async () => {
            setLoading(true);
            setError(null);

            try {
                const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=${timeframe.interval}&limit=${timeframe.limit}`;
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Bybit returned ${response.status}`);

                const json = await response.json();
                if (!json || json.retCode !== 0 || !json.result?.list?.length) {
                    throw new Error('No XAU candle data returned');
                }

                const nextCandles = json.result.list
                    .map(normalizeBybitCandle)
                    .sort((a, b) => a.time - b.time);

                candlesRef.current = nextCandles;
                setCandles(nextCandles);
                setOhlc(nextCandles[nextCandles.length - 1]);
                setCurrentPrice(nextCandles[nextCandles.length - 1].close);

                candleSeriesRef.current?.setData(nextCandles.map(({ volume, ...candle }) => candle));
                chartRef.current?.timeScale().fitContent();
            } catch (err) {
                setError(err.message || 'Failed to load XAU candles');
            } finally {
                setLoading(false);
            }
        };

        loadCandles();
    }, [timeframe]);

    useEffect(() => {
        const ws = createPriceWebSocket((msg) => {
            const payload = msg.type === 'price' ? msg.data : msg;
            const price = Number(payload?.price);
            if (!Number.isFinite(price)) return;

            lastTickTimeRef.current = Date.now();
            wsConnectedRef.current = true;
            setWsConnected(true);

            const timestampMs = payload.timestamp ? new Date(payload.timestamp).getTime() : Date.now();
            const latency = Number.isFinite(timestampMs) ? Math.max(0, Date.now() - timestampMs) : null;
            const time = bucketTime(timestampMs, timeframe);
            const existing = candlesRef.current[candlesRef.current.length - 1];
            let nextCandle;
            let isNewCandle = false;

            if (existing && existing.time === time) {
                nextCandle = {
                    ...existing,
                    high: Math.max(existing.high, price),
                    low: Math.min(existing.low, price),
                    close: price
                };
                candlesRef.current = [...candlesRef.current.slice(0, -1), nextCandle];
            } else {
                nextCandle = {
                    time,
                    open: existing?.close || price,
                    high: price,
                    low: price,
                    close: price,
                    volume: 0
                };
                candlesRef.current = [...candlesRef.current, nextCandle].slice(-timeframe.limit);
                isNewCandle = true;
            }

            candleSeriesRef.current?.update({
                time: nextCandle.time,
                open: nextCandle.open,
                high: nextCandle.high,
                low: nextCandle.low,
                close: nextCandle.close
            });
            pendingUiRef.current = { nextCandle, price, latency, isNewCandle };
            if (!uiFrameRef.current) {
                uiFrameRef.current = requestAnimationFrame(() => {
                    const pending = pendingUiRef.current;
                    if (pending) {
                        setOhlc(pending.nextCandle);
                        setCurrentPrice(pending.price);
                        setLatencyMs(pending.latency);
                        if (pending.isNewCandle) setCandles(candlesRef.current);
                    }
                    uiFrameRef.current = null;
                });
            }

            if (liveFollowRef.current) {
                chartRef.current?.timeScale().scrollToRealTime();
            }
        });

        return () => ws.close();
    }, [timeframe]);

    // Staleness checker — runs every 1s, flags candle as stale if no tick in 30s
    useEffect(() => {
        const checkStaleness = () => {
            if (!lastTickTimeRef.current) {
                setCandleFresh(false);
                setLastTickAge(null);
                return;
            }
            const ageMs = Date.now() - lastTickTimeRef.current;
            const ageSec = Math.floor(ageMs / 1000);
            setLastTickAge(ageSec);
            setCandleFresh(ageSec < 30);
        };

        checkStaleness();
        const interval = setInterval(checkStaleness, 1000);
        return () => clearInterval(interval);
    }, []);

    const resetChart = () => {
        chartRef.current?.timeScale().fitContent();
    };

    const latestTime = candles.length > 0 ? candles[candles.length - 1].time * 1000 : null;
    const displayCandle = hoveredCandle || ohlc;
    const displayTime = displayCandle ? displayCandle.time * 1000 : latestTime;
    const change = displayCandle ? displayCandle.close - displayCandle.open : 0;
    const changePct = displayCandle && displayCandle.open ? (change / displayCandle.open) * 100 : 0;
    const range = displayCandle ? displayCandle.high - displayCandle.low : 0;
    const body = displayCandle ? Math.abs(displayCandle.close - displayCandle.open) : 0;
    const sessionState = getSessionState();

    return (
        <section className={`chart-container chart-hero-card ${focusMode ? 'chart-focus-active' : ''}`}>
            <div className="live-chart-header">
                <div>
                    <h2>XAU/USD {timeframe.label.toUpperCase()}</h2>
                    <div className="live-chart-source">
                        <span className={`live-source-dot ${wsConnected ? 'connected' : 'disconnected'}`}></span>
                        <span>{wsConnected ? 'Bybit Live' : 'Connecting...'}</span>
                        {displayTime && <span>{formatIst(displayTime)} IST</span>}
                        <span>{hoveredCandle ? 'Crosshair' : 'Latest'}</span>
                        <span className={`freshness-pill ${candleFresh ? 'fresh' : 'stale'}`}>
                            {candleFresh ? '● LIVE' : `● STALE${lastTickAge !== null ? ` ${lastTickAge}s` : ''}`}
                        </span>
                        <span className={`session-pill ${sessionState.state}`}>{sessionState.label}</span>
                    </div>
                </div>
                <div className="chart-toolbar">
                    <div className="timeframe-tabs">
                        {TIMEFRAMES.map(item => (
                            <button
                                key={item.label}
                                type="button"
                                className={item.label === timeframe.label ? 'active' : ''}
                                onClick={() => setTimeframe(item)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <div className="chart-actions">
                        <button type="button" onClick={() => setLiveFollow(prev => !prev)} className={liveFollow ? 'active' : ''}>
                            {liveFollow ? 'Live On' : 'Live Off'}
                        </button>
                        <button type="button" onClick={resetChart}>Reset</button>
                        {onToggleFocus && (
                            <button type="button" onClick={onToggleFocus} className={focusMode ? 'active' : ''}>
                                {focusMode ? 'Exit Focus' : 'Focus'}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="market-strip">
                <div>
                    <span>{displayTime ? formatIst(displayTime) : 'Loading'} IST</span>
                </div>
                <div>
                    <span>O</span>
                    <strong>${displayCandle ? displayCandle.open.toFixed(2) : '...'}</strong>
                </div>
                <div>
                    <span>H</span>
                    <strong>${displayCandle ? displayCandle.high.toFixed(2) : '...'}</strong>
                </div>
                <div>
                    <span>L</span>
                    <strong>${displayCandle ? displayCandle.low.toFixed(2) : '...'}</strong>
                </div>
                <div>
                    <span>C</span>
                    <strong>${displayCandle ? displayCandle.close.toFixed(2) : '...'}</strong>
                </div>
            </div>

            <div className="live-chart-shell">
                {loading && <div className="chart-loading-overlay">Loading XAU candles...</div>}
                {error && <div className="chart-error-overlay">{error}</div>}
                <div ref={containerRef} className="live-chart-wrap" />
            </div>

            <div className="chart-info chart-info-terminal">
                <p>Timeframe: <strong>{timeframe.label}</strong></p>
                <p>Last Price: <strong>${currentPrice ? currentPrice.toFixed(2) : '...'}</strong></p>
                <p>Change: <strong>{change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePct.toFixed(2)}%)</strong></p>
                <p>Range / Body: <strong>${range.toFixed(2)} / ${body.toFixed(2)}</strong></p>
                <p>Latency: <strong>{latencyMs === null ? '...' : `${latencyMs}ms`}</strong></p>
            </div>
        </section>
    );
};

export default LiveChart;
