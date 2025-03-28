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
 * Process new data from WebSocket with detailed info-level logging
 * @param {string} dataType - Type of data update
 * @param {Object} data - The data update
 */
update(dataType, data) {
  try {
    if (!data || !data.symbol) {
      logger.info(`Invalid data received: ${JSON.stringify(data)}`);
      return;
    }
    
    const { symbol } = data;
    logger.info(`Received ${dataType} update for ${symbol}`);
    
    // Initialize symbol data structure if needed
    if (!this.symbolData[symbol]) {
      this.symbolData[symbol] = {
        klines: {},
        orderbook: null,
        ticker: null,
        lastAnalysis: 0
      };
      logger.info(`Added new symbol to analysis list: ${symbol}`);
    }
    
    // Update symbol data with detailed error handling
    try {
      switch (dataType) {
        case 'kline':
          if (!data.timeframe || !data.data) {
            logger.info(`Invalid kline data for ${symbol}: missing timeframe or data`);
            return;
          }
          this.symbolData[symbol].klines[data.timeframe] = data.data;
          logger.info(`Updated klines for ${symbol} (${data.timeframe}): ${data.data.length} candles`);
          break;
          
        case 'orderbook':
          if (!data.data || !data.data.bids || !data.data.asks) {
            logger.info(`Invalid orderbook data for ${symbol}: missing fields`);
            return;
          }
          this.symbolData[symbol].orderbook = data.data;
          logger.info(`Updated orderbook for ${symbol}: ${data.data.bids.length} bids, ${data.data.asks.length} asks`);
          break;
          
        case 'ticker':
          if (!data.data || typeof data.data.lastPrice === 'undefined') {
            logger.info(`Invalid ticker data for ${symbol}: missing lastPrice`);
            return;
          }
          this.symbolData[symbol].ticker = data.data;
          logger.info(`Updated ticker for ${symbol}: price ${data.data.lastPrice}`);
          break;
          
        default:
          logger.info(`Unknown data type: ${dataType}`);
          return;
      }
    } catch (dataError) {
      logger.info(`Error updating ${dataType} data for ${symbol}: ${dataError.message}`);
      return;
    }
    
    // Track symbols for analysis
    this.analyzedSymbols.add(symbol);
    
    // Throttle analysis to avoid excessive CPU usage
    const now = Date.now();
    const cooldownPeriod = 1000; // 1 second between analyses for same symbol
    
    if (now - this.symbolData[symbol].lastAnalysis > cooldownPeriod) {
      logger.info(`Triggering analysis for ${symbol}`);
      this.symbolData[symbol].lastAnalysis = now;
      
      // Use try-catch here as well to ensure errors in analyzeSymbol don't crash the update method
      try {
        this.analyzeSymbol(symbol);
      } catch (analysisError) {
        logger.info(`Unhandled error in analyzeSymbol for ${symbol}: ${analysisError.message}`);
        logger.info(analysisError.stack);
      }
    }
  } catch (error) {
    logger.info(`Critical error in update method: ${error.message}`);
    logger.info(error.stack);
  }
}

/**
 * Check if we have all required data for analysis with info-level logging
 * @param {Object} symbolData - Data for a specific symbol
 * @param {string} symbol - Symbol being analyzed (for logging)
 * @returns {boolean} - Whether we have enough data
 */
hasRequiredData(symbolData, symbol) {
  // Check if we have ticker data
  if (!symbolData.ticker) {
    logger.info(`${symbol}: Missing ticker data`);
    return false;
  }
  
  // Check ticker has required fields
  if (typeof symbolData.ticker.lastPrice === 'undefined') {
    logger.info(`${symbol}: Ticker missing lastPrice field`);
    return false;
  }
  
  // Check if we have orderbook data
  if (!symbolData.orderbook) {
    logger.info(`${symbol}: Missing orderbook data`);
    return false;
  }
  
  // Check orderbook has required fields
  if (!symbolData.orderbook.bids || !symbolData.orderbook.asks) {
    logger.info(`${symbol}: Orderbook missing bids or asks`);
    return false;
  }
  
  // Check if we have kline data for main timeframe
  if (!symbolData.klines[config.mainTimeframe]) {
    logger.info(`${symbol}: Missing klines for ${config.mainTimeframe} timeframe`);
    return false;
  }
  
  // Check if we have enough klines
  if (symbolData.klines[config.mainTimeframe].length < 50) {
    logger.info(`${symbol}: Not enough klines for ${config.mainTimeframe} timeframe (${symbolData.klines[config.mainTimeframe].length}/50 required)`);
    return false;
  }
  
  logger.info(`${symbol}: All required data is available for analysis`);
  return true;
}

/**
 * Analyze a symbol for trading opportunities with verbose info-level logging
 * @param {string} symbol - The trading pair symbol
 */
analyzeSymbol(symbol) {
  logger.info(`Starting analysis for ${symbol}`);
  
  try {
    const symbolData = this.symbolData[symbol];
    
    if (!symbolData) {
      logger.info(`${symbol}: No data found for this symbol`);
      return;
    }
    
    // Log data state
    logger.info(`${symbol} data state: 
    - Ticker: ${symbolData.ticker ? 'Present' : 'Missing'}
    - Orderbook: ${symbolData.orderbook ? 'Present' : 'Missing'}
    - Klines: ${Object.keys(symbolData.klines).map(tf => `${tf}: ${symbolData.klines[tf] ? symbolData.klines[tf].length : 0} candles`).join(', ')}
    `);
    
    // Skip if we don't have all necessary data
    if (!this.hasRequiredData(symbolData, symbol)) {
      logger.info(`${symbol}: Skipping analysis due to missing required data`);
      return;
    }
    
    // Skip if we're in a signal cooldown period
    if (this.lastSignals[symbol] && Date.now() - this.lastSignals[symbol] < this.signalCooldown) {
      logger.info(`${symbol}: In cooldown period, next analysis in ${Math.round((this.lastSignals[symbol] + this.signalCooldown - Date.now()) / 1000)}s`);
      return;
    }
    
    // Get current market data
    const ticker = symbolData.ticker;
    const orderbook = symbolData.orderbook;
    const mainTimeframeKlines = symbolData.klines[config.mainTimeframe];
    
    logger.info(`${symbol}: Running technical analysis with ${mainTimeframeKlines.length} candles`);
    
    // Run technical indicator calculations with detailed error handling
    let vwapResult, rsiResult, emaResult, macdResult, orderbookResult;
    
    try {
      logger.info(`${symbol}: Calculating VWAP...`);
      vwapResult = vwap.calculate(symbol, mainTimeframeKlines);
      logger.info(`${symbol}: VWAP calculation ${vwapResult.valid ? 'successful' : 'failed'}`);
    } catch (e) {
      logger.info(`${symbol}: Error calculating VWAP: ${e.message}`);
      return;
    }
    
    try {
      logger.info(`${symbol}: Calculating RSI...`);
      rsiResult = rsi.calculate(symbol, mainTimeframeKlines);
      logger.info(`${symbol}: RSI calculation ${rsiResult.valid ? 'successful' : 'failed'}`);
    } catch (e) {
      logger.info(`${symbol}: Error calculating RSI: ${e.message}`);
      return;
    }
    
    try {
      logger.info(`${symbol}: Calculating EMA...`);
      emaResult = ema.calculate(symbol, mainTimeframeKlines);
      logger.info(`${symbol}: EMA calculation ${emaResult.valid ? 'successful' : 'failed'}`);
    } catch (e) {
      logger.info(`${symbol}: Error calculating EMA: ${e.message}`);
      return;
    }
    
    try {
      logger.info(`${symbol}: Calculating MACD...`);
      macdResult = macd.calculate(symbol, mainTimeframeKlines);
      logger.info(`${symbol}: MACD calculation ${macdResult.valid ? 'successful' : 'failed'}`);
    } catch (e) {
      logger.info(`${symbol}: Error calculating MACD: ${e.message}`);
      return;
    }
    
    try {
      logger.info(`${symbol}: Analyzing orderbook...`);
      orderbookResult = orderbookAnalyzer.getFullAnalysis(symbol, orderbook);
      logger.info(`${symbol}: Orderbook analysis completed with signal: ${orderbookResult.signal}`);
    } catch (e) {
      logger.info(`${symbol}: Error analyzing orderbook: ${e.message}`);
      return;
    }
    
    // Skip if any analysis failed
    if (!vwapResult.valid || !rsiResult.valid || !emaResult.valid || !macdResult.valid || !orderbookResult.signal) {
      logger.info(`${symbol}: Skipping signal generation due to invalid analysis results`);
      return;
    }
    
    logger.info(`${symbol}: All technical indicators calculated successfully`);
    
    // Get current price and calculate indicator signals
    const currentPrice = ticker.lastPrice;
    
    try {
      logger.info(`${symbol}: Getting individual indicator signals...`);
      const vwapSignal = vwap.getSignal(symbol, currentPrice);
      const rsiSignal = rsi.getSignal(symbol, mainTimeframeKlines);
      const emaSignal = ema.getSignal(symbol, currentPrice);
      const macdSignal = macd.getSignal(symbol);
      
      logger.info(`${symbol}: Individual signals - VWAP: ${vwapSignal.signal}, RSI: ${rsiSignal.signal}, EMA: ${emaSignal.signal}, MACD: ${macdSignal.signal}, Orderbook: ${orderbookResult.signal}`);
      
      // Calculate combined signal
      logger.info(`${symbol}: Calculating combined signal strength...`);
      const signalStrength = this.calculateSignalStrength(
        vwapSignal,
        rsiSignal,
        emaSignal,
        macdSignal,
        orderbookResult
      );
      
      logger.info(`${symbol}: Combined signal strength: ${signalStrength.toFixed(2)}`);
      
      // Generate signal if strong enough
      if (Math.abs(signalStrength) >= 2) {
        const direction = signalStrength > 0 ? 'BUY' : 'SELL';
        
        logger.info(`${symbol}: Signal strength ${Math.abs(signalStrength)} exceeds threshold, generating ${direction} signal`);
        
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
        logger.info(`${symbol}: Emitting ${direction} signal`);
        this.emit('signal', signal);
        
        // Set cooldown
        this.lastSignals[symbol] = Date.now();
        
        logger.info(`${symbol}: ${direction} signal emitted successfully, cooldown set`);
      } else {
        logger.info(`${symbol}: Signal strength ${Math.abs(signalStrength)} below threshold (2.0), no signal generated`);
      }
    } catch (signalError) {
      logger.info(`${symbol}: Error generating signals: ${signalError.message}`);
    }
    
    logger.info(`${symbol}: Analysis completed`);
  } catch (error) {
    logger.info(`${symbol}: Uncaught error during analysis: ${error.message}`);
    logger.info(error.stack);
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