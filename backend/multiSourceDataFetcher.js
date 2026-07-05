/**
 * Multi-Source Data Fetcher for XAU/USD
 * Prioritizes: Binance Futures → Bybit → OKX
 * Real-time accurate OHLC data
 */

class MultiSourceDataFetcher {
    constructor() {
        this.sources = [
            { name: 'binance', priority: 1, url: 'https://fapi.binance.com' },
            { name: 'bybit', priority: 2, url: 'https://api.bybit.com' },
            { name: 'okx', priority: 3, url: 'https://www.okx.com' }
        ];
    }

    async fetchCandles(symbol = 'XAUUSDT', interval = '1m', limit = 100) {
        for (const source of this.sources) {
            try {
                const candles = await this.fetchFromSource(source.name, symbol, interval, limit);
                if (candles && candles. length > 0) {
                    console.log(`[DataFetcher] Using ${source.name}: ${candles.length} candles`);
                    return candles;
                }
            } catch (err) {
                console.warn(`[DataFetcher] ${source.name} failed: ${err.message}`);
            }
        }
        throw new Error('All data sources failed');
    }

    async fetchFromSource(source, symbol, interval, limit) {
        const fetch = require('node-fetch');
        const intervals = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '6h': '6h', '1d': '1d' };
        const binInt = intervals[interval] || '1m';

        switch (source) {
            case 'binance': return this. fetchBinance(symbol, binInt, limit);
            case 'bybit': return this.fetchBybit(symbol, binInt, limit);
            case 'okx': return this.fetchOKX(symbol, binInt, limit);
            default: return null;
        }
    }

    async fetchBinance(symbol, interval, limit) {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 500)}`;
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data.map(c => ({
            time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
        }));
    }

    async fetchBybit(symbol, interval, limit) {
        const bybitIntervals = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '6h': '360', '1d': 'D' };
        const url = `https://api.bybit.com/v5/ market/kline?category=linear&symbol=${symbol}&interval=${bybitIntervals[interval]}&limit=${Math.min(limit, 200)}`;
        const response = await fetch(url);
        const json = await response.json();
        if (json.retCode !== 0) throw new Error(json.retMsg);
        return json.result.list.reverse().map(c => ({
            time: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
        }));
    }

    async fetchOKX(symbol, interval, limit) {
        const okxIntervals = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '6h': '6h', '1d': '1D' };
        const url = `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${okxIntervals[interval]}&limit=${Math.min(limit, 100)}`;
        const response = await fetch(url);
        const json = await response.json();
        if (json.code !== '0') throw new Error(json.msg);
        return json.data.map(c => ({
            time: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
            low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
        }));
    }

    async getTicker(symbol = 'XAUUSDT') {
        try {
            const url = `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`;
            const response = await fetch(url);
            const data = await response.json();
            return { price: parseFloat(data.lastPrice), high: parseFloat(data.highPrice), low: parseFloat(data.lowPrice), volume: parseFloat(data.volume), change: parseFloat(data.priceChangePercent) };
        } catch (err) {
            console.error('[DataFetcher] Ticker error:', err.message);
            return null;
        }
    }
}

module.exports = { MultiSourceDataFetcher };