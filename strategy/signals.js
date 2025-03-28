/**
 * Improved Scalping strategy for short-term trading
 * Uses step-by-step data collection before triggering analysis
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
    
    // Minimum required klines - smaller number to make analysis trigger sooner
    this.minRequiredKlines = 50; // Very low number to ensure we get started
    
    // Track data status for each symbol
    this.dataStatus = {};
  }
  
  /**
   * Initialize the scalping strategy
   * @param {Object} wsManager - WebSocket manager
   * @param {Object} dataCollector - Data collector
   */
  init(wsManager, dataCollector) {
    this.wsManager = wsManager;
    this.dataCollector = dataCollector;
    
    logger.debug('Improved Scalping strategy initialized');
    
    return true;
  }
  
  /**
   * Process new data from WebSocket with methodical approach
   * @param {string} dataType - Type of data update
   * @param {Object} data - The data update
   */
  update(dataType, data) {
    try {
      if (!data || !data.symbol) {
        logger.debug(`Invalid data received: ${JSON.stringify(data)}`);
        return;
      }
      
      const { symbol } = data;
      
      // Initialize symbol data structure if needed
      if (!this.symbolData[symbol]) {
        this.symbolData[symbol] = {
          klines: {},
          orderbook: null,
          ticker: null,
          lastAnalysis: 0
        };
        
        // Initialize data status tracking
        this.dataStatus[symbol] = {
          hasTickerData: false,
          hasOrderbookData: false,
          hasKlineData: false,
          readyForAnalysis: false,
          lastCheck: Date.now()
        };
        
        logger.debug(`Added new symbol to analysis list: ${symbol}`);
      }
      
      // Update symbol data based on type
      switch (dataType) {
        case 'kline':
          this.updateKlineData(symbol, data);
          break;
            
        case 'orderbook':
          this.updateOrderbookData(symbol, data);
          break;
            
        case 'ticker':
          this.updateTickerData(symbol, data);
          break;
            
        default:
          logger.debug(`Unknown data type: ${dataType}`);
          return;
      }
      
      // Check data status every time we get an update
      this.checkDataStatus(symbol);
      
      // If ready for analysis and not in cooldown, trigger it
      if (this.dataStatus[symbol].readyForAnalysis) {
        const now = Date.now();
        const cooldownPeriod = 1000; // 1 second between analyses
        
        if (now - this.symbolData[symbol].lastAnalysis > cooldownPeriod) {
          logger.debug(`${symbol} is ready for analysis, triggering now`);
          this.symbolData[symbol].lastAnalysis = now;
          
          try {
            this.analyzeSymbol(symbol);
          } catch (analysisError) {
            logger.error(`Error in analyzeSymbol for ${symbol}: ${analysisError.message}`);
            logger.error(analysisError.stack);
          }
        }
      }
    } catch (error) {
      logger.error(`Critical error in update method: ${error.message}`);
      logger.error(error.stack);
    }
  }
  
  /**
   * Update kline data for a symbol
   * @param {string} symbol - Symbol to update
   * @param {Object} data - Kline data
   */
  updateKlineData(symbol, data) {
    if (!data.timeframe || !data.data || !Array.isArray(data.data)) {
      logger.debug(`Invalid kline data for ${symbol}: ${JSON.stringify(data)}`);
      return;
    }
    
    // Ensure we have a valid array of klines
    if (data.data.length === 0) {
      logger.debug(`Empty kline data for ${symbol} (${data.timeframe})`);
      return;
    }
    
    // Save the kline data
    this.symbolData[symbol].klines[data.timeframe] = data.data;
    
    // Check if we have klines for main timeframe
    const mainTf = config.mainTimeframe;
    const hasMainTimeframe = this.symbolData[symbol].klines[mainTf] && 
                          this.symbolData[symbol].klines[mainTf].length >= this.minRequiredKlines;
    
    // Update status
    this.dataStatus[symbol].hasKlineData = hasMainTimeframe;
  }
  
  /**
   * Update orderbook data for a symbol
   * @param {string} symbol - Symbol to update
   * @param {Object} data - Orderbook data
   */
  updateOrderbookData(symbol, data) {
    if (!data.data || !data.data.bids || !data.data.asks) {
      logger.debug(`Invalid orderbook data for ${symbol}`);
      return;
    }
    
    // Save the orderbook data
    this.symbolData[symbol].orderbook = data.data;
    
    // Update status
    this.dataStatus[symbol].hasOrderbookData = true;
  }
  
  /**
   * Update ticker data for a symbol
   * @param {string} symbol - Symbol to update
   * @param {Object} data - Ticker data
   */
  updateTickerData(symbol, data) {
    if (!data.data || typeof data.data.lastPrice === 'undefined') {
      logger.debug(`Invalid ticker data for ${symbol}`);
      return;
    }
    
    // Save the ticker data
    this.symbolData[symbol].ticker = data.data;
    
    // Update status
    this.dataStatus[symbol].hasTickerData = true;
  }
  
  /**
   * Check data status for a symbol and mark as ready for analysis if all data is present
   * @param {string} symbol - Symbol to check
   */
  checkDataStatus(symbol) {
    // Get current status
    const status = this.dataStatus[symbol];
    
    // Check if all required data is present
    const isReady = status.hasTickerData && status.hasOrderbookData && status.hasKlineData;
    
    // Update status
    status.readyForAnalysis = isReady;
    status.lastCheck = Date.now();
    
    // Log status changes (but not too often)
    if (Math.random() < 0.05) { // Only log occasionally to avoid spam
    }
    
    // If we just became ready, log it explicitly
    if (isReady && !this.dataStatus[symbol].wasReadyBefore) {
      logger.debug(`${symbol} is now READY for analysis with all required data`);
      this.dataStatus[symbol].wasReadyBefore = true;
      
      // Print data summary
      this.logDataSummary(symbol);
    }
  }
  
  /**
   * Log a summary of the data we have for a symbol
   * @param {string} symbol - Symbol to log data for
   */
  logDataSummary(symbol) {
    const symbolData = this.symbolData[symbol];
    
    // Ticker summary
    const ticker = symbolData.ticker ? {
      price: symbolData.ticker.lastPrice,
      volume: symbolData.ticker.volume24h,
      present: true
    } : { present: false };
    
    // Orderbook summary
    const orderbook = symbolData.orderbook ? {
      bidCount: symbolData.orderbook.bids.length,
      askCount: symbolData.orderbook.asks.length,
      present: true
    } : { present: false };
    
    // Klines summary
    const klines = {};
    for (const [timeframe, data] of Object.entries(symbolData.klines)) {
      klines[timeframe] = {
        count: data.length,
        present: data.length > 0
      };
    }
    
    logger.debug(`DATA SUMMARY FOR ${symbol}:
    Ticker: ${JSON.stringify(ticker)}
    Orderbook: ${JSON.stringify(orderbook)}
    Klines: ${JSON.stringify(klines)}
    `);
  }
  
  /**
   * Analyze a symbol for trading opportunities
   * @param {string} symbol - The trading pair symbol
   */
  analyzeSymbol(symbol) {
    logger.debug(`STARTING ANALYSIS FOR ${symbol} ==================`);
    
    try {
      const symbolData = this.symbolData[symbol];
      
      if (!symbolData) {
        logger.warn(`No data found for ${symbol}`);
        return;
      }
      
      // Skip if we're in a signal cooldown period
      if (this.lastSignals[symbol] && Date.now() - this.lastSignals[symbol] < this.signalCooldown) {
        logger.debug(`${symbol}: In cooldown period, next analysis in ${Math.round((this.lastSignals[symbol] + this.signalCooldown - Date.now()) / 1000)}s`);
        return;
      }
      
      // Get current market data
      const ticker = symbolData.ticker;
      const orderbook = symbolData.orderbook;
      const mainTimeframeKlines = symbolData.klines[config.mainTimeframe];
      
      logger.debug(`${symbol}: Running technical analysis with ${mainTimeframeKlines.length} candles`);
      
      // Run technical indicator calculations with detailed error handling
      let vwapResult, rsiResult, emaResult, macdResult, orderbookResult;
      
      try {
        logger.debug(`${symbol}: Calculating VWAP...`);
        vwapResult = vwap.calculate(symbol, mainTimeframeKlines);
        logger.debug(`${symbol}: VWAP calculation ${vwapResult.valid ? 'successful' : 'failed'}`);
        
        if (!vwapResult.valid) {
          logger.warn(`${symbol}: VWAP calculation failed: ${vwapResult.message}`);
          return;
        }
      } catch (e) {
        logger.error(`${symbol}: Error calculating VWAP: ${e.message}`);
        return;
      }
      
      try {
        logger.debug(`${symbol}: Calculating RSI...`);
        rsiResult = rsi.calculate(symbol, mainTimeframeKlines);
        logger.debug(`${symbol}: RSI calculation ${rsiResult.valid ? 'successful' : 'failed'}`);
        
        if (!rsiResult.valid) {
          logger.warn(`${symbol}: RSI calculation failed: ${rsiResult.message}`);
          return;
        }
      } catch (e) {
        logger.error(`${symbol}: Error calculating RSI: ${e.message}`);
        return;
      }
      
      try {
        logger.debug(`${symbol}: Calculating EMA...`);
        emaResult = ema.calculate(symbol, mainTimeframeKlines);
        logger.debug(`${symbol}: EMA calculation ${emaResult.valid ? 'successful' : 'failed'}`);
        
        if (!emaResult.valid) {
          logger.warn(`${symbol}: EMA calculation failed: ${emaResult.message}`);
          return;
        }
      } catch (e) {
        logger.error(`${symbol}: Error calculating EMA: ${e.message}`);
        return;
      }
      
      try {
        logger.debug(`${symbol}: Calculating MACD...`);
        macdResult = macd.calculate(symbol, mainTimeframeKlines);
        logger.debug(`${symbol}: MACD calculation ${macdResult.valid ? 'successful' : 'failed'}`);
        
        if (!macdResult.valid) {
          logger.warn(`${symbol}: MACD calculation failed: ${macdResult.message}`);
          return;
        }
      } catch (e) {
        logger.error(`${symbol}: Error calculating MACD: ${e.message}`);
        return;
      }
      
      try {
        logger.debug(`${symbol}: Analyzing orderbook...`);
        orderbookResult = orderbookAnalyzer.getFullAnalysis(symbol, orderbook);
        logger.debug(`${symbol}: Orderbook analysis completed with signal: ${orderbookResult.signal}`);
        
        if (!orderbookResult.signal) {
          logger.warn(`${symbol}: Orderbook analysis failed to generate signal`);
          return;
        }
      } catch (e) {
        logger.error(`${symbol}: Error analyzing orderbook: ${e.message}`);
        return;
      }
      
      logger.debug(`${symbol}: All technical indicators calculated successfully`);
      
      // Get current price and calculate indicator signals
      const currentPrice = ticker.lastPrice;
      
      try {
        logger.debug(`${symbol}: Getting individual indicator signals...`);
        const vwapSignal = vwap.getSignal(symbol, currentPrice);
        const rsiSignal = rsi.getSignal(symbol, mainTimeframeKlines);
        const emaSignal = ema.getSignal(symbol, currentPrice);
        const macdSignal = macd.getSignal(symbol);
        
        logger.debug(`${symbol}: Individual signals - VWAP: ${vwapSignal.signal}, RSI: ${rsiSignal.signal}, EMA: ${emaSignal.signal}, MACD: ${macdSignal.signal}, Orderbook: ${orderbookResult.signal}`);
        
        // Calculate combined signal
        logger.debug(`${symbol}: Calculating combined signal strength...`);
        const signalStrength = this.calculateSignalStrength(
          vwapSignal,
          rsiSignal,
          emaSignal,
          macdSignal,
          orderbookResult
        );
        
        logger.debug(`${symbol}: Combined signal strength: ${signalStrength.toFixed(2)}`);
        
        // Generate signal if strong enough
        if (Math.abs(signalStrength) >= 2) {
          const direction = signalStrength > 0 ? 'BUY' : 'SELL';
          
          logger.debug(`${symbol}: Signal strength ${Math.abs(signalStrength)} exceeds threshold, generating ${direction} signal`);
          
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
          logger.debug(`${symbol}: Emitting ${direction} signal`);
          this.emit('signal', signal);
          
          // Set cooldown
          this.lastSignals[symbol] = Date.now();
          
          logger.debug(`${symbol}: ${direction} signal emitted successfully, cooldown set`);
        } else {
          logger.debug(`${symbol}: Signal strength ${Math.abs(signalStrength)} below threshold (2.0), no signal generated`);
        }
      } catch (signalError) {
        logger.error(`${symbol}: Error generating signals: ${signalError.message}`);
        logger.error(signalError.stack);
      }
      
      logger.debug(`${symbol}: Analysis completed`);
    } catch (error) {
      logger.error(`${symbol}: Uncaught error during analysis: ${error.message}`);
      logger.error(error.stack);
    }
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
    if (vwapSignal && vwapSignal.valid) {
      const vwapValue = vwapSignal.signal === 'BUY' ? vwapSignal.strength : 
                        vwapSignal.signal === 'SELL' ? -vwapSignal.strength : 0;
      totalStrength += vwapValue * 2;
      signalCount += 2;
    }
    
    // RSI signal (weight: 1.5)
    if (rsiSignal && rsiSignal.valid) {
      const rsiValue = rsiSignal.signal === 'BUY' ? rsiSignal.strength : 
                       rsiSignal.signal === 'SELL' ? -rsiSignal.strength : 0;
      totalStrength += rsiValue * 1.5;
      signalCount += 1.5;
    }
    
    // EMA signal (weight: 1)
    if (emaSignal && emaSignal.valid) {
      const emaValue = emaSignal.signal === 'BUY' ? emaSignal.strength : 
                       emaSignal.signal === 'SELL' ? -emaSignal.strength : 0;
      totalStrength += emaValue;
      signalCount += 1;
    }
    
    // MACD signal (weight: 1.5)
    if (macdSignal && macdSignal.valid) {
      const macdValue = macdSignal.signal === 'BUY' ? macdSignal.strength : 
                        macdSignal.signal === 'SELL' ? -macdSignal.strength : 0;
      totalStrength += macdValue * 1.5;
      signalCount += 1.5;
    }
    
    // Orderbook signal (weight: 3)
    if (orderbookSignal && orderbookSignal.signal) {
      const orderbookValue = orderbookSignal.signal === 'BUY' ? 1 : 
                            orderbookSignal.signal === 'SELL' ? -1 : 0;
      totalStrength += orderbookValue * 3 * Math.abs(orderbookSignal.overallScore || 0.5);
      signalCount += 3;
    }
    
    // Normalize to -5 to 5 range
    return signalCount > 0 ? (totalStrength / signalCount) * 5 : 0;
  }
}

module.exports = new ScalpingStrategy();