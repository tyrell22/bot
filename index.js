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
    process.exit(1);
  }
  
  // Initialize ByBit connection
  try {
    await bybit.init();
    logger.info('ByBit API connection established');
  } catch (error) {
    logger.error(`Failed to initialize ByBit API: ${error.message}`);
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
  
  // Initialize trade manager
  tradeManager.init();
  
  // Initialize data collector
  dataCollector.init(wsManager);
  
  // Initialize strategy coordinator
  strategyCoordinator.init(wsManager, dataCollector);
  
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