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
   */
  async refreshPositions() {
    try {
      const positions = await bybit.getPositions();
      
      // Reset the positions map
      this.openPositions.clear();
      
      // Process active positions
      for (const position of positions) {
        // Skip positions with zero size
        if (parseFloat(position.size) === 0) {
          continue;
        }
        
        const symbol = position.symbol;
        
        this.openPositions.set(symbol, {
          symbol,
          size: parseFloat(position.size),
          entryPrice: parseFloat(position.entryPrice),
          markPrice: parseFloat(position.markPrice),
          leverage: parseFloat(position.leverage),
          marginType: position.marginType,
          positionValue: parseFloat(position.positionValue),
          unrealisedPnl: parseFloat(position.unrealisedPnl),
          createdTime: parseInt(position.createdTime),
          updatedTime: parseInt(position.updatedTime),
          side: parseFloat(position.size) > 0 ? 'Buy' : 'Sell',
          lastRefreshed: Date.now()
        });
      }
      
      logger.info(`Refreshed ${this.openPositions.size} open positions from ByBit`);
      
      return Array.from(this.openPositions.values());
    } catch (error) {
      logger.error(`Error refreshing positions: ${error.message}`);
      return [];
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
      const entryPrice = position.entryPrice;
      const currentPrice = position.markPrice;
      const side = position.side;
      
      let pnlPercent;
      if (side === 'Buy') {
        pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * position.leverage;
      } else {
        pnlPercent = ((entryPrice - currentPrice) / entryPrice) * 100 * position.leverage;
      }
      
      // Update position with current P&L
      position.pnlPercent = pnlPercent;
      
      // Check if we need to enable trailing stop
      if (trade && trade.trailingStop && !trade.trailingStopEnabled) {
        const activationThreshold = config.trading.trailingStopActivation * 100;
        
        // If profit exceeds activation threshold, enable trailing stop
        if (pnlPercent > activationThreshold) {
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
   */
  async enableTrailingStop(symbol, position, trade) {
    try {
      // Calculate trailing stop distance (1% of current price)
      const trailingStop = position.markPrice * 0.01;
      
      // Setup trailing stop
      await bybit.setTradingStop(symbol, {
        trailingStop: trailingStop.toFixed(4)
      });
      
      // Mark trailing stop as enabled
      trade.trailingStopEnabled = true;
      trade.trailingStopValue = trailingStop;
      trade.trailingStopTime = Date.now();
      
      // Update trade record
      tradeExecutor.saveTrade(trade);
      
      logger.info(`Enabled trailing stop for ${symbol} at distance ${trailingStop.toFixed(6)}`);
      
      return true;
    } catch (error) {
      logger.error(`Error enabling trailing stop for ${symbol}: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Close a position
   * @param {string} symbol - Position symbol
   * @param {string} reason - Reason for closing
   * @returns {boolean} - Whether the closure was successful
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
        entryPrice: position.entryPrice,
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