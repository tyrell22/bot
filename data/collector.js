/**
 * Data collection module
 * Collects and prepares data for ML model training
 */
const indicators = require('../indicators');
const storage = require('./storage');
const orderbook = require('../api/orderbook');

class DataCollector {
  constructor() {
    this.wsManager = null;
    this.marketData = {};
    this.mlFeatures = {};
    this.featureUpdateInterval = null;
    this.initialized = false;
  }
  
  /**
   * Initialize the data collector
   * @param {Object} wsManager - WebSocket manager for real-time data
   */
  init(wsManager) {
    if (this.initialized) {
      return true;
    }
    
    this.wsManager = wsManager;
    
    // Set up event listeners for real-time data
    if (this.wsManager) {
      this.wsManager.on('kline', this.handleKlineUpdate.bind(this));
      this.wsManager.on('orderbook', this.handleOrderbookUpdate.bind(this));
      this.wsManager.on('ticker', this.handleTickerUpdate.bind(this));
    }
    
    // Start feature calculation
    this.featureUpdateInterval = setInterval(() => {
      this.updateFeatures();
    }, 60000); // Update every minute
    
    this.initialized = true;
    logger.info('Data collector initialized');
    
    return true;
  }
  
  /**
   * Handle kline (candlestick) data updates
   * @param {Object} data - Kline update data
   */
  handleKlineUpdate(data) {
    const { symbol, timeframe, data: klines } = data;
    
    // Initialize symbol data structure if needed
    if (!this.marketData[symbol]) {
      this.marketData[symbol] = {
        klines: {},
        orderbook: null,
        ticker: null,
        lastUpdate: Date.now()
      };
    }
    
    // Update klines data
    this.marketData[symbol].klines[timeframe] = klines;
    this.marketData[symbol].lastUpdate = Date.now();
  }
  
  /**
   * Handle orderbook data updates
   * @param {Object} data - Orderbook update data
   */
  handleOrderbookUpdate(data) {
    const { symbol, data: orderbookData } = data;
    
    // Initialize symbol data structure if needed
    if (!this.marketData[symbol]) {
      this.marketData[symbol] = {
        klines: {},
        orderbook: null,
        ticker: null,
        lastUpdate: Date.now()
      };
    }
    
    // Update orderbook data
    this.marketData[symbol].orderbook = orderbookData;
    this.marketData[symbol].lastUpdate = Date.now();
  }
  
  /**
   * Handle ticker data updates
   * @param {Object} data - Ticker update data
   */
  handleTickerUpdate(data) {
    const { symbol, data: tickerData } = data;
    
    // Initialize symbol data structure if needed
    if (!this.marketData[symbol]) {
      this.marketData[symbol] = {
        klines: {},
        orderbook: null,
        ticker: null,
        lastUpdate: Date.now()
      };
    }
    
    // Update ticker data
    this.marketData[symbol].ticker = tickerData;
    this.marketData[symbol].lastUpdate = Date.now();
  }
  
  /**
   * Update ML features for all symbols
   */
  updateFeatures() {
    for (const [symbol, data] of Object.entries(this.marketData)) {
      // Skip if we don't have enough data yet
      if (!this.hasRequiredData(data)) {
        continue;
      }
      
      // Calculate features
      const features = this.calculateFeatures(symbol, data);
      
      // Store features
      if (features) {
        this.mlFeatures[symbol] = {
          ...features,
          timestamp: Date.now()
        };
      }
    }
  }
  
  /**
   * Check if we have all required data for feature calculation
   * @param {Object} data - Market data for a symbol
   * @returns {boolean} - Whether we have enough data
   */
  hasRequiredData(data) {
    // Check if we have ticker data
    if (!data.ticker) {
      return false;
    }
    
    // Check if we have orderbook data
    if (!data.orderbook) {
      return false;
    }
    
    // Check if we have sufficient kline data for the main timeframe
    const mainTimeframe = require('../config').mainTimeframe;
    if (!data.klines[mainTimeframe] || data.klines[mainTimeframe].length < 50) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Calculate features for machine learning model
   * @param {string} symbol - The trading pair symbol
   * @param {Object} data - Market data for the symbol
   * @returns {Object|null} - Calculated features or null if calculation failed
   */
  calculateFeatures(symbol, data) {
    try {
      const mainTimeframe = require('../config').mainTimeframe;
      const klines = data.klines[mainTimeframe];
      const ticker = data.ticker;
      const orderbookData = data.orderbook;
      
      // Current price
      const currentPrice = ticker.lastPrice;
      
      // Calculate technical indicators
      const vwapResult = indicators.vwap.calculate(symbol, klines);
      const rsiResult = indicators.rsi.calculate(symbol, klines);
      const emaResult = indicators.ema.calculate(symbol, klines);
      const macdResult = indicators.macd.calculate(symbol, klines);
      
      // Calculate orderbook features
      const orderbookAnalysis = orderbook.getFullAnalysis(symbol, orderbookData);
      
      // Skip if any analysis failed
      if (!vwapResult.valid || !rsiResult.valid || !emaResult.valid || !macdResult.valid || !orderbookAnalysis.signal) {
        return null;
      }
      
      // Extract key features
      return {
        // Price features
        price: currentPrice,
        volume24h: ticker.volume24h,
        priceChangePercent24h: ticker.price24hPcnt * 100,
        
        // VWAP features
        vwap: vwapResult.vwap,
        vwapDeviation: ((currentPrice - vwapResult.vwap) / vwapResult.vwap) * 100,
        aboveVwap: currentPrice > vwapResult.vwap ? 1 : 0,
        
        // RSI features
        rsi: rsiResult.current,
        rsiOverbought: rsiResult.current > 70 ? 1 : 0,
        rsiOversold: rsiResult.current < 30 ? 1 : 0,
        
        // EMA features
        emaFast: emaResult.fast.current,
        emaMedium: emaResult.medium.current,
        emaSlow: emaResult.slow.current,
        emaFastAboveMedium: emaResult.fast.current > emaResult.medium.current ? 1 : 0,
        emaFastAboveSlow: emaResult.fast.current > emaResult.slow.current ? 1 : 0,
        emaMediumAboveSlow: emaResult.medium.current > emaResult.slow.current ? 1 : 0,
        
        // MACD features
        macd: macdResult.current.MACD,
        macdSignal: macdResult.current.signal,
        macdHistogram: macdResult.current.histogram,
        macdAboveSignal: macdResult.current.MACD > macdResult.current.signal ? 1 : 0,
        macdPositive: macdResult.current.MACD > 0 ? 1 : 0,
        
        // Orderbook features
        orderbookImbalance: orderbookAnalysis.imbalances.valid ? orderbookAnalysis.imbalances.imbalanceRatio : 1,
        orderbookBullish: orderbookAnalysis.signal === 'BUY' ? 1 : 0,
        orderbookBearish: orderbookAnalysis.signal === 'SELL' ? 1 : 0,
        orderbookScore: orderbookAnalysis.overallScore,
        
        // Depth features
        bidDepthRatio: orderbookAnalysis.depth.valid ? orderbookAnalysis.depth.bidDepthRatio : 0.5,
        askDepthRatio: orderbookAnalysis.depth.valid ? orderbookAnalysis.depth.askDepthRatio : 0.5,
        
        // Large orders features
        hasBidWalls: orderbookAnalysis.largeOrders.valid ? (orderbookAnalysis.largeOrders.hasBidWalls ? 1 : 0) : 0,
        hasAskWalls: orderbookAnalysis.largeOrders.valid ? (orderbookAnalysis.largeOrders.hasAskWalls ? 1 : 0) : 0
      };
    } catch (error) {
      logger.error(`Error calculating features for ${symbol}: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Get the most recent ML features for a symbol
   * @param {string} symbol - The trading pair symbol
   * @returns {Object|null} - The features or null if not available
   */
  getFeatures(symbol) {
    return this.mlFeatures[symbol] || null;
  }
  
  /**
   * Get all available ML features
   * @returns {Object} - All features by symbol
   */
  getAllFeatures() {
    return this.mlFeatures;
  }
  
  /**
   * Prepare a dataset for ML training from trades and features
   * @returns {Array} - Training dataset
   */
  prepareMLDataset() {
    try {
      // Load trades from storage
      const trades = storage.loadData('trades') || [];
      
      // Filter closed trades with P&L data
      const closedTrades = trades.filter(trade => 
        trade.status === 'CLOSED' && 
        trade.pnl !== undefined &&
        trade.indicators !== undefined
      );
      
      if (closedTrades.length === 0) {
        logger.warn('No closed trades with indicators found for ML dataset');
        return [];
      }
      
      // Transform into training examples
      const dataset = closedTrades.map(trade => {
        try {
          // Get trade indicators
          const indicators = trade.indicators;
          
          // Get key features
          const features = {
            // VWAP features
            vwapDeviation: indicators.vwap.comparison ? indicators.vwap.comparison.percentDeviation : 0,
            aboveVwap: indicators.vwap.comparison ? (indicators.vwap.comparison.aboveVwap ? 1 : 0) : 0,
            
            // RSI features
            rsi: indicators.rsi.conditions ? indicators.rsi.conditions.rsi : 50,
            rsiOverbought: indicators.rsi.conditions ? (indicators.rsi.conditions.overbought ? 1 : 0) : 0,
            rsiOversold: indicators.rsi.conditions ? (indicators.rsi.conditions.oversold ? 1 : 0) : 0,
            
            // EMA features
            emaFastAboveMedium: indicators.ema.crossovers ? (indicators.ema.crossovers.fastMediumBullish ? 1 : 0) : 0,
            emaFastAboveSlow: indicators.ema.crossovers ? (indicators.ema.crossovers.fastSlowBullish ? 1 : 0) : 0,
            emaMediumAboveSlow: indicators.ema.crossovers ? (indicators.ema.crossovers.mediumSlowBullish ? 1 : 0) : 0,
            
            // MACD features
            macdAboveSignal: indicators.macd.current ? (indicators.macd.current.MACD > indicators.macd.current.signal ? 1 : 0) : 0,
            macdPositive: indicators.macd.current ? (indicators.macd.current.MACD > 0 ? 1 : 0) : 0,
            
            // Orderbook features
            orderbookImbalance: indicators.orderbook.imbalances ? indicators.orderbook.imbalances.imbalanceRatio : 1,
            orderbookScore: indicators.orderbook.overallScore || 0,
            
            // Direction
            direction: trade.direction === 'BUY' ? 1 : 0
          };
          
          // Calculate target (1 for profitable trade, 0 for losing trade)
          const target = trade.pnl > 0 ? 1 : 0;
          
          return {
            features,
            target,
            tradeId: trade.id,
            symbol: trade.symbol,
            entryTime: trade.entryTime,
            exitTime: trade.exitTime,
            pnl: trade.pnl,
            pnlPercentage: trade.pnlPercentage
          };
        } catch (error) {
          logger.error(`Error preparing ML features for trade ${trade.id}: ${error.message}`);
          return null;
        }
      }).filter(item => item !== null);
      
      logger.info(`Prepared ML dataset with ${dataset.length} examples`);
      
      // Save dataset for reference
      storage.saveData('ml', dataset);
      
      return dataset;
    } catch (error) {
      logger.error(`Error preparing ML dataset: ${error.message}`);
      return [];
    }
  }
}

module.exports = new DataCollector();