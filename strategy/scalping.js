/**
 * Scalping strategy for short-term trading
 * Uses multiple indicators to find quick entry and exit points
 */
const EventEmitter = require('events');
const config = require('../config');

// Import indicators
const vwap = require('../indicators/vwap');
const rsi = require('../indicators/rsi');
const ema = require('../indicators/ema');
const macd = require('../indicators/macd');
const orderbookAnalyzer = require('../api/orderbook');

class ScalpingStrategy extends EventEmitter {
  constructor() {
    super();
    this.wsManager = null;
    this.dataCollector = null;
    this.lastSignals = {};
    this.signalCooldown = 60000; // 1 minute cooldown between signals for same symbol
    this.analyzedSymbols = new Set();
    this.symbolData = {};
  }
  
  /**
   * Initialize the scalping strategy
   * @param {Object} wsManager - WebSocket manager
   * @param {Object} dataCollector - Data collector
   */
  init(wsManager, dataCollector) {
    this.wsManager = wsManager;
    this.dataCollector = dataCollector;
    
    logger.info('Scalping strategy initialized');
    
    return true;
  }
  
  /**
   * Process new data from WebSocket
   * @param {string} dataType - Type of data update
   * @param {Object} data - The data update
   */
  update(dataType, data) {
    const { symbol } = data;
    
    // Initialize symbol data structure if needed
    if (!this.symbolData[symbol]) {
      this.symbolData[symbol] = {
        klines: {},
        orderbook: null,
        ticker: null,
        lastAnalysis: 0
      };
    }
    
    // Update symbol data
    switch (dataType) {
      case 'kline':
        this.symbolData[symbol].klines[data.timeframe] = data.data;
        break;
      case 'orderbook':
        this.symbolData[symbol].orderbook = data.data;
        break;
      case 'ticker':
        this.symbolData[symbol].ticker = data.data;
        break;
    }
    
    // Track symbols for analysis
    this.analyzedSymbols.add(symbol);
    
    // Throttle analysis to avoid excessive CPU usage
    const now = Date.now();
    const cooldownPeriod = 1000; // 1 second between analyses for same symbol
    
    if (now - this.symbolData[symbol].lastAnalysis > cooldownPeriod) {
      this.symbolData[symbol].lastAnalysis = now;
      this.analyzeSymbol(symbol);
    }
  }
  
  /**
   * Analyze a symbol for trading opportunities
   * @param {string} symbol - The trading pair symbol
   */
  analyzeSymbol(symbol) {
    try {
      const symbolData = this.symbolData[symbol];
      
      // Skip if we don't have all necessary data
      if (!this.hasRequiredData(symbolData)) {
        return;
      }
      
      // Get current market data
      const ticker = symbolData.ticker;
      const orderbook = symbolData.orderbook;
      const mainTimeframeKlines = symbolData.klines[config.mainTimeframe];
      
      // Skip if we're in a signal cooldown period
      if (this.lastSignals[symbol] && Date.now() - this.lastSignals[symbol] < this.signalCooldown) {
        return;
      }
      
      // Run technical indicator calculations
      const vwapResult = vwap.calculate(symbol, mainTimeframeKlines);
      const rsiResult = rsi.calculate(symbol, mainTimeframeKlines);
      const emaResult = ema.calculate(symbol, mainTimeframeKlines);
      const macdResult = macd.calculate(symbol, mainTimeframeKlines);
      
      // Run orderbook analysis
      const orderbookResult = orderbookAnalyzer.getFullAnalysis(symbol, orderbook);
      
      // Skip if any analysis failed
      if (!vwapResult.valid || !rsiResult.valid || !emaResult.valid || !macdResult.valid || !orderbookResult.signal) {
        return;
      }
      
      // Check VWAP signal
      const currentPrice = ticker.lastPrice;
      const vwapSignal = vwap.getSignal(symbol, currentPrice);
      const rsiSignal = rsi.getSignal(symbol, mainTimeframeKlines);
      const emaSignal = ema.getSignal(symbol, currentPrice);
      const macdSignal = macd.getSignal(symbol);
      
      // Calculate combined signal
      const signalStrength = this.calculateSignalStrength(
        vwapSignal,
        rsiSignal,
        emaSignal,
        macdSignal,
        orderbookResult
      );
      
      // Generate signal if strong enough
      if (Math.abs(signalStrength) >= 2) {
        const direction = signalStrength > 0 ? 'BUY' : 'SELL';
        
        // Create signal object
        const signal = {
          symbol,
          direction,
          price: currentPrice,
          strength: Math.abs(signalStrength),
          timestamp: Date.now(),
          indicators: {
            vwap: vwapSignal,
            rsi: rsiSignal,
            ema: emaSignal,
            macd: macdSignal,
            orderbook: orderbookResult
          }
        };
        
        // Emit signal
        this.emit('signal', signal);
        
        // Set cooldown
        this.lastSignals[symbol] = Date.now();
        
        logger.debug(`Generated ${direction} signal for ${symbol} with strength ${Math.abs(signalStrength)}`);
      }
    } catch (error) {
      logger.error(`Error analyzing ${symbol}: ${error.message}`);
    }
  }
  
  /**
   * Check if we have all required data for analysis
   * @param {Object} symbolData - Data for a specific symbol
   * @returns {boolean} - Whether we have enough data
   */
  hasRequiredData(symbolData) {
    // Check if we have ticker data
    if (!symbolData.ticker) {
      return false;
    }
    
    // Check if we have orderbook data
    if (!symbolData.orderbook) {
      return false;
    }
    
    // Check if we have kline data for main timeframe
    if (!symbolData.klines[config.mainTimeframe] || symbolData.klines[config.mainTimeframe].length < 50) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Calculate overall signal strength based on all indicators
   * @param {Object} vwapSignal - VWAP indicator signal
   * @param {Object} rsiSignal - RSI indicator signal
   * @param {Object} emaSignal - EMA indicator signal
   * @param {Object} macdSignal - MACD indicator signal
   * @param {Object} orderbookSignal - Orderbook analysis signal
   * @returns {number} - Signal strength (positive for buy, negative for sell)
   */
  calculateSignalStrength(vwapSignal, rsiSignal, emaSignal, macdSignal, orderbookSignal) {
    let totalStrength = 0;
    let signalCount = 0;
    
    // VWAP signal (weight: 2)
    if (vwapSignal.valid) {
      const vwapValue = vwapSignal.signal === 'BUY' ? vwapSignal.strength : 
                        vwapSignal.signal === 'SELL' ? -vwapSignal.strength : 0;
      totalStrength += vwapValue * 2;
      signalCount += 2;
    }
    
    // RSI signal (weight: 1.5)
    if (rsiSignal.valid) {
      const rsiValue = rsiSignal.signal === 'BUY' ? rsiSignal.strength : 
                       rsiSignal.signal === 'SELL' ? -rsiSignal.strength : 0;
      totalStrength += rsiValue * 1.5;
      signalCount += 1.5;
    }
    
    // EMA signal (weight: 1)
    if (emaSignal.valid) {
      const emaValue = emaSignal.signal === 'BUY' ? emaSignal.strength : 
                       emaSignal.signal === 'SELL' ? -emaSignal.strength : 0;
      totalStrength += emaValue;
      signalCount += 1;
    }
    
    // MACD signal (weight: 1.5)
    if (macdSignal.valid) {
      const macdValue = macdSignal.signal === 'BUY' ? macdSignal.strength : 
                        macdSignal.signal === 'SELL' ? -macdSignal.strength : 0;
      totalStrength += macdValue * 1.5;
      signalCount += 1.5;
    }
    
    // Orderbook signal (weight: 3)
    const orderbookValue = orderbookSignal.signal === 'BUY' ? 1 : 
                           orderbookSignal.signal === 'SELL' ? -1 : 0;
    totalStrength += orderbookValue * 3 * Math.abs(orderbookSignal.overallScore);
    signalCount += 3;
    
    // Normalize to -5 to 5 range
    return signalCount > 0 ? (totalStrength / signalCount) * 5 : 0;
  }
}

module.exports = new ScalpingStrategy();