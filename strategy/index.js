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
   */
  init(wsManager, dataCollector) {
    this.wsManager = wsManager;
    this.dataCollector = dataCollector;
    
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
    logger.info(`Trade executed: ${trade.symbol} ${trade.side} @ ${trade.price}`);
  }
  
  /**
   * Handle trade execution errors
   * @param {Object} error - The error object
   */
  handleTradeError(error) {
    logger.error(`Trade execution error: ${error.message}`);
  }
  
  /**
   * Handle position closure
   * @param {Object} position - The closed position
   */
  handlePositionClosed(position) {
    logger.info(`Position closed: ${position.symbol} with P&L: ${position.pnl} (${position.pnlPercentage.toFixed(2)}%)`);
  }
}

module.exports = new StrategyCoordinator();