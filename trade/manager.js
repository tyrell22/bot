/**
 * Trade manager module
 * Manages open positions, monitors their performance,
 * and implements position management rules
 */
const EventEmitter = require('events');
const bybit = require('../api/bybit');
const tradeExecutor = require('./executor');
const config = require('../config');

class TradeManager extends EventEmitter {
  constructor() {
    super();
    this.openPositions = new Map();
    this.positionUpdates = new Map();
    this.monitoring = false;
    this.monitoringInterval = null;
    this.checkInterval = 10000; // 10 seconds
    
  }
  
  /**
   * Initialize the trade manager
   */
  
  init() {
    // Load existing positions from exchange
    this.refreshPositions();
    
    // Start position monitoring
    this.startMonitoring();
    
    // Setup event listeners
    tradeExecutor.on('trade_executed', this.handleNewTrade.bind(this));
    tradeExecutor.on('trade_closed', this.handleClosedTrade.bind(this));
    
    logger.info('Trade manager initialized');
    
    return true;
  }
  
  /**
   * Start monitoring positions
   */
  startMonitoring() {
    if (this.monitoring) {
      return;
    }
    
    this.monitoring = true;
    this.monitoringInterval = setInterval(() => {
      this.monitorPositions();
    }, this.checkInterval);
    
    logger.info('Position monitoring started');
  }
  
  /**
   * Stop monitoring positions
   */
  stopMonitoring() {
    if (!this.monitoring) {
      return;
    }
    
    clearInterval(this.monitoringInterval);
    this.monitoring = false;
    
    logger.info('Position monitoring stopped');
  }
  
  /**
   * Refresh positions from exchange
    * @param {Object} trade - Trade data if available
   */
  
  async refreshPositions() {
    try {
      const positions = await bybit.getPositions();
      
      // Reset the positions map
      this.openPositions.clear();
      
      // Process active positions
      if (positions && Array.isArray(positions)) {
        logger.info(`Got ${positions.length} positions from ByBit API`);
        
        for (const position of positions) {
          // Skip positions with zero size or missing required data
          if (!position || !position.symbol || parseFloat(position.size || 0) === 0) {
            continue;
          }
          
          const symbol = position.symbol;
          
          // Make sure we extract these values safely
          const entryPrice = this.safeParseFloat(position.entryPrice);
          const markPrice = this.safeParseFloat(position.markPrice);
          const size = this.safeParseFloat(position.size);
          const leverage = this.safeParseFloat(position.leverage, 1); // Default to 1x if parsing fails
          const positionValue = this.safeParseFloat(position.positionValue);
          const unrealisedPnl = this.safeParseFloat(position.unrealisedPnl);
          
          // Debug log to help diagnose issues
          logger.info(`Position data for ${symbol}: size=${size}, entryPrice=${entryPrice}, markPrice=${markPrice}, leverage=${leverage}`);
          
          // Only add position if we have valid price data
          if (isNaN(entryPrice) || isNaN(markPrice)) {
            logger.warn(`Skipping position for ${symbol} due to invalid price data: entryPrice=${trade.entryPrice}, markPrice=${position.markPrice}`);
            continue;
          }
          
          // Determine position side
          const side = size > 0 ? 'Buy' : 'Sell';
          
          // Add to open positions
          this.openPositions.set(symbol, {
            symbol,
            size,
            entryPrice,
            markPrice,
            leverage,
            marginType: position.marginType || 'isolated',
            positionValue,
            unrealisedPnl,
            createdTime: this.safeParseInt(position.createdTime, Date.now()),
            updatedTime: this.safeParseInt(position.updatedTime, Date.now()),
            side,
            lastRefreshed: Date.now()
          });
        }
      } else {
        logger.warn('Invalid positions data received from ByBit API');
      }
      
      logger.info(`Refreshed ${this.openPositions.size} open positions from ByBit`);
      
      return Array.from(this.openPositions.values());
    } catch (error) {
      logger.error(`Error refreshing positions: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Safely parse a float value
   * @param {any} value - The value to parse
   * @param {number} defaultValue - Default value to return if parsing fails
   * @returns {number} - Parsed float value
   */
  safeParseFloat(value, defaultValue = 0) {
    if (value === undefined || value === null) return defaultValue;
    
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  
  /**
   * Safely parse an integer value
   * @param {any} value - The value to parse
   * @param {number} defaultValue - Default value to return if parsing fails
   * @returns {number} - Parsed integer value
   */
  safeParseInt(value, defaultValue = 0) {
    if (value === undefined || value === null) return defaultValue;
    
    const parsed = parseInt(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  
  /**
   * Log detailed diagnostic information about position data
   * @param {Array} positions - Position data from ByBit API
   */
  logPositionDiagnostics(positions) {
    if (!positions || !Array.isArray(positions)) {
      logger.error('Invalid positions data for diagnostics');
      return;
    }
  
    logger.info(`Diagnostic information for ${positions.length} positions from ByBit API`);
  
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      if (!pos) continue;
  
      logger.info(`Position ${i + 1}/${positions.length} - ${pos.symbol || 'Unknown'}`);
      
      // Check for essential properties
      const checks = [
        { property: 'symbol', value: pos.symbol },
        { property: 'size', value: pos.size, parsed: parseFloat(pos.size) },
        { property: 'entryPrice', value: pos.entryPrice, parsed: parseFloat(pos.entryPrice) },
        { property: 'markPrice', value: pos.markPrice, parsed: parseFloat(pos.markPrice) },
        { property: 'leverage', value: pos.leverage, parsed: parseFloat(pos.leverage) },
        { property: 'positionValue', value: pos.positionValue, parsed: parseFloat(pos.positionValue) },
        { property: 'unrealisedPnl', value: pos.unrealisedPnl, parsed: parseFloat(pos.unrealisedPnl) }
      ];
  
      for (const check of checks) {
        const status = check.value === undefined ? 'MISSING' :
                      check.parsed !== undefined && isNaN(check.parsed) ? 'INVALID' : 'OK';
        
        logger.info(`  - ${check.property}: ${status} (Raw: ${check.value}, Parsed: ${check.parsed})`);
      }
  
      // Log the full position object for deeper analysis if needed
      logger.info(`Full position data for ${pos.symbol || 'Unknown'}: ${JSON.stringify(pos)}`);
    }
  }
  
  /**
   * Run a one-time diagnostic check of position data from the ByBit API
   * This can be called manually when troubleshooting
   */
  
  async runPositionDiagnostic() {
    try {
      logger.info('Running position data diagnostic...');
      
      // Get raw position data from ByBit API
      const positions = await bybit.getPositions();
      
      
      // Log detailed information
      this.logPositionDiagnostics(positions);
      
      // Test parsing with our safe methods
      if (positions && Array.isArray(positions)) {
        for (const position of positions) {
          if (!position || !position.symbol) continue;
          
          const symbol = position.symbol;
          logger.info(`Safe parsing test for ${symbol}:`);
          
          const entryPrice = this.safeParseFloat(position.entryPrice);
          const markPrice = this.safeParseFloat(position.markPrice);
          const size = this.safeParseFloat(position.size);
          const leverage = this.safeParseFloat(position.leverage, 1);
          
          logger.info(`  - Safe parsed values: entryPrice=${entryPrice}, markPrice=${markPrice}, size=${size}, leverage=${leverage}`);
        }
      }
      
      logger.info('Position diagnostic completed');
    } catch (error) {
      logger.error(`Error running position diagnostic: ${error.message}`);
    }
  }
  
  /**
   * Monitor open positions
   */
  async monitorPositions() {
    try {
      // Refresh positions from exchange
      await this.refreshPositions();
      
      // Get current time
      const now = Date.now();
      
      // Check each position
      for (const [symbol, position] of this.openPositions.entries()) {
        // Calculate position duration in minutes
        const durationMinutes = (now - position.createdTime) / (60 * 1000);
        
        // Update position age
        position.durationMinutes = durationMinutes;
        
        // Get trade information if available
        const openTrades = tradeExecutor.getTradesForSymbol(symbol, 'OPEN');
        const trade = openTrades.length > 0 ? openTrades[0] : null;
        
        // Check for inactive positions (not moving for a certain time)
        this.checkInactivePosition(symbol, position, trade);
        
        // Check for positions that can be managed (adjust TP/SL, trailing stop)
        this.managePosition(symbol, position, trade);
      }
    } catch (error) {
      logger.error(`Error monitoring positions: ${error.message}`);
    }
  }
  
  /**
   * Check if a position has been inactive for too long
   * @param {string} symbol - Position symbol
   * @param {Object} position - Position data
   * @param {Object} trade - Trade data if available
   */
  async checkInactivePosition(symbol, position, trade) {
    try {
      // Get current position update record or create new one
      if (!this.positionUpdates.has(symbol)) {
        this.positionUpdates.set(symbol, {
          lastPriceChange: Date.now(),
          lastPrice: position.markPrice,
          priceChanges: []
        });
        return;
      }
      
      const updateRecord = this.positionUpdates.get(symbol);
      const priceChange = Math.abs((position.markPrice - updateRecord.lastPrice) / updateRecord.lastPrice);
      
      // If price has changed significantly (more than 0.1%), update the record
      if (priceChange > 0.001) {
        updateRecord.priceChanges.push({
          timestamp: Date.now(),
          price: position.markPrice,
          change: priceChange
        });
        
        // Limit the price change history
        if (updateRecord.priceChanges.length > 20) {
          updateRecord.priceChanges.shift();
        }
        
        updateRecord.lastPriceChange = Date.now();
        updateRecord.lastPrice = position.markPrice;
      }
      
      // Check if position has been inactive for too long
      const inactiveTime = config.trading.inactivePositionMinutes * 60 * 1000;
      const timeSinceLastChange = Date.now() - updateRecord.lastPriceChange;
      
      if (timeSinceLastChange > inactiveTime) {
        logger.info(`Position ${symbol} has been inactive for ${Math.floor(timeSinceLastChange / 60000)} minutes, considering closure`);
        
        // Check if we have reached maximum open positions
        const openPositions = await this.getOpenPositions();
        const hasMaxPositions = openPositions.length >= config.trading.maxOpenPositions;
        
        // Only close if we're at max positions and could open new ones
        if (hasMaxPositions) {
          await this.closePosition(symbol, 'Inactive position');
          
          // If we have trade data, update it
          if (trade) {
            await tradeExecutor.closeTrade(
              trade.id,
              position.markPrice,
              'INACTIVE'
            );
          }
        }
      }
    } catch (error) {
      logger.error(`Error checking inactive position for ${symbol}: ${error.message}`);
    }
  }
  
  /**
   * Actively manage an open position
   * @param {string} symbol - Position symbol
   * @param {Object} position - Position data
   * @param {Object} trade - Trade data if available
   */
  async managePosition(symbol, position, trade) {
    try {
      // Calculate current P&L percentage
      const entryPrice = trade.entryPrice;
      const currentPrice = position.markPrice;
      const side = trade.direction;
      
      let pnlPercent;
      if (side === 'Buy') {
        pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * position.leverage;
      } else {
        pnlPercent = ((entryPrice - currentPrice) / entryPrice) * 100 * position.leverage;
      }
      
      // Calculate activation threshold for trailing stop
      const activationThreshold = config.trading.trailingStopActivation * 100;
      
      logger.info(`Position ${symbol}: PNL = ${pnlPercent.toFixed(2)}%, Threshold = ${activationThreshold}%`);
      
      // Update position with current P&L
      position.pnlPercent = pnlPercent;
      
      // Check if we need to enable trailing stop
      if (trade && !trade.trailingStopEnabled) {
        // If profit exceeds activation threshold, enable trailing stop
        if (pnlPercent > activationThreshold) {
          logger.info(`Profit threshold exceeded for ${symbol}, enabling trailing stop`);
          await this.enableTrailingStop(symbol, position, trade);
        }
      }
    } catch (error) {
      logger.error(`Error managing position for ${symbol}: ${error.message}`);
    }
  }
  
  /**
   * Enable trailing stop for a position
   * @param {string} symbol - Position symbol
   * @param {Object} position - Position data
   * @param {Object} trade - Trade data
   * @returns {boolean} - Whether the operation was successful
   */
  async enableTrailingStop(symbol, position, trade) {
    try {
      // Get trailing stop activation percentage from config (or use default of 1%)
      const trailingStopPercent = config.trading.trailingStopPercent || 0.01;
      
      // Calculate trailing stop distance based on current price
      const trailingStop = position.markPrice * trailingStopPercent;
      
      // ByBit API expects trailing stop as a percentage value (e.g., 1% = 1.00)
      const trailingStopPercentForAPI = (trailingStopPercent * 100).toFixed(2);
      
      const trailingStopParams = {
        symbol: symbol,
        trailingStop: trailingStopPercentForAPI,
        positionIdx: 0 // For One-Way Mode
      };
      
      logger.info(`Enabling trailing stop for ${symbol} at ${trailingStopPercentForAPI}% distance`);
      
      // Call ByBit API to set trailing stop
      await bybit.setTradingStop(symbol, trailingStopParams);
      
      // Mark trailing stop as enabled in trade record
      trade.trailingStop = true;
      trade.trailingStopEnabled = true;
      trade.trailingStopValue = trailingStop;
      trade.trailingStopPercent = trailingStopPercent * 100; // Store as percentage
      trade.trailingStopTime = Date.now();
      
      // Update trade record
      tradeExecutor.saveTrade(trade);
      
      logger.info(`Successfully enabled trailing stop for ${symbol} at ${trailingStopPercentForAPI}% distance`);
      
      return true;
    } catch (error) {
      logger.error(`Error enabling trailing stop for ${symbol}: ${error.message}`);
      logger.error(`Error details: ${JSON.stringify(error)}`);
      return false;
    }
  }
  
  /**
   * Close a position
   * @param {string} symbol - Position symbol
   * @param {string} reason - Reason for closing
   * @returns {boolean} - Whether the closure was successful
   * @param {Object} trade - Trade data if available
   */
  async closePosition(symbol, reason = 'Manual closure') {
    try {
      const position = this.openPositions.get(symbol);
      
      if (!position) {
        logger.warn(`Cannot close position for ${symbol}: Position not found`);
        return false;
      }
      
      // Determine close direction (opposite of position side)
      const closeSide = position.side === 'Buy' ? 'Sell' : 'Buy';
      
      // Place market order to close position
      const orderParams = {
        symbol,
        side: closeSide,
        orderType: 'Market',
        quantity: Math.abs(position.size),
        reduceOnly: true
      };
      
      logger.info(`Closing position for ${symbol} with ${closeSide} order. Reason: ${reason}`);
      
      // Execute the order
      const result = await bybit.placeOrder(orderParams);
      
      // Emit position closed event
      this.emit('position_closed', {
        symbol,
        size: position.size,
        entryPrice: trade.entryPrice,
        exitPrice: position.markPrice,
        pnl: position.unrealisedPnl,
        pnlPercentage: position.pnlPercent,
        reason,
        orderResult: result
      });
      
      // Remove from open positions
      this.openPositions.delete(symbol);
      
      return true;
    } catch (error) {
      logger.error(`Error closing position for ${symbol}: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Close all open positions
   * @param {string} reason - Reason for closing all positions
   * @returns {Array} - Results of close operations
   */
  async closeAllPositions(reason = 'Closing all positions') {
    const results = [];
    
    for (const symbol of this.openPositions.keys()) {
      try {
        const result = await this.closePosition(symbol, reason);
        results.push({ symbol, success: result });
      } catch (error) {
        results.push({ symbol, success: false, error: error.message });
      }
    }
    
    return results;
  }
  
  /**
   * Handle new trade execution
   * @param {Object} trade - The new trade
   */
  handleNewTrade(trade) {
    // Refresh positions to make sure we capture the new one
    this.refreshPositions();
  }
  
  /**
   * Handle closed trade
   * @param {Object} trade - The closed trade
   */
  handleClosedTrade(trade) {
    // Remove from open positions if it exists
    this.openPositions.delete(trade.symbol);
    
    // Clean up position updates
    this.positionUpdates.delete(trade.symbol);
  }
  
  /**
   * Get all open positions
   * @returns {Array} - Array of open positions
   */
  async getOpenPositions() {
    // Refresh to ensure we have the latest data
    await this.refreshPositions();
    return Array.from(this.openPositions.values());
  }
}

module.exports = new TradeManager();