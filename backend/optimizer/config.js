/**
 * Optimizer Configuration — Parameter space for daily grid search.
 *
 * Each parameter has:
 *   - name:    Internal key passed to strategy/TradeEngine
 *   - values:  Array of candidate values to test
 *   - type:    'continuous' | 'discrete' | 'boolean'
 *   - default: Default value when optimizer is not running
 */

module.exports = {
    // Grid search parameters
    GRID: {
        confluenceThreshold: {
            name: 'confluenceThreshold',
            values: [5.0, 5.5, 6.0, 6.5],
            type: 'discrete',
            default: 5.5,
            description: 'Minimum confluence score to enter a trade',
        },
        tp1ClosePercent: {
            name: 'tp1ClosePercent',
            values: [40, 50, 60],
            type: 'discrete',
            default: 60,
            description: 'Percentage of position closed at TP1',
        },
        maxSlDistance: {
            name: 'maxSlDistance',
            values: [10, 12, 15],
            type: 'discrete',
            default: 15,
            description: 'Maximum stop loss distance in points',
        },
        scoreMarginMin: {
            name: 'scoreMarginMin',
            values: [1.0, 1.5, 2.0],
            type: 'continuous',
            default: 1.0,
            description: 'Minimum score margin for directional confidence',
        },
        buyScoreMargin: {
            name: 'buyScoreMargin',
            values: [2.0, 2.5],
            type: 'continuous',
            default: 2.0,
            description: 'Minimum score margin for BUY trades (higher = more selective)',
        },
        emaAlignmentRequired: {
            name: 'emaAlignmentRequired',
            values: [false],
            type: 'boolean',
            default: false,
            description: 'Require EMA 9/21 alignment for BUY entries',
        },
        // V5: Zero-Lag Trend (ZLEMA) parameters
        zlemaRequired: {
            name: 'zlemaRequired',
            values: [false, true],
            type: 'boolean',
            default: false,
            description: 'Require ZLEMA trend alignment for all entries',
        },
        zlemaEntryRequired: {
            name: 'zlemaEntryRequired',
            values: [true, false],
            type: 'boolean',
            default: true,
            description: 'Require ZLEMA entry signal (crossover + trend confirm)',
        },
        zlemaLength: {
            name: 'zlemaLength',
            values: [50, 70, 90],
            type: 'discrete',
            default: 70,
            description: 'ZLEMA lookback length',
        },
        zlemaMult: {
            name: 'zlemaMult',
            values: [1.0, 1.2, 1.5],
            type: 'continuous',
            default: 1.2,
            description: 'ZLEMA volatility band multiplier',
        },
    },

    // ML Signal Filter Configuration
    ML_FILTER: {
        // Features used for training the trade quality classifier
        features: [
            'score',           // Confluence score
            'scoreMargin',     // Directional confidence margin
            'adx',             // ADX value
            'rsi',             // RSI value
            'macdHistogram',   // MACD histogram
            'emaAlignment',    // EMA 9 > EMA 21 (1/0)
            'atrPct',          // ATR as % of price
            'volumeRatio',     // Current volume / 20-bar avg
            'regimeTrending',  // Is trending regime (1/0)
            'regimeVolatile',  // Is volatile regime (1/0)
            'pullbackZone',    // 0=none, 1=premium, 2=discount
            'sessionActive',   // In trading session (1/0)
            'dayOfWeek',       // 0=Mon...6=Sun
        ],
        // Training config
        trainWindowDays: 30,       // Days of data for training
        validationWindowDays: 7,   // Days for validation
        minSamples: 20,            // Minimum trades to train ML filter
        confidenceThreshold: 0.45, // Block trades with predicted win prob < 45%
        modelType: 'logistic',     // 'logistic' | 'gradient_boosting'
    },

    // Evaluation config
    EVALUATION: {
        metric: 'profitFactorAdjusted', // 'profitFactor' | 'sharpe' | 'profitFactorAdjusted'
        // profitFactorAdjusted = PF * (1 - MaxDD/100)
        minWinRate: 0.40,         // Minimum acceptable win rate
        maxDrawdownPct: 30,       // Maximum acceptable drawdown %
        minTradesPerDay: 0.10,    // Don't pick configs with < 0.1 trades/day
        rollingDeployThreshold: 0.05, // Must improve PF by 5% to auto-deploy
    },

    // Scheduling
    SCHEDULE: {
        cronTime: '0 1 * * *',    // Run daily at 01:00 UTC (off-session)
        timezone: 'UTC',
        retryDelayMinutes: 30,
    },
};
