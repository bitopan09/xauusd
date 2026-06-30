# XAUUSD V4-Plus EA — MT5 Setup Guide

## Quick Start (5 minutes)

### Step 1: Copy EA to MT5

1. Open Finder
2. Press `Cmd + Shift + G` and paste:
   ```
   ~/Library/Application Support/MetaQuotes/Terminal/
   ```
3. Open the folder with your OctaFX demo account (long alphanumeric name)
4. Navigate to `MQL5/Experts/`
5. Copy `XAUUSD_V4Plus.mq5` into this folder
6. Copy `XAUUSD_V4Plus.set` into `MQL5/Presets/` (create folder if needed)

### Step 2: Compile the EA

1. In MT5, press `F4` or go to `Tools → MetaQuotes Language Editor`
2. In the MetaEditor, find `XAUUSD_V4Plus.mq5` in the Navigator panel
3. Double-click to open it
4. Press `F7` to compile
5. Check the "Errors" tab at the bottom — should show "0 errors"
6. Close MetaEditor and return to MT5

### Step 3: Backtest

1. In MT5, press `Ctrl + R` to open Strategy Tester
2. Settings:
   - **Expert**: `XAUUSD_V4Plus`
   - **Symbol**: `XAUUSD` (or `XAUUSD.` — try both)
   - **Period**: `H1` (or `H6` if available — see below)
   - **Date range**: `2024.01.01` to `2025.06.27`
   - **Modeling**: `Every tick based on real ticks` (best) or `Open prices only` (fast)
   - **Deposit**: `50`
   - **Leverage**: `1:500` (OctaFX default)
3. Click "Start"
4. Wait for backtest to complete (may take 5-30 minutes)

### Step 4: View Results

After backtest completes, check these tabs:
- **Backtest**: Overall stats (profit factor, max DD, win rate)
- **Graph**: Equity curve
- **Deals**: Individual trade list
- **Journal**: EA log messages

---

## Detailed Instructions

### Finding Your MT5 Data Folder

Each OctaFX demo account has its own data folder. To find it:

1. In MT5, go to `File → Open Data Folder`
2. This opens the correct folder in Finder
3. The path looks like:
   ```
   ~/Library/Application Support/MetaQuotes/Terminal/XXXXXXXXXXXXXXXX/
   ```

### Symbol Name Issues

Some OctaFX accounts use `XAUUSD.` (with dot) instead of `XAUUSD`. 

To check:
1. In MT5, look at the "Market Watch" panel (Ctrl+M)
2. Find gold — it might be `XAUUSD` or `XAUUSD.`
3. If it's `XAUUSD.`, edit the EA:
   - Open MetaEditor (F4)
   - Open `XAUUSD_V4Plus.mq5`
   - Change `input string InpSymbol = "XAUUSD";` to `input string InpSymbol = "XAUUSD.";`
   - Recompile (F7)

### Custom H6 Timeframe

MT5 doesn't have a built-in 6-hour timeframe. Options:

**Option A: Use H1 (Recommended for first backtest)**
- The EA works fine on H1
- Set Strategy Tester Period to H1
- This is the simplest approach

**Option B: Create custom H6 period**
1. In MT5, go to `Tools → Options → Charts`
2. Under "Max bars in chart", set to at least 300
3. The EA will use whatever timeframe you select in Strategy Tester

### Backtest Settings Explained

| Setting | Recommended | Notes |
|---------|-------------|-------|
| **Modeling** | Every tick | Most accurate, slowest |
| **Modeling** | Open prices | Fast, less accurate |
| **Period** | H1 | Match InpPrimaryTF |
| **Date** | 2024.01-2025.06 | ~18 months of data |
| **Deposit** | 50 | Your starting capital |
| **Leverage** | 1:500 | OctaFX default |
| **Forward testing** | Not checked | Backtest first |

### Interpreting Results

**Good signs:**
- Profit factor > 1.5
- Max drawdown < 30%
- Win rate > 50%
- Sharpe ratio > 1.0
- Equity curve generally upward

**Warning signs:**
- Profit factor < 1.0 (losing money)
- Max drawdown > 50% (too risky)
- Win rate < 40% (strategy not working)
- Equity curve going down

### Common Issues

**"Symbol not found"**
- Your broker uses a different symbol name
- Check Market Watch for the exact name
- Try `XAUUSD.` or `GOLD` or `XAU/USD`

**"Indicator handle failed"**
- Symbol name mismatch
- Not enough historical data
- Try a shorter backtest period first

**"Not enough memory"**
- Close other applications
- Reduce the backtest date range
- Use "Open prices only" modeling

**EA not trading**
- Check Journal tab for errors
- Verify symbol name is correct
- Ensure there's enough historical data (at least 200 candles)
- Check that the EA is enabled in Expert Advisors settings

---

## After Backtest

### If Results Look Good

1. Run backtest on demo account:
   - Drag EA from Navigator to a XAUUSD chart
   - Set timeframe to H1
   - Enable "Auto Trading" button
   - EA will trade automatically

2. Monitor for 1-2 weeks:
   - Check daily P&L
   - Compare with backtest results
   - Watch for any errors in Journal

3. Go live with 0.01 lots:
   - Same EA settings
   - Same risk parameters
   - Start small, scale up gradually

### If Results Look Bad

Share these with me:
1. Backtest "Backtest" tab (overall stats)
2. Backtest "Graph" tab (equity curve)
3. Backtest "Deals" tab (trade list)
4. Journal tab errors (if any)

I'll analyze and tune the parameters.

---

## File Locations Summary

| File | Destination |
|------|-------------|
| `XAUUSD_V4Plus.mq5` | `MQL5/Experts/` |
| `XAUUSD_V4Plus.set` | `MQL5/Presets/` |

## Quick Reference

| Action | Shortcut |
|--------|----------|
| Open Strategy Tester | Ctrl+R |
| Open MetaEditor | F4 |
| Compile EA | F7 |
| Market Watch | Ctrl+M |
| Navigator | Ctrl+N |
| Terminal | Ctrl+T |

---

## Troubleshooting Checklist

- [ ] EA file is in `MQL5/Experts/`
- [ ] EA compiled with 0 errors
- [ ] Symbol name matches Market Watch
- [ ] Enough historical data (200+ candles)
- [ ] Auto Trading is enabled (for live/demo)
- [ ] Correct account is selected in Navigator
- [ ] MT5 is connected to OctaFX server (green connection status)

---

*Last updated: 2025-06-27*
*EA Version: 1.00*
