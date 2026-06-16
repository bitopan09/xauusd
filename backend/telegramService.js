const fetch = require('node-fetch');
const dotenv = require('dotenv');

dotenv.config();

class TelegramNotificationService {
    constructor() {
        this.token = process.env.TELEGRAM_BOT_TOKEN || null;
        this.chatId = process.env.TELEGRAM_CHAT_ID || null;
        this.baseUrl = this.token ? `https://api.telegram.org/bot${this.token}` : null;
        this.verified = false;
        this.botUsername = null;
    }

    get configured() {
        return Boolean(this.token && this.chatId);
    }

    async verifyConnection() {
        if (!this.token) {
            return { success: false, error: 'TELEGRAM_BOT_TOKEN not set' };
        }

        try {
            const meRes = await fetch(`${this.baseUrl}/getMe`);
            const meJson = await meRes.json();

            if (!meJson.ok) {
                return { success: false, error: `Invalid token: ${meJson.description}` };
            }

            this.botUsername = meJson.result.username;
            this.verified = true;

            if (!this.chatId) {
                const resolved = await this._resolveChatId();
                if (resolved) {
                    this.chatId = resolved;
                }
            }

            return {
                success: true,
                botUsername: this.botUsername,
                chatId: this.chatId,
                message: `Bot @${this.botUsername} verified${this.chatId ? ` (chat: ${this.chatId})` : ' (no chat ID — send /start to bot, then re-verify)'}`
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    async _resolveChatId() {
        try {
            const res = await fetch(`${this.baseUrl}/getUpdates?limit=10`);
            const json = await res.json();
            if (!json.ok || !json.result) return null;

            for (const update of json.result) {
                const chat = update.message?.chat || update.my_chat_member?.chat;
                if (chat && chat.id) {
                    return String(chat.id);
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    async sendMessage(text, parseMode = null) {
        if (!this.baseUrl || !this.chatId) return false;

        try {
            const body = { chat_id: this.chatId, text };
            if (parseMode) body.parse_mode = parseMode;

            const res = await fetch(`${this.baseUrl}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const json = await res.json();
            return json.ok;
        } catch {
            return false;
        }
    }

    async sendTradeNotification(trade, tradeType = 'TRADE') {
        if (!process.env.SEND_TELEGRAM_ON_TRADE || process.env.SEND_TELEGRAM_ON_TRADE !== 'true') {
            return false;
        }
        if (!this.configured) return false;

        const emoji = trade.action === 'BUY' ? '\u{1F4C8}' : '\u{1F4C9}';
        const pnl = trade.pnl != null ? `\nP&L: $${trade.pnl.toFixed(2)}` : '';
        const score = trade.score ? `\nScore: ${trade.score}/10` : '';
        const sl = trade.sl ? `\nSL: $${trade.sl.toFixed(2)}` : '';
        const tp = trade.tp1 ? `\nTP1: $${trade.tp1.toFixed(2)}` : '';

        const msg = [
            `${emoji} ${tradeType}`,
            `Action: ${trade.action || 'N/A'}`,
            `Entry: $${trade.entry_price?.toFixed(2) || 'N/A'}`,
            `Qty: ${trade.quantity || 0.01} lot`,
            `${sl}${tp}${score}${pnl}`,
            `Time: ${new Date(trade.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
        ].join('\n');

        return this.sendMessage(msg);
    }

    async sendDailySummary(summary) {
        if (!process.env.SEND_DAILY_SUMMARY || process.env.SEND_DAILY_SUMMARY !== 'true') {
            return false;
        }
        if (!this.configured) return false;

        const pnl = summary.totalPnl ?? summary.totalPnL ?? 0;
        const msg = [
            `\u{1F4CA} Daily Summary`,
            `Date: ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
            `Trades: ${summary.tradesExecuted || 0}`,
            `Wins: ${summary.winningTrades || 0} | Losses: ${summary.losingTrades || 0}`,
            `P&L: $${pnl.toFixed(2)}`,
            `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
        ].join('\n');

        return this.sendMessage(msg);
    }

    getStatus() {
        return {
            configured: this.configured,
            verified: this.verified,
            botUsername: this.botUsername,
            chatId: this.chatId || null,
            sendOnTrade: process.env.SEND_TELEGRAM_ON_TRADE === 'true',
            sendDailySummary: process.env.SEND_DAILY_SUMMARY === 'true'
        };
    }
}

module.exports = new TelegramNotificationService();
