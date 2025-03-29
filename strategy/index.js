/**
 * Strategy coordinator module
 * Manages all strategies and coordinates trade execution
 * Updated to handle browser-based TensorFlow.js
 */
const config = require('../config');
const scalping = require('./scalping');
const signals = require('./signals');
const tradeExecutor = require('../trade/executor');
const tradeManager = require('../trade/manager');
const mlPredictor = require('../ml/predictor');

class StrategyCoordinator {
  constructor() {
    this.activeStrategies = [];
    this.wsManager = null;
    this.dataCollector = null;
    this.sharedContext = null;
    this.tradeCounter = 0;
    this.tradeLimiter = {
      count: 0,
      startTime: Date.now(),
      maxPerHour: config.trading.maxTradesPerHour
    };
    this.mlEnabled = true;
  }
  
  /**
   * Initialize the strategy coordinator
   * @param {Object} wsManager - WebSocket manager
   * @param {Object} dataCollector - Data collector
   * @param {Object} sharedContext - Shared context object for dependency injection
   */
  init(wsManager, dataCollector, sharedContext = {}) {
    this.wsManager = wsManager;
    this.dataCollector = dataCollector;
    this.sharedContext = sharedContext;
    
    // Initialize strategies
    this.activeStrategies.push(scalping);
    
    // Initialize strategies
    this.activeStrategies.forEach(strategy => {
      strategy.init(wsManager, dataCollector);
    });
    
    // Setup event listeners for strategy signals
    this.setupEventListeners();
    
    // Check if ML is available - attempt a prediction to verify
    mlPredictor.predict({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      indicators: {}
    }).catch(error => {
      logger.warn(`ML prediction test failed, disabling ML: ${error.message}`);
      this.mlEnabled = false;
    });
    
    logger.info('Strategy coordinator initialized with ' + this.activeStrategies.length + ' strategies');
    
    return true;
  }
  
  /**
   * Setup event listeners for strategy signals
   */
  setupEventListeners() {
    // Listen for scalping signals
    scalping.on('signal', this.handleStrategySignal.bind(this));
    
    // Listen for websocket data to update strategies
    if (this.wsManager) {
      this.wsManager.on('kline', data => {
        this.updateStrategies('kline', data);
      });
      
      this.wsManager.on('orderbook', data => {
        this.updateStrategies('orderbook', data);
      });
      
      this.wsManager.on('ticker', data => {
        this.updateStrategies('ticker', data);
      });
    }
    
    // Trade execution events
    tradeExecutor.on('trade_executed', this.handleTradeExecuted.bind(this));
    tradeExecutor.on('trade_error', this.handleTradeError.bind(this));
    
    // Position management events
    tradeManager.on('position_closed', this.handlePositionClosed.bind(this));
  }
  
  /**
   * Update all active strategies with new data
   * @param {string} dataType - Type of data update
   * @param {Object} data - The data update
   */
  updateStrategies(dataType, data) {
    this.activeStrategies.forEach(strategy => {
      if (typeof strategy.update === 'function') {
        strategy.update(dataType, data);
      }
    });
  }
  
  /**
   * Handle strategy trading signals
   * @param {Object} signal - The trading signal
   */
  async handleStrategySignal(signal) {
    try {
      // Check if we're within the trade limit
      if (!this.checkTradeLimits()) {
        logger.info(`Trade limit reached (${config.trading.maxTradesPerHour} per hour), skipping signal for ${signal.symbol}`);
        return;
      }
      
      // Check if we already have too many open positions
      const openPositions = await tradeManager.getOpenPositions();
      if (openPositions.length >= config.trading.maxOpenPositions) {
        logger.info(`Maximum open positions (${config.trading.maxOpenPositions}) reached, skipping signal for ${signal.symbol}`);
        return;
      }
      
      // Check if we already have a position in this symbol
      const existingPosition = openPositions.find(p => p.symbol === signal.symbol);
      if (existingPosition) {
        logger.info(`Already have a position in ${signal.symbol}, skipping new signal`);
        return;
      }
      
      // Run the signal through ML model if available and enabled
      let mlConfidence = 0.5; // Default neutral
      let skipMlCheck = false;
      
      if (this.mlEnabled) {
        try {
          const mlPrediction = await mlPredictor.predict(signal);
          if (mlPrediction.valid) {
            mlConfidence = mlPrediction.confidence;
            logger.debug(`ML confidence for ${signal.symbol} ${signal.direction}: ${mlConfidence.toFixed(2)}`);
          } else {
            // If ML prediction failed but returned a message, log and continue
            logger.debug(`ML prediction returned invalid result: ${mlPrediction.message}`);
            skipMlCheck = true;
          }
        } catch (error) {
          logger.warn(`ML prediction error: ${error.message}`);
          skipMlCheck = true;
          
          // If we encounter errors repeatedly, disable ML
          if (error.message.includes('model') || error.message.includes('tensor')) {
            logger.warn('Disabling ML predictions due to persistent errors');
            this.mlEnabled = false;
          }
        }
      } else {
        // ML is disabled, skip the check
        skipMlCheck = true;
        logger.debug('ML predictions disabled, skipping ML confidence check');
      }
      
      // Only check ML confidence if ML check is not skipped
      if (!skipMlCheck && mlConfidence < config.ml.predictThreshold) {
        logger.info(`ML confidence (${mlConfidence.toFixed(2)}) below threshold (${config.ml.predictThreshold}) for ${signal.symbol}, skipping signal`);
        return;
      }
      
      // Execute the trade
      this.tradeCounter++;
      this.tradeLimiter.count++;
      
      if (this.mlEnabled && !skipMlCheck) {
        logger.info(`Executing trade #${this.tradeCounter} for ${signal.symbol} - ${signal.direction} (ML confidence: ${mlConfidence.toFixed(2)})`);
      } else {
        logger.info(`Executing trade #${this.tradeCounter} for ${signal.symbol} - ${signal.direction} (without ML verification)`);
      }
      
      await tradeExecutor.executeSignal(signal);
    } catch (error) {
      logger.error(`Error handling strategy signal: ${error.message}`);
    }
  }
  
  /**
   * Check if we've hit trade limits
   * @returns {boolean} - Whether we can place more trades
   */
  checkTradeLimits() {
    const hourInMs = 60 * 60 * 1000;
    const currentTime = Date.now();
    
    // Reset counter if an hour has passed
    if (currentTime - this.tradeLimiter.startTime > hourInMs) {
      this.tradeLimiter.count = 0;
      this.tradeLimiter.startTime = currentTime;
    }
    
    return this.tradeLimiter.count < this.tradeLimiter.maxPerHour;
  }
  
  /**
   * Handle successful trade execution
   * @param {Object} trade - The executed trade
   */
  handleTradeExecuted(trade) {
    logger.info(`Trade executed: ${trade.symbol} ${trade.direction} @ ${trade.entryPrice}`);
  }
  
  /**
   * Handle trade execution errors
   * @param {Object} error - The error object
   */
  handleTradeError(error) {
    logger.error(`Trade execution error: ${error.message}`);
  }
  const fs = require('fs-extra');
const path = require('path');
const config = require('./config');

// Initialize logger first
const loggerModule = require('./utils/logger');
const logger = loggerModule.initializeLogger(config);

// Make logger available globally
global.logger = logger;

// Import modules after logger is available
const bybit = require('./api/bybit');
const WebSocketManager = require('./api/websocket');
const dataCollector = require('./data/collector');
const symbolSelector = require('./data/symbols');
const tradeExecutor = require('./trade/executor');
const tradeManager = require('./trade/manager');
const strategyCoordinator = require('./strategy/index');
const mlTrainer = require('./ml/trainer');
const storage = require('./data/storage');
const riskManager = require('./trade/risk');

// Create a shared context object for dependency injection
const sharedContext = {};

async function init() {
  // Ensure required directories exist
  fs.ensureDirSync(path.dirname(config.storage.tradesFile));
  fs.ensureDirSync(config.storage.modelPath);
  
  logger.info('Starting ByBit Scalping Bot');
  
  // Initialize storage
  await storage.init();
  
  // Check API keys
  if (!config.api.apiKey || !config.api.apiSecret) {
    logger.error('API key and secret are required. Please check your environment variables.');
    logger.info('Make sure you have a .env file with BYBIT_API_KEY and BYBIT_API_SECRET defined.');
    process.exit(1);
  }
  
  // Initialize ByBit connection
  try {
    // Try with the API module
    await bybit.init();
    logger.info('ByBit API connection established');
  } catch (error) {
    logger.error(`Failed to initialize ByBit API: ${error.message}`);
    
    // Additional suggestions based on error
    if (error.message.includes('Authentication failed') || error.message.includes('Invalid API key')) {
      logger.error('POSSIBLE SOLUTIONS:');
      logger.error('1. Check that your API keys are correctly copied without extra spaces or characters');
      logger.error('2. Verify that your API keys have the correct permissions (Trading, Reading, etc.)');
      logger.error('3. If using testnet, ensure you have configured testnet: true in config.js');
      logger.error('4. Check if your keys are expired or have been revoked in ByBit');
    } else if (error.message.includes('connect')) {
      logger.error('CONNECTIVITY ISSUES:');
      logger.error('1. Check your internet connection');
      logger.error('2. Verify that you can reach ByBit\'s API in your browser');
      logger.error('3. Check if you need to use a proxy or VPN to access ByBit');
    } else if (error.message.includes('timeout')) {
      logger.error('API TIMEOUT:');
      logger.error('1. ByBit servers might be experiencing high load');
      logger.error('2. Your internet connection might be unstable');
      logger.error('3. Consider increasing the timeout value in config.js');
    }
    
    process.exit(1);
  }
  
  // Select top symbols by volume
  try {
    const topSymbols = await symbolSelector.getTopSymbolsByVolume(config.topSymbolsCount);
    logger.info(`Selected ${topSymbols.length} symbols for trading based on volume`);
    
    // Update config with selected symbols
    config.symbols = topSymbols;
  } catch (error) {
    logger.warn(`Failed to fetch top symbols, using default symbols: ${error.message}`);
  }
  
  // Initialize WebSocket connections
  const wsManager = new WebSocketManager();
  await wsManager.initConnections(config.symbols);
  logger.info(`WebSocket connections established for ${config.symbols.length} symbols`);
  
  // Store WebSocket manager in shared context
  sharedContext.wsManager = wsManager;
  
  // Initialize risk manager with WebSocket manager
  riskManager.init(wsManager);
  logger.info('Risk manager initialized with WebSocket data access');
  
  // Initialize trade manager
  tradeManager.init();
  
  // Initialize data collector
  dataCollector.init(wsManager);
  
  // Initialize strategy coordinator with shared context
  strategyCoordinator.init(wsManager, dataCollector, sharedContext);
  
  // Initialize ML model - with error handling for TensorFlow.js
  try {
    await mlTrainer.init();
    logger.info('Machine learning model initialized with TensorFlow.js');
    
    // Schedule periodic training
    setInterval(async () => {
      try {
        await mlTrainer.train();
        logger.info('Machine learning model training completed');
      } catch (error) {
        logger.error(`ML training error: ${error.message}`);
      }
    }, config.ml.trainingFrequency * 60 * 60 * 1000);
  } catch (error) {
    logger.warn(`Failed to initialize ML model: ${error.message}`);
    logger.warn('Bot will continue to operate without ML capabilities');
  }
  
  // Schedule regular backups
  setInterval(() => {
    storage.backup();
    logger.info('Data backup completed');
  }, config.storage.backupInterval * 60 * 60 * 1000);
  
  // Graceful shutdown
  process.on('SIGINT', () => shutdown(wsManager));
  process.on('SIGTERM', () => shutdown(wsManager));
  
  logger.info('Bot initialization complete, monitoring markets for scalping opportunities');
}

async function shutdown(wsManager) {
  logger.info('Shutting down...');
  
  // Close all open positions if configured to do so
  try {
    await tradeManager.closeAllPositions();
    logger.info('All positions closed');
  } catch (error) {
    logger.error(`Error closing positions: ${error.message}`);
  }
  
  // Close WebSocket connections (fixed to use the instance method)
  try {
    await wsManager.closeAll();
    logger.info('WebSocket connections closed');
  } catch (error) {
    logger.error(`Error closing WebSocket connections: ${error.message}`);
  }
  
  // Final data backup
  try {
    await storage.backup();
    logger.info('Final data backup completed');
  } catch (error) {
    logger.error(`Error during final backup: ${error.message}`);
  }
  
  logger.info('Shutdown complete');
  process.exit(0);
}

// Start the bot
init().catch(error => {
  logger.error(`Initialization failed: ${error.message}`);
  process.exit(1);
});
  /**
   * Handle position closure
   * @param {Object} position - The closed position
   */
  handlePositionClosed(position) {
    logger.info(`Position closed: ${position.symbol} with P&L: ${position.pnl} (${position.pnlPercentage.toFixed(2)}%)`);
  }
}

module.exports = new StrategyCoordinator();