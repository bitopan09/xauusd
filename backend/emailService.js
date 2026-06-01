const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const dns = require('dns');

// Force DNS to prefer IPv4 globally
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

dotenv.config();

class EmailService {
    constructor() {
        this.transporter = null;
        this.initialized = false;
        this.init();
    }

    init() {
        try {
            if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
                console.warn('Email service not configured. Email notifications will be disabled.');
                return;
            }

            const isGmail = (process.env.EMAIL_SERVICE || 'gmail').toLowerCase() === 'gmail';

            this.transporter = nodemailer.createTransport(isGmail ? {
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                family: 4,
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASSWORD
                }
            } : {
                service: process.env.EMAIL_SERVICE,
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASSWORD
                }
            });

            this.initialized = true;
            console.log('Email service initialized successfully');
        } catch (error) {
            console.error('Failed to initialize email service:', error.message);
            this.initialized = false;
        }
    }

    async sendTradeNotification(trade, tradeType = 'TRADE') {
        if (!this.initialized) {
            console.warn('Email service not initialized. Skipping notification.');
            return false;
        }

        try {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
                subject: `🥇 Gold Bot Alert: ${tradeType} Executed!`,
                html: this.generateTradeEmailHTML(trade, tradeType)
            };

            await this.transporter.sendMail(mailOptions);
            console.log(`Gold trade notification sent for ${tradeType} at ${new Date().toISOString()}`);
            return true;
        } catch (error) {
            console.error('Error sending trade notification:', error.message);
            return false;
        }
    }

    async sendDailySummary(summary) {
        if (!this.initialized) return false;

        try {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
                subject: `📊 Gold Bot Daily Summary - ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
                html: this.generateDailySummaryHTML(summary)
            };

            await this.transporter.sendMail(mailOptions);
            console.log(`Daily summary email sent`);
            return true;
        } catch (error) {
            console.error('Error sending daily summary:', error.message);
            return false;
        }
    }

    async sendAlert(title, message, severity = 'INFO') {
        if (!this.initialized) return false;

        try {
            const severityEmoji = { 'INFO': 'ℹ️', 'WARNING': '⚠️', 'ERROR': '❌' };

            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
                subject: `${severityEmoji[severity] || '📢'} Gold Bot Alert: ${title}`,
                html: `
                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
                        <div style="background: linear-gradient(135deg, #D4AF37 0%, #B8860B 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                            <h1 style="margin: 0; font-size: 24px;">${severityEmoji[severity] || '📢'} ${title}</h1>
                            <p style="margin: 5px 0 0 0; opacity: 0.9;">Severity: ${severity}</p>
                        </div>
                        <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #e2e8f0;">
                            <p style="margin: 0; font-size: 14px; line-height: 1.6;">${message}</p>
                            <p style="margin: 15px 0 0 0; font-size: 12px; color: #718096;">
                                Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                            </p>
                        </div>
                    </div>
                `
            };

            await this.transporter.sendMail(mailOptions);
            console.log(`Alert email sent: ${title}`);
            return true;
        } catch (error) {
            console.error('Error sending alert email:', error.message);
            return false;
        }
    }

    generateTradeEmailHTML(trade, type) {
        const tradeColor = trade.action === 'BUY' ? '#10b981' : '#ef4444';
        const tradeEmoji = trade.action === 'BUY' ? '📈' : '📉';

        return `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, ${tradeColor}80 0%, ${tradeColor} 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                    <h1 style="margin: 0; font-size: 28px;">${tradeEmoji} ${trade.action} Gold Trade Executed</h1>
                    <p style="margin: 5px 0 0 0; opacity: 0.95; font-size: 16px;">XAU/USD Gold Trading</p>
                </div>
                <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #e2e8f0;">
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Action</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: ${tradeColor}; font-weight: bold; font-size: 18px;">${trade.action}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Entry Price</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748;">$${trade.entry_price?.toFixed(2) || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Quantity</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748;">${trade.quantity || 0.01} oz Gold</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Stop Loss</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748;">$${trade.sl?.toFixed(2) || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Take Profit</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748;">$${trade.tp1?.toFixed(2) || trade.tp?.toFixed(2) || 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Confluence Score</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748;">${trade.score ? trade.score + '/10' : 'N/A'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; font-weight: bold; color: #2d3748;">Reasoning</td>
                            <td style="padding: 10px; color: #2d3748; font-size: 13px;">${trade.notes || trade.confluence || 'Institutional setup'}</td>
                        </tr>
                    </table>
                    <p style="margin: 0; font-size: 12px; color: #718096; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                        Timestamp: ${new Date(trade.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                    </p>
                </div>
                <div style="text-align: center; padding: 15px; font-size: 12px; color: #718096;">
                    <p>This is an automated notification from GoldForge Trading Bot.</p>
                </div>
            </div>
        `;
    }

    generateDailySummaryHTML(summary) {
        return `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #D4AF37 0%, #B8860B 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                    <h1 style="margin: 0; font-size: 28px;">📊 Daily Gold Trading Summary</h1>
                    <p style="margin: 5px 0 0 0; opacity: 0.95;">${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'long', day: 'numeric' })}</p>
                </div>
                <div style="background: #f8f9fa; padding: 20px; border-radius: 0 0 8px 8px; border: 1px solid #e2e8f0;">
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Trades Executed</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #2d3748; font-size: 18px; font-weight: bold;">${summary.tradesExecuted || 0}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Winning Trades</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #10b981; font-weight: bold;">${summary.winningTrades || 0}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #2d3748;">Losing Trades</td>
                            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; color: #ef4444; font-weight: bold;">${summary.losingTrades || 0}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px; font-weight: bold; color: #2d3748;">Total P&L</td>
                            <td style="padding: 10px; color: ${summary.totalPnL >= 0 ? '#10b981' : '#ef4444'}; font-size: 18px; font-weight: bold;">$${summary.totalPnL?.toFixed(2) || '0.00'}</td>
                        </tr>
                    </table>
                    <p style="margin: 0; font-size: 12px; color: #718096; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                        Report Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
                    </p>
                </div>
            </div>
        `;
    }
}

module.exports = new EmailService();
