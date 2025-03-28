require('dotenv').config();

module.exports = {
  // ByBit API Configuration
  api: {
    baseUrl: 'https://api.bybit.com',
    wsBaseUrl: 'wss://stream.bybit.com/v5',
    apiKey: process.env.BYBIT_API_KEY || '',
    apiSecret: process.env.BYBIT_API_SECRET || '',
    testnet: false, // Set to true for testnet
  },
  
  // Trading Parameters
  trading: {
    leverage: 10, // 10x leverage
    targetProfit: 0.03, // 3% profit target
    stopLoss: 0.02, // 1.5% stop loss
    trailingStopActivation: 0.02, // Activate trailing stop after 2% profit
    maxTradesPerHour: 15,
    maxOpenPositions: 10,
    positionSizePercentage: 0.01, // 5% of available balance per trade
    inactivePositionMinutes: 20, // Close positions not moving after 20 minutes
  },
  
  // Timeframes to analyze
  timeframes: ['1' , '3'],
  
  // Main timeframe for signals
  mainTimeframe: '1',
  
  // Symbols to trade (will be overridden by dynamic selection)
  // These are default fallbacks
  symbols: [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'BNBUSDT',
    'XRPUSDT'
  ],
  
  // Number of top symbols by volume to track
  topSymbolsCount: 50,
  
  // Indicators configuration
  indicators: {
    vwap: {
      period: 24, // 24 hours
    },
    rsi: {
      period: 14,
      overbought: 70,
      oversold: 30
    },
    ema: {
      fast: 9,
      medium: 21,
      slow: 50
    },
    macd: {
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9
    },
    bollingerBands: {
      period: 20,
      stdDev: 2
    }
  },
  
  // Orderbook configuration
  orderbook: {
    depth: 50, // Number of price levels to analyze
    updateInterval: 100, // ms between updates
    significantVolume: 100000 // Significant volume level for analysis
  },
  
  // Machine Learning settings
  ml: {
    trainingFrequency: 4, // Hours between training
    minTradesForTraining: 100, // Minimum trades needed for training
    epochs: 50,
    validationSplit: 0.2,
    predictThreshold: 0.65 // Confidence threshold for trade execution
  },
  
  // Data storage
  storage: {
    tradesFile: './data/trades.json',
    modelPath: './data/model/',
    backupInterval: 6 // Hours between backups
  },
  
  // Logging configuration
  logging: {
    level: 'info', // debug, info, warn, error
    console: true,
    file: true,
    filePath: './logs/'
  }
};