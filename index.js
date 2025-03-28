const fs = require('fs-extra');
const path = require('path');
const winston = require('winston');
const config = require('./config');

// Import modules
const bybit = require('./api/bybit');
const WebSocketManager = require('./api/websocket');
const dataCollector = require('./data/collector');
const symbolSelector = require('./data/symbols');
const tradeExecutor = require('./trade/executor');
const tradeManager = require('./trade/manager');
const strategyCoordinator = require('./strategy/index');
const mlTrainer = require('./ml/trainer');
const storage = require('./data/storage');

// Set up logging
const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
      silent: !config.logging.console
    })
  ]
});

if (config.logging.file) {
  // Ensure log directory exists
  fs.ensureDirSync(config.logging.filePath);
  
  logger.add(new winston.transports.File({
    filename: path.join(config.logging.filePath, `bot-${new Date().toISOString().split('T')[0]}.log`)
  }));
}

// Make logger available globally
global.logger = logger;

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
  
  // Initialize ML model
  try {
    await mlTrainer.init();
    logger.info('Machine learning model initialized');
    
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
  }
  
  // Schedule regular backups
  setInterval(() => {
    storage.backup();
    logger.info('Data backup completed');
  }, config.storage.backupInterval * 60 * 60 * 1000);
  
  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  logger.info('Bot initialization complete, monitoring markets for scalping opportunities');
}

async function shutdown() {
  logger.info('Shutting down...');
  
  // Close all open positions if configured to do so
  try {
    await tradeManager.closeAllPositions();
    logger.info('All positions closed');
  } catch (error) {
    logger.error(`Error closing positions: ${error.message}`);
  }
  
  // Close WebSocket connections
  try {
    await WebSocketManager.closeAll();
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