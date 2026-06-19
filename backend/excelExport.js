const XLSX = require('xlsx');
const path = require('path');

class ExcelExport {
    /**
     * Generate a comprehensive Excel workbook from backtest results.
     *
     * @param {Object} backtestResult - Result from tradingBot.runBacktest()
     * @param {Object} options - Export options
     * @param {string} options.filename - Output filename (default: backtest_YYYY-MM-DD.xlsx)
     * @param {string} options.outputDir - Output directory (default: project root)
     * @returns {string} Path to the generated Excel file
     */
    static generate(backtestResult, options = {}) {
        const {
            filename = `backtest_${new Date().toISOString().split('T')[0]}.xlsx`,
            outputDir = path.join(__dirname, '..'),
        } = options;

        const wb = XLSX.utils.book_new();

        // Sheet 1: Summary Dashboard
        ExcelExport._addSummarySheet(wb, backtestResult);

        // Sheet 2: Trade Log
        ExcelExport._addTradeLogSheet(wb, backtestResult);

        // Sheet 3: Equity Curve
        ExcelExport._addEquityCurveSheet(wb, backtestResult);

        // Sheet 4: Monthly Breakdown
        ExcelExport._addMonthlyBreakdownSheet(wb, backtestResult);

        // Sheet 5: Cost Analysis
        ExcelExport._addCostAnalysisSheet(wb, backtestResult);

        const outputPath = path.join(outputDir, filename);
        XLSX.writeFile(wb, outputPath);
        console.log(`Excel backtest report saved to: ${outputPath}`);
        return outputPath;
    }

    static _addSummarySheet(wb, result) {
        const {
            totalTrades, winRate, profitFactor, maxDrawdown,
            sharpeRatio, totalReturn, costs, dataInfo, trades
        } = result;

        const wins = trades.filter(t => t.pnl > 0);
        const losses = trades.filter(t => t.pnl <= 0);
        const avgWin = wins.length > 0
            ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
            : 0;
        const avgLoss = losses.length > 0
            ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length)
            : 0;
        const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

        // Calculate max consecutive wins/losses
        let maxConsecWins = 0, maxConsecLosses = 0, currWins = 0, currLosses = 0;
        trades.forEach(t => {
            if (t.pnl > 0) {
                currWins++;
                currLosses = 0;
                if (currWins > maxConsecWins) maxConsecWins = currWins;
            } else {
                currLosses++;
                currWins = 0;
                if (currLosses > maxConsecLosses) maxConsecLosses = currLosses;
            }
        });

        // Win/loss by direction
        const buyTrades = trades.filter(t => t.action === 'BUY');
        const sellTrades = trades.filter(t => t.action === 'SELL');
        const buyWinRate = buyTrades.length > 0
            ? buyTrades.filter(t => t.pnl > 0).length / buyTrades.length
            : 0;
        const sellWinRate = sellTrades.length > 0
            ? sellTrades.filter(t => t.pnl > 0).length / sellTrades.length
            : 0;

        const summaryData = [
            ['XAU/USD Backtest Report'],
            [''],
            ['Performance Summary'],
            ['Metric', 'Value'],
            ['Total Trades', totalTrades],
            ['Win Rate', `${(winRate * 100).toFixed(1)}%`],
            ['Profit Factor', profitFactor.toFixed(2)],
            ['Total Return', `${(totalReturn * 100).toFixed(2)}%`],
            ['Sharpe Ratio', sharpeRatio.toFixed(2)],
            ['Max Drawdown', `${(maxDrawdown * 100).toFixed(2)}%`],
            [''],
            ['Trade Statistics'],
            ['Metric', 'Value'],
            ['Winning Trades', wins.length],
            ['Losing Trades', losses.length],
            ['Avg Win ($)', avgWin.toFixed(2)],
            ['Avg Loss ($)', avgLoss.toFixed(2)],
            ['Expectancy ($)', expectancy.toFixed(2)],
            ['Best Trade ($)', wins.length > 0 ? Math.max(...wins.map(t => t.pnl)).toFixed(2) : 'N/A'],
            ['Worst Trade ($)', losses.length > 0 ? Math.min(...losses.map(t => t.pnl)).toFixed(2) : 'N/A'],
            ['Max Consecutive Wins', maxConsecWins],
            ['Max Consecutive Losses', maxConsecLosses],
            [''],
            ['Direction Breakdown'],
            ['Direction', 'Trades', 'Win Rate'],
            ['BUY', buyTrades.length, `${(buyWinRate * 100).toFixed(1)}%`],
            ['SELL', sellTrades.length, `${(sellWinRate * 100).toFixed(1)}%`],
            [''],
            ['Broker Cost Summary'],
            ['Cost Type', 'Amount ($)'],
            ['Spread Cost', costs?.totalSpreadCost?.toFixed(2) || '0.00'],
            ['Slippage Cost', costs?.totalSlippageCost?.toFixed(2) || '0.00'],
            ['Commission', costs?.totalCommission?.toFixed(2) || '0.00'],
            ['Total Costs', costs?.totalCosts?.toFixed(2) || '0.00'],
            [''],
            ['Data Information'],
            ['Metric', 'Value'],
            ['Data Source', dataInfo?.source || 'unknown'],
            ['Candle Count', dataInfo?.candleCount || 'N/A'],
            ['Date Range', dataInfo?.dateRange || 'N/A'],
            ['Broker Model', dataInfo?.brokerModel || 'N/A'],
        ];

        const ws = XLSX.utils.aoa_to_sheet(summaryData);
        ws['!cols'] = [{ wch: 30 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Summary');
    }

    static _addTradeLogSheet(wb, result) {
        const headers = [
            'ID', 'Entry Time', 'Exit Time', 'Action', 'Entry Price', 'Exit Price',
            'SL', 'TP1', 'TP2', 'Exit SL', 'Regime',
            'Quantity', 'P&L ($)', 'Score', 'Confluence', 'Exit Reason'
        ];

        const rows = result.trades.map(t => [
            t.id,
            t.entryTimestamp ? new Date(t.entryTimestamp).toLocaleString() : '',
            t.exitTimestamp ? new Date(t.exitTimestamp).toLocaleString() : '',
            t.action,
            t.entryPrice?.toFixed(2) || '',
            t.exitPrice?.toFixed(2) || '',
            t.sl?.toFixed(2) || '',
            t.tp1?.toFixed(2) || '',
            t.tp2?.toFixed(2) || '',
            t.exitSl?.toFixed(2) || '',
            t.regime || '',
            t.quantity,
            t.pnl?.toFixed(2) || '',
            t.score?.toFixed(1) || '',
            t.confluence || '',
            t.exitReason || '',
        ]);

        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        ws['!cols'] = [
            { wch: 5 }, { wch: 22 }, { wch: 22 }, { wch: 8 },
            { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
            { wch: 12 }, { wch: 10 },
            { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 40 }, { wch: 20 },
        ];
        XLSX.utils.book_append_sheet(wb, ws, 'Trade Log');
    }

    static _addEquityCurveSheet(wb, result) {
        const headers = ['Day', 'Equity ($)'];
        const rows = result.equityCurve.map(p => [p.day, p.equity?.toFixed(2)]);

        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        ws['!cols'] = [{ wch: 10 }, { wch: 15 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Equity Curve');
    }

    static _addMonthlyBreakdownSheet(wb, result) {
        const monthlyData = {};

        result.trades.forEach(t => {
            if (!t.entryTimestamp) return;
            const date = new Date(t.entryTimestamp);
            const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

            if (!monthlyData[monthKey]) {
                monthlyData[monthKey] = {
                    month: monthKey,
                    trades: 0,
                    wins: 0,
                    losses: 0,
                    totalPnl: 0,
                    totalWinPnl: 0,
                    totalLossPnl: 0,
                };
            }

            const m = monthlyData[monthKey];
            m.trades++;
            m.totalPnl += t.pnl || 0;
            if (t.pnl > 0) {
                m.wins++;
                m.totalWinPnl += t.pnl;
            } else {
                m.losses++;
                m.totalLossPnl += Math.abs(t.pnl);
            }
        });

        const headers = ['Month', 'Trades', 'Wins', 'Losses', 'Win Rate', 'Net P&L ($)', 'Avg P&L ($)', 'Profit Factor'];
        const rows = Object.values(monthlyData)
            .sort((a, b) => a.month.localeCompare(b.month))
            .map(m => [
                m.month,
                m.trades,
                m.wins,
                m.losses,
                m.trades > 0 ? `${((m.wins / m.trades) * 100).toFixed(1)}%` : '0.0%',
                m.totalPnl.toFixed(2),
                m.trades > 0 ? (m.totalPnl / m.trades).toFixed(2) : '0.00',
                m.totalLossPnl > 0 ? (m.totalWinPnl / m.totalLossPnl).toFixed(2) : m.totalWinPnl > 0 ? '∞' : '0.00',
            ]);

        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        ws['!cols'] = [
            { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 8 },
            { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 14 },
        ];
        XLSX.utils.book_append_sheet(wb, ws, 'Monthly Breakdown');
    }

    static _addCostAnalysisSheet(wb, result) {
        const { costs, trades } = result;

        // Calculate cost per trade
        const costPerTrade = trades.length > 0
            ? (costs?.totalCosts || 0) / trades.length
            : 0;

        // Net P&L after costs
        const grossPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
        const netPnl = grossPnl - (costs?.totalCosts || 0);

        const costData = [
            ['Broker Cost Analysis'],
            [''],
            ['Cost Breakdown'],
            ['Type', 'Total ($)', 'Per Trade ($)', '% of Gross P&L'],
            ['Spread Cost',
                costs?.totalSpreadCost?.toFixed(2) || '0.00',
                trades.length > 0 ? (costs?.totalSpreadCost / trades.length).toFixed(2) : '0.00',
                grossPnl !== 0 ? `${((costs?.totalSpreadCost || 0) / Math.abs(grossPnl) * 100).toFixed(1)}%` : '0.0%'
            ],
            ['Slippage Cost',
                costs?.totalSlippageCost?.toFixed(2) || '0.00',
                trades.length > 0 ? (costs?.totalSlippageCost / trades.length).toFixed(2) : '0.00',
                grossPnl !== 0 ? `${((costs?.totalSlippageCost || 0) / Math.abs(grossPnl) * 100).toFixed(1)}%` : '0.0%'
            ],
            ['Commission',
                costs?.totalCommission?.toFixed(2) || '0.00',
                trades.length > 0 ? (costs?.totalCommission / trades.length).toFixed(2) : '0.00',
                grossPnl !== 0 ? `${((costs?.totalCommission || 0) / Math.abs(grossPnl) * 100).toFixed(1)}%` : '0.0%'
            ],
            ['Total Costs',
                costs?.totalCosts?.toFixed(2) || '0.00',
                costPerTrade.toFixed(2),
                grossPnl !== 0 ? `${((costs?.totalCosts || 0) / Math.abs(grossPnl) * 100).toFixed(1)}%` : '0.0%'
            ],
            [''],
            ['P&L Impact'],
            ['Metric', 'Value'],
            ['Gross P&L ($)', grossPnl.toFixed(2)],
            ['Total Costs ($)', (costs?.totalCosts || 0).toFixed(2)],
            ['Net P&L ($)', netPnl.toFixed(2)],
            ['Cost-Adjusted Return', `${((netPnl / 50) * 100).toFixed(2)}%`],
            [''],
            ['Broker Configuration'],
            ['Parameter', 'Value'],
            ['Account Type', 'OctaFX Standard (0 commission)'],
            ['Base Spread', '40 points (4.0 pips)'],
            ['Spread Multipliers', 'London: 0.9x, NY: 0.9x, Overlap: 0.85x, Asia: 1.5x, Pre-Market: 1.3x, News: 3.0x'],
            ['Slippage Base', '41 points (4.1 pips)'],
            ['Commission', '$0/lot (Standard account)'],
            ['Fill Model', 'Next candle open (conservative)'],
        ];

        const ws = XLSX.utils.aoa_to_sheet(costData);
        ws['!cols'] = [{ wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 20 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Cost Analysis');
    }
}

module.exports = ExcelExport;
