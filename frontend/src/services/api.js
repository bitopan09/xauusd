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

export { userId, API_BASE_URL };

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

// WebSocket service for real-time price updates with reconnection
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
