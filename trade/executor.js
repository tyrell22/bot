/**
 * Trade execution module
 * Handles the actual execution of trades on the exchange
 */
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const bybit = require('../api/bybit');
const riskManager = require('./risk');
const storage = require('../data/storage');
const config = require('../config');

class TradeExecutor extends EventEmitter {
  constructor() {
    super();
    this.tradeHistory = [];
    this.pendingTrades = new Map();
    this.maxHistorySize = 1000;
  }
  
  /**
   * Execute a trading signal
   * @param {Object} signal - The trading signal to execute
   * @returns {Object} - Information about the executed trade
   */
  async executeSignal(signal) {
    try {
      // Get account information for available balance
      const accountInfo = await bybit.getAccountInfo();
      
      if (!accountInfo) {
        throw new Error('Failed to get account information');
      }
      
      // Get current price from WebSocket (faster and more accurate)
      let currentPrice = null;
      if (global.wsManager) {
        const tickerData = global.wsManager.getTicker(signal.symbol);
        if (tickerData && tickerData.lastPrice) {
          currentPrice = parseFloat(tickerData.lastPrice);
        }
      }
      
      // Fall back to signal price if WebSocket price not available
      if (!currentPrice) {
        currentPrice = signal.price;
      }
      
      // Calculate account value
      const accountEquity = parseFloat(accountInfo.availableBalance);
      
      // Get the leverage from config
      const leverage = config.trading.leverage;
      
      // Set leverage for this symbol before placing the order
      try {
        logger.info(`Setting leverage for ${signal.symbol} to ${leverage}x`);
        await bybit.setLeverage(signal.symbol, leverage);
      } catch (leverageError) {
        // If setting leverage fails, log it but continue
        // Often this happens if the leverage is already set to the desired value
        logger.warn(`Error setting leverage for ${signal.symbol}: ${leverageError.message}`);
      }
      
      // Calculate position size directly
      const positionValue = accountEquity * config.trading.positionSizePercentage * leverage;
      const positionSize = positionValue / currentPrice;
      
      // Generate trade ID
      const tradeId = uuidv4();
      
      // Create order parameters
      const side = signal.direction === 'BUY' ? 'Buy' : 'Sell';
      
      // Calculate take profit and stop loss levels
      let takeProfitPrice, stopLossPrice;
      
      if (side === 'Buy') {
        takeProfitPrice = currentPrice * (1 + config.trading.targetProfit);
        stopLossPrice = currentPrice * (1 - config.trading.stopLoss);
      } else {
        takeProfitPrice = currentPrice * (1 - config.trading.targetProfit);
        stopLossPrice = currentPrice * (1 + config.trading.stopLoss);
      }
      
      // Create order parameters including TP and SL
      const orderParams = {
        symbol: signal.symbol,
        side: side,
        orderType: 'Market',
        quantity: positionSize.toFixed(), // Use 3 decimal places for most crypto pairs
        timeInForce: 'GTC',
        takeProfit: takeProfitPrice.toFixed(6),
        stopLoss: stopLossPrice.toFixed(6)
      };
      
      // Track pending trade
      this.pendingTrades.set(tradeId, {
        id: tradeId,
        signal,
        orderParams,
        status: 'PENDING',
        createdAt: Date.now()
      });
      
      // Place the order
      logger.info(`Executing ${side} order for ${signal.symbol} with quantity ${orderParams.quantity}, leverage: ${leverage}x, TP: ${orderParams.takeProfit}, SL: ${orderParams.stopLoss}`);
      const orderResult = await bybit.placeOrder(orderParams);
      
      // Update pending trade
      const pendingTrade = this.pendingTrades.get(tradeId);
      if (pendingTrade) {
        pendingTrade.status = 'EXECUTED';
        pendingTrade.orderId = orderResult.orderId;
        pendingTrade.orderResult = orderResult;
        pendingTrade.executedAt = Date.now();
      }
      
     // Create trade record
const trade = {
  id: tradeId,
  symbol: signal.symbol,
  direction: signal.direction,
  entryPrice: currentPrice,
  quantity: orderParams.quantity,
  leverage: leverage,
  orderId: orderResult.orderId,
  status: 'OPEN',
  signalStrength: signal.strength,
  entryTime: Date.now(),
  indicators: signal.indicators,
  takeProfitPrice: takeProfitPrice,
  stopLossPrice: stopLossPrice,
  trailingStop: false,         // Initialize to false
  trailingStopEnabled: false,  // Initialize to false
  trailingStopValue: null      // Will be set when enabled
};
      
      // Add to trade history
      this.tradeHistory.push(trade);
      
      // Limit history size
      if (this.tradeHistory.length > this.maxHistorySize) {
        this.tradeHistory = this.tradeHistory.slice(-this.maxHistorySize);
      }
      
      // Save trade to storage
      this.saveTrade(trade);
      
      // Emit trade execution event
      this.emit('trade_executed', trade);
      
      return trade;
    } catch (error) {
      logger.error(`Trade execution error for ${signal.symbol}: ${error.message}`);
      this.emit('trade_error', {
        symbol: signal.symbol,
        direction: signal.direction,
        error: error.message,
        timestamp: Date.now()
      });
      
      throw error;
    }
  }
  
  /**
   * Update a trade's status
   * @param {string} tradeId - ID of the trade to update
   * @param {string} status - New status
   * @param {Object} data - Additional data to update
   * @returns {Object} - The updated trade
   */
  updateTradeStatus(tradeId, status, data = {}) {
    const tradeIndex = this.tradeHistory.findIndex(t => t.id === tradeId);
    
    if (tradeIndex === -1) {
      logger.warn(`Cannot update trade status: Trade not found with ID ${tradeId}`);
      return null;
    }
    
    // Update the trade
    const trade = this.tradeHistory[tradeIndex];
    trade.status = status;
    trade.lastUpdated = Date.now();
    
    // Update additional data
    Object.assign(trade, data);
    
    // Save updated trade
    this.saveTrade(trade);
    
    // Emit update event
    this.emit('trade_updated', trade);
    
    return trade;
  }
  
  /**
   * Close a trade
   * @param {string} tradeId - ID of the trade to close
   * @param {number} exitPrice - Exit price
   * @param {string} reason - Reason for closing the trade
   * @returns {Object} - The closed trade
   */
  async closeTrade(tradeId, exitPrice, reason = 'MANUAL') {
    const tradeIndex = this.tradeHistory.findIndex(t => t.id === tradeId);
    
    if (tradeIndex === -1) {
      logger.warn(`Cannot close trade: Trade not found with ID ${tradeId}`);
      return null;
    }
    
    const trade = this.tradeHistory[tradeIndex];
    
    // Calculate P&L
    const entryValue = trade.entryPrice * trade.quantity;
    const exitValue = exitPrice * trade.quantity;
    let pnl;
    
    if (trade.direction === 'BUY') {
      pnl = exitValue - entryValue;
    } else {
      pnl = entryValue - exitValue;
    }
    
    // Calculate P&L percentage
    const pnlPercentage = (pnl / entryValue) * 100 * trade.leverage;
    
    // Update trade data
    trade.status = 'CLOSED';
    trade.exitPrice = exitPrice;
    trade.exitTime = Date.now();
    trade.duration = trade.exitTime - trade.entryTime;
    trade.pnl = pnl;
    trade.pnlPercentage = pnlPercentage;
    trade.closeReason = reason;
    
    // Save closed trade
    this.saveTrade(trade);
    
    // Emit close event
    this.emit('trade_closed', trade);
    
    return trade;
  }
  
  /**
   * Save a trade to persistent storage
   * @param {Object} trade - The trade to save
   */
  saveTrade(trade) {
    try {
      // Get existing trades
      const trades = storage.loadData('trades') || [];
      
      // Find if this trade already exists
      const existingIndex = trades.findIndex(t => t.id === trade.id);
      
      if (existingIndex !== -1) {
        // Update existing trade
        trades[existingIndex] = trade;
      } else {
        // Add new trade
        trades.push(trade);
      }
      
      // Save back to storage
      storage.saveData('trades', trades);
    } catch (error) {
      logger.error(`Error saving trade: ${error.message}`);
    }
  }
  
  /**
   * Load trades from storage
   */
  loadTrades() {
    try {
      const trades = storage.loadData('trades') || [];
      this.tradeHistory = trades;
      
      logger.info(`Loaded ${trades.length} trades from storage`);
      
      return trades;
    } catch (error) {
      logger.error(`Error loading trades: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Get trades for a specific symbol
   * @param {string} symbol - The trading pair symbol
   * @param {string} status - Filter by status (OPEN, CLOSED, etc.)
   * @returns {Array} - Filtered trades
   */
  getTradesForSymbol(symbol, status = null) {
    return this.tradeHistory
      .filter(trade => {
        // Filter by symbol
        const symbolMatch = trade.symbol === symbol;
        
        // Filter by status if specified
        const statusMatch = status ? trade.status === status : true;
        
        return symbolMatch && statusMatch;
      })
      .sort((a, b) => b.entryTime - a.entryTime);
  }
  
  /**
   * Get all open trades
   * @returns {Array} - Open trades
   */
  getOpenTrades() {
    return this.tradeHistory
      .filter(trade => trade.status === 'OPEN')
      .sort((a, b) => b.entryTime - a.entryTime);
  }
}

module.exports = new TradeExecutor();