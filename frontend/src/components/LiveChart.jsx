import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { createPriceWebSocket, API_BASE_URL } from '../services/api';

const LiveChart = () => {
    const [priceData, setPriceData] = useState([]);
    const [ws, setWs] = useState(null);

    useEffect(() => {
        const ws = createPriceWebSocket((msg) => {
            const payload = msg.type === 'price' ? msg.data : msg;
            if (!payload || !payload.price) return;

            const newPoint = {
                time: new Date(payload.timestamp || Date.now()),
                price: payload.price
            };

            setPriceData(prev => {
                const updated = [...prev, newPoint];
                return updated.length > 50 ? updated.slice(-50) : updated;
            });
        });

        setWs(ws);

        const fetchInitialData = async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/prices?limit=50`);
                if (response.ok) {
                    const data = await response.json();
                    setPriceData(
                        data.map(item => ({
                            time: new Date(item.timestamp),
                            price: item.price
                        }))
                    );
                }
            } catch (error) {
                console.error('Error fetching initial gold price data:', error);
            }
        };

        fetchInitialData();

        return () => {
            if (ws) ws.close();
        };
    }, []);

    const chartData = priceData.map(point => ({
        time: point.time.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        price: point.price
    }));

    return (
        <div className="chart-container">
            <h2>Live XAU/USD Gold Chart</h2>
            <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(212,175,55,0.06)" />
                    <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 11, fill: '#64748b' }} />
                    <YAxis stroke="#64748b" tick={{ fontSize: 11, fill: '#94a3b8' }} domain={['auto', 'auto']} />
                    <Tooltip
                        contentStyle={{ background: 'rgba(10,11,16,0.95)', border: '1px solid rgba(212,175,55,0.3)', borderRadius: '10px', color: '#f1f5f9', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px' }}
                        labelStyle={{ color: '#94a3b8' }}
                    />
                    <Line type="monotone" dataKey="price" stroke="#d4af37" strokeWidth={2} dot={false} activeDot={{ r: 5, fill: '#ffd700', stroke: '#0a0b10', strokeWidth: 2 }} />
                </LineChart>
            </ResponsiveContainer>
            <div className="chart-info">
                <p>Gold Price: ${priceData.length > 0 ? priceData[priceData.length - 1].price.toFixed(2) : 'Loading...'}</p>
                <p>Last updated: {priceData.length > 0 ? new Date(priceData[priceData.length - 1].time).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '...'}</p>
                <p>Data Points: {priceData.length}</p>
            </div>
        </div>
    );
};

export default LiveChart;
