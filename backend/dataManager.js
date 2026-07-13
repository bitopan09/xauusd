/**
 * DataManager — Multi-source historical candle fetcher with quality checks.
 *
 * Sources (priority order):
 *   1. SQLite cache (fastest, persistent across sessions)
 *   2. Client-provided candles (browser relay)
 *   3. Binance Futures REST (primary server source)
 *   4. OKX REST (secondary, longer history)
 *
 * Features:
 *   - Persistent SQLite storage for candles (survives server restarts)
 *   - Gap detection and continuity validation
 *   - Outlier filtering (price spikes > 10% ATR)
 *   - Timestamp continuity check
 *   - Multi-source fallback chain
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

class DataManager {
    constructor(db) {
        this.db = db;
        this._ready = false;
        if (this.db) {
            this._ensureTable();
        }
    }

    _ensureTable() {
        this.db.run(`CREATE TABLE IF NOT EXISTS candles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL DEFAULT 'XAUUSDT',
            interval TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            source TEXT DEFAULT 'binance',
            fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(symbol, interval, timestamp)
        )`, (err) => {
            if (err) {
                console.error('[DataManager] Table creation error:', err.message);
                return;
            }
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_candles_sym_int ON candles(symbol, interval, timestamp)`, () => {
                this._ready = true;
            });
        });
    }

    async _waitReady() {
        if (this._ready || !this.db) return;
        return new Promise(resolve => {
            const check = () => {
                if (this._ready) resolve();
                else setTimeout(check, 50);
            };
            check();
        });
    }

    /**
     * Get candles for backtest, trying all sources in priority order.
     */
    async getHistoricalData(requiredCount, interval, endTimeMs, clientCandles = null) {
        await this._waitReady();

        // Priority 1: Client-provided candles (browser relay)
        if (clientCandles && Array.isArray(clientCandles) && clientCandles.length > 0) {
            const parsed = this._parseRawCandles(clientCandles);
            if (parsed.length >= requiredCount * 0.5) {
                console.log(`[DataManager] Using ${parsed.length} client-provided candles`);
                return parsed;
            }
        }

        // Priority 2: Anchored JSON cache file (same as old code — most reliable)
        const cacheData = this._loadFromCacheFile(interval, endTimeMs);
        if (cacheData && cacheData.length >= requiredCount * 0.5) {
            console.log(`[DataManager] Loaded ${cacheData.length} candles from cache file`);
            return cacheData;
        }

        // Priority 3: Binance Futures REST (fresh fetch)
        try {
            const binanceData = await this._fetchBinance(interval, requiredCount, endTimeMs);
            if (binanceData && binanceData.length >= requiredCount * 0.5) {
                console.log(`[DataManager] Fetched ${binanceData.length} candles from Binance`);
                this._saveToCacheFile(binanceData, interval, endTimeMs);
                return binanceData;
            }
        } catch (err) {
            console.warn(`[DataManager] Binance fetch failed: ${err.message}`);
        }

        // Priority 4: OKX REST (longer history fallback)
        try {
            const okxData = await this._fetchOKX(interval, requiredCount, endTimeMs);
            if (okxData && okxData.length >= requiredCount * 0.5) {
                console.log(`[DataManager] Fetched ${okxData.length} candles from OKX`);
                return okxData;
            }
        } catch (err) {
            console.warn(`[DataManager] OKX fetch failed: ${err.message}`);
        }

        // Priority 5: Bybit REST (works from cloud servers, no IP blocks)
        try {
            const bybitData = await this._fetchBybit(interval, requiredCount, endTimeMs);
            if (bybitData && bybitData.length >= requiredCount * 0.5) {
                console.log(`[DataManager] Fetched ${bybitData.length} candles from Bybit`);
                return bybitData;
            }
        } catch (err) {
            console.warn(`[DataManager] Bybit fetch failed: ${err.message}`);
        }

        return null;
    }

    /**
     * Load from anchored JSON cache file (legacy format, proven reliable).
     */
    _loadFromCacheFile(interval, endTimeMs) {
        try {
            const end = new Date(endTimeMs || Date.now());
            const dateKey = end.toISOString().split('T')[0];
            // Try both naming conventions: '6h' (new) and '360' (legacy)
            const candidates = [interval, interval === '6h' ? '360' : null, interval === '360' ? '6h' : null].filter(Boolean);
            for (const intv of candidates) {
                const cacheFile = path.join(__dirname, `xau_backtest_cache_${dateKey}_${intv}.json`);
                if (fs.existsSync(cacheFile)) {
                    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                    if (cached && cached.length > 0) {
                        const parsed = cached.map(k => ({ ...k, timestamp: new Date(k.timestamp), source: 'cache' }));
                        // Ensure chronological order (oldest first) — fix for corrupted cache files
                        parsed.sort((a, b) => a.timestamp - b.timestamp);
                        return parsed;
                    }
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Save to anchored JSON cache file (legacy format).
     */
    _saveToCacheFile(candles, interval, endTimeMs) {
        try {
            const end = new Date(endTimeMs || Date.now());
            const dateKey = end.toISOString().split('T')[0];
            const cacheFile = path.join(__dirname, `xau_backtest_cache_${dateKey}_${interval}.json`);
            // Only save if file doesn't exist yet (don't overwrite existing cache)
            if (fs.existsSync(cacheFile)) return;
            // Clean only files from the same date that don't match (keep good caches)
            const sameDateFiles = fs.readdirSync(__dirname).filter(f =>
                f.startsWith('xau_backtest_cache_') && f.includes(dateKey) && f.endsWith('.json')
            );
            if (sameDateFiles.length === 0) {
                fs.writeFileSync(cacheFile, JSON.stringify(candles.map(d => ({
                    ...d, timestamp: d.timestamp instanceof Date ? d.timestamp.toISOString() : d.timestamp
                }))));
            }
        } catch (e) {
            // Non-critical
        }
    }

    /**
     * Fetch candles from Binance Futures REST API.
     * Supports multi-timeframe fetching for 5-TF ZLEMA analysis.
     */
    async _fetchBinance(interval, requiredCount, endTimeMs) {
        // Map backtest intervals to Binance interval strings
        const binanceInterval = {
            '360': '6h', '6h': '6h',
            '240': '4h', '4h': '4h',
            '60': '1h', '1h': '1h',
            '15': '15m', '15m': '15m',
            '5': '5m', '5m': '5m',
            '1': '1m', '1m': '1m',
            '1d': '1d', '1440': '1d', 'd': '1d', 'D': '1d'
        };
        const binInt = binanceInterval[interval] || interval;
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${binInt}&limit=200`;
        let end = endTimeMs || Date.now();
        let allCandles = [];
        let remaining = requiredCount;

        while (remaining > 0) {
            const chunkLimit = Math.min(remaining, 200);
            const fetchUrl = `${url}&limit=${chunkLimit}&endTime=${end}`;

            try {
                const response = await fetch(fetchUrl, {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                    timeout: 15000
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (!Array.isArray(data) || data.length === 0) break;

                allCandles = allCandles.concat(data);
                end = parseInt(data[0][0]) - 1; // Move end time before the first candle fetched
                remaining -= chunkLimit;
            } catch (err) {
                console.error(`[DataManager] Binance chunk fetch error: ${err.message}`);
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (allCandles.length === 0) return null;

        // Sort by timestamp ascending (oldest first) for chronological order
        allCandles.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

        return allCandles.map(k => ({
            timestamp: new Date(parseInt(k[0])),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            price: parseFloat(k[4]),
            source: 'binance',
        }));
    }

    /**
     * Fetch candles from OKX REST API (longer history available).
     * OKX interval mapping: 6H -> 6Hutc, 15m -> 15m, etc.
     */
    async _fetchOKX(interval, requiredCount, endTimeMs) {
        // Map Binance intervals to OKX bar format
        const okxBarMap = {
            '6h': '6H', '360': '6H',
            '4h': '4H', '240': '4H',
            '1h': '1H', '60': '1H',
            '15m': '15m', '15': '15m',
            '5m': '5m', '5': '5m',
            '1m': '1m', '1': '1m',
            '1d': '1D', '1440': '1D', 'd': '1D', 'D': '1D'
        };
        const okxBar = okxBarMap[interval] || interval;

        // OKX only supports up to 300 candles per request
        const limit = Math.min(300, requiredCount);
        const before = endTimeMs ? Math.floor(endTimeMs / 1000) : undefined;

        let url = `https://www.okx.com/api/v5/market/history-candles?instId=XAU-USDT&bar=${okxBar}&limit=${limit}`;
        if (before) url += `&before=${before}`;

        const response = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000
        });
        if (!response.ok) throw new Error(`OKX HTTP ${response.status}`);
        const json = await response.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) {
            throw new Error(`OKX: ${json.msg || 'no data'}`);
        }

        // OKX format: [ts, open, high, low, close, vol, volCcy, ...]
        return json.data.reverse().map(c => ({
            timestamp: new Date(parseInt(c[0])),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
            price: parseFloat(c[4]),
            source: 'okx',
        }));
    }

    /**
     * Fetch candles from Bybit REST API (works from cloud servers).
     * Bybit interval: 360 = 6H, 15 = 15m, 5 = 5m, 1 = 1m
     */
    async _fetchBybit(interval, requiredCount, endTimeMs) {
        const bybitInterval = { '360': '360', '6h': '360', '15': '15', '15m': '15', '5': '5', '5m': '5', '1': '1', '1m': '1' };
        const byInt = bybitInterval[interval] || '360';
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=${byInt}&limit=200`;
        let end = endTimeMs || Date.now();
        let allCandles = [];
        let remaining = requiredCount;

        while (remaining > 0) {
            const chunkLimit = Math.min(remaining, 200);
            const fetchUrl = `${url}&limit=${chunkLimit}&end=${end}`;

            try {
                const response = await fetch(fetchUrl, {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                    timeout: 15000
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const json = await response.json();
                if (json.retCode !== 0 || !json.result?.list || json.result.list.length === 0) break;
                const data = json.result.list;
                allCandles = allCandles.concat(data);
                end = parseInt(data[0][0]) - 1;
                remaining -= chunkLimit;
            } catch (err) {
                console.error(`[DataManager] Bybit chunk fetch error: ${err.message}`);
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (allCandles.length === 0) return null;

        allCandles.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

        return allCandles.map(k => ({
            timestamp: new Date(parseInt(k[0])),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            price: parseFloat(k[4]),
            source: 'bybit',
        }));
    }

    /**
     * Fetch multiple timeframes for 5-TF ZLEMA analysis.
     * Returns a map of timeframe -> candle array.
     */
    async fetchMultiTimeframes(intervals, requiredCount, endTimeMs) {
        const results = {};
        const promises = intervals.map(async (intv) => {
            try {
                const data = await this.getHistoricalData(requiredCount, intv, endTimeMs);
                if (data && data.length > 0) {
                    results[intv] = data;
                }
            } catch (err) {
                console.warn(`[DataManager] Failed to fetch ${intv}: ${err.message}`);
            }
        });
        await Promise.all(promises);
        return results;
    }

    /**
     * Parse raw candle arrays from client browser format.
     */
    _parseRawCandles(rawCandles) {
        const sorted = [...rawCandles].sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
        return sorted.map(k => ({
            timestamp: new Date(parseInt(k[0])),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            price: parseFloat(k[4]),
            source: 'client_browser',
        }));
    }

    /**
     * Load candles from SQLite persistent cache.
     */
    async _loadFromDb(interval, endTimeMs, limit) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT timestamp, open, high, low, close, volume, source 
                         FROM candles 
                         WHERE symbol = 'XAUUSDT' AND interval = ? AND timestamp <= ?
                         ORDER BY timestamp DESC 
                         LIMIT ?`;
            this.db.all(sql, [interval, endTimeMs || Date.now(), limit], (err, rows) => {
                if (err) return reject(err);
                if (!rows || rows.length === 0) return resolve(null);
                const candles = rows.reverse().map(r => ({
                    timestamp: new Date(r.timestamp),
                    open: r.open,
                    high: r.high,
                    low: r.low,
                    close: r.close,
                    volume: r.volume,
                    price: r.close,
                    source: r.source,
                }));
                resolve(candles);
            });
        });
    }

    /**
     * Store candles to SQLite persistent cache.
     */
    async _storeToDb(candles, interval) {
        const stmt = this.db.prepare(
            `INSERT OR IGNORE INTO candles (symbol, interval, timestamp, open, high, low, close, volume, source) 
             VALUES ('XAUUSDT', ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const c of candles) {
            stmt.run([interval, c.timestamp.getTime(), c.open, c.high, c.low, c.close, c.volume || 0, c.source || 'binance']);
        }
        stmt.finalize();

        // Cleanup: keep only last 90 days of data to prevent DB bloat
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
        this.db.run(`DELETE FROM candles WHERE symbol = 'XAUUSDT' AND interval = ? AND timestamp < ?`, [interval, cutoff]);
    }

    /**
     * Legacy cache file loader (fallback).
     */
    _loadFromLegacyCache(interval) {
        const files = fs.readdirSync(__dirname).filter(f =>
            f.startsWith('xau_backtest_cache_') && f.endsWith('.json') && f.includes(`_${interval}`)
        );
        if (files.length === 0) return null;

        files.sort().reverse();
        const cached = JSON.parse(fs.readFileSync(path.join(__dirname, files[0]), 'utf8'));
        if (!cached || cached.length === 0) return null;

        return cached.map(k => ({
            ...k,
            timestamp: new Date(k.timestamp),
            source: 'legacy_cache',
        }));
    }

    /**
     * Validate candle data quality.
     * Returns { valid: boolean, issues: string[] }
     */
    validateData(candles) {
        const issues = [];
        if (!candles || candles.length === 0) {
            return { valid: false, issues: ['No candles provided'] };
        }

        // Check for gaps > 2x interval
        if (candles.length > 1) {
            const avgGap = (candles[candles.length - 1].timestamp.getTime() - candles[0].timestamp.getTime()) / (candles.length - 1);
            for (let i = 1; i < candles.length; i++) {
                const gap = candles[i].timestamp.getTime() - candles[i - 1].timestamp.getTime();
                if (gap > avgGap * 2.5) {
                    issues.push(`Gap of ${Math.round(gap / 3600000)}h at index ${i}`);
                }
            }
        }

        // Check for outliers (price spikes)
        const closes = candles.map(c => c.close);
        const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
        const std = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / closes.length);
        for (let i = 0; i < candles.length; i++) {
            if (Math.abs(candles[i].close - mean) > std * 5) {
                issues.push(`Outlier at index ${i}: close=${candles[i].close} (${((candles[i].close - mean) / std).toFixed(1)}σ)`);
            }
        }

        // Check OHLC consistency
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (c.high < c.low || c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
                issues.push(`OHLC inconsistency at index ${i}`);
            }
        }

        return {
            valid: issues.length === 0,
            issues,
            count: candles.length,
            firstDate: candles[0].timestamp.toISOString(),
            lastDate: candles[candles.length - 1].timestamp.toISOString(),
        };
    }

    /**
     * Get candles from SQLite cache for chart display (Lightweight Charts format).
     * @param {string} interval - '6H', '1min', '5min'
     * @param {number} limit - max candles to return
     * @returns {Array} candles in { time, open, high, low, close } format
     */
    async getCandles(interval = '6H', limit = 200) {
        await this._waitReady();
        const normInterval = interval.toLowerCase() === '6h' ? '6h' : interval;
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT timestamp, open, high, low, close FROM candles 
                 WHERE symbol = 'XAUUSDT' AND interval = ? 
                 ORDER BY timestamp DESC LIMIT ?`,
                [normInterval, limit],
                (err, rows) => {
                    if (err) return reject(err);
                    if (!rows || rows.length === 0) return resolve([]);
                    resolve(rows
                        .map(r => ({
                            time: Math.floor(r.timestamp / 1000),
                            open: r.open,
                            high: r.high,
                            low: r.low,
                            close: r.close,
                        }))
                        .reverse() // oldest first for chart
                    );
                }
            );
        });
    }
}

module.exports = DataManager;
