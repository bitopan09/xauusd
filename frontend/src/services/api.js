import axios from 'axios';

// Get API URL from environment or use current location
let API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    API_BASE_URL = 'http://localhost:5002/api';
} else {
    API_BASE_URL = `${window.location.protocol}//${window.location.host}/api`;
}

// Get or create user session ID
const getOrCreateUserId = () => {
    let userId = localStorage.getItem('userId');
    if (!userId) {
        userId = 'user_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
        localStorage.setItem('userId', userId);
    }
    return userId;
};

const userId = getOrCreateUserId();

const withUserId = (data = {}) => ({ ...data, userId });

export { userId, API_BASE_URL, KLINE_INTERVAL_SEC };

export const fetchPrice = async () => {
    try {
        const response = await axios.get(`${API_BASE_URL}/price`);
        return response.data;
    } catch (error) {
        console.error('Error fetching gold price:', error);
        throw error;
    }
};

export const fetchPrices = async (limit = 100) => {
    try {
        const response = await axios.get(`${API_BASE_URL}/prices`, { params: { limit } });
        return response.data;
    } catch (error) {
        console.error('Error fetching gold prices:', error);
        throw error;
    }
};

export const fetchBalance = async () => {
    try {
        const response = await axios.get(`${API_BASE_URL}/balance`, { params: { userId } });
        return response.data;
    } catch (error) {
        console.error('Error fetching balance:', error);
        throw error;
    }
};

export const fetchTrades = async (limit = 50) => {
    try {
        const response = await axios.get(`${API_BASE_URL}/trades`, { params: { limit, userId } });
        return response.data;
    } catch (error) {
        console.error('Error fetching trades:', error);
        throw error;
    }
};

export const fetchActiveTrades = async () => {
    try {
        const response = await axios.get(`${API_BASE_URL}/trades/active`, { params: { userId } });
        return response.data;
    } catch (error) {
        console.error('Error fetching active trades:', error);
        throw error;
    }
};

export const manualTrade = async (action, quantity = 0.01) => {
    try {
        const response = await axios.post(`${API_BASE_URL}/manual-trade`, withUserId({ action, quantity }));
        return response.data;
    } catch (error) {
        console.error(`Error executing ${action} trade:`, error);
        throw error.response?.data || error;
    }
};

export const closeTrade = async (tradeId) => {
    try {
        const response = await axios.post(`${API_BASE_URL}/trades/${tradeId}/close`, withUserId());
        return response.data;
    } catch (error) {
        console.error(`Error closing trade ${tradeId}:`, error);
        throw error.response?.data || error;
    }
};

export const partialCloseTrade = async (tradeId, closePercent) => {
    try {
        const response = await axios.post(`${API_BASE_URL}/trades/${tradeId}/partial-close`, withUserId({ closePercent }));
        return response.data;
    } catch (error) {
        console.error(`Error partial closing trade ${tradeId}:`, error);
        throw error.response?.data || error;
    }
};

export const exportTradesCsvUrl = `${API_BASE_URL}/trades/export?userId=${userId}`;

export const recordTrade = async (tradeData) => {
    try {
        const response = await axios.post(`${API_BASE_URL}/trades`, withUserId(tradeData));
        return response.data;
    } catch (error) {
        console.error('Error recording trade:', error);
        throw error;
    }
};

export const fetchCandles = async (interval = '6H', limit = 200) => {
    const url = `${API_BASE_URL}/candles?interval=${interval}&limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Candles API: ${response.status}`);
    const json = await response.json();
    if (!json || !json.length) {
        throw new Error('No candle data from server');
    }
    // Server returns Lightweight Charts format already: { time, open, high, low, close }
    return json.sort((a, b) => a.time - b.time);
};


// Fetch latest ticker price from Bybit REST API
export const fetchTicker = async () => {
    const url = 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=XAUUSDT';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bybit ticker: ${response.status}`);
    const json = await response.json();
    if (json.retCode !== 0 || !json.result?.list?.length) {
        throw new Error('Bybit ticker returned no data');
    }
    const t = json.result.list[0];
    return {
        price: parseFloat(t.lastPrice),
        volume: parseFloat(t.turnover24h || 0),
        timestamp: Date.now(),
    };
};

// Polling-based live price source (Bybit REST fallback — works when WS is dead)
export const createPricePoller = (onPrice, intervalMs = 3000) => {
    let timer = null;
    let stopped = false;

    const poll = async () => {
        if (stopped) return;
        try {
            const data = await fetchTicker();
            if (!stopped && data.price) {
                onPrice({ type: 'price', data });
            }
        } catch {
            // silent — will retry next interval
        }
        if (!stopped) {
            timer = setTimeout(poll, intervalMs);
        }
    };

    poll();

    return {
        close: () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
    };
};

// WebSocket service for real-time price + kline updates with reconnection
export const createPriceWebSocket = (onMessage) => {
    let wsUrl;
    
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        wsUrl = 'ws://localhost:5002';
    } else {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}`;
    }

    let ws = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_DELAY = 30000;

    const connect = () => {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            reconnectAttempts = 0;
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // Forward all message types: 'price', 'kline'
                onMessage(data);
            } catch (error) {
                // Ignore parse errors (pong messages, etc.)
            }
        };

        ws.onclose = () => {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
            reconnectAttempts++;
            reconnectTimer = setTimeout(connect, delay);
        };

        ws.onerror = () => {
            // onclose will handle reconnection
        };
    };

    connect();

    return {
        close: () => {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (ws) ws.close();
        }
    };
};

// Kline interval seconds lookup
const KLINE_INTERVAL_SEC = {
    '6H': 21600,
    '5min': 300,
    '1min': 60,
};
