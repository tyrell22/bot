/**
 * Moving Average Convergence Divergence (MACD) indicator
 * MACD is a trend-following momentum indicator that shows the relationship
 * between two moving averages of a security's price.
 */
const { MACD } = require('technicalindicators');
const config = require('../config').indicators.macd;

class MACDIndicator {
  constructor() {
    this.macdData = {};
    this.fastPeriod = config.fastPeriod;
    this.slowPeriod = config.slowPeriod;
    this.signalPeriod = config.signalPeriod;
  }
  
  /**
   * Calculate MACD for a symbol based on candles
   * @param {string} symbol - The trading pair symbol
   * @param {Array} candles - Array of candle data
   * @returns {Object} - MACD calculation result
   */
  calculate(symbol, candles) {
    if (!candles || candles.length === 0) {
      return {
        valid: false,
        message: 'No candle data provided'
      };
    }
    
    // Sort candles by timestamp (ascending)
    candles = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    
    // Extract close prices
    const closePrices = candles.map(candle => candle.close);
    
    // Calculate MACD
    const macdResult = MACD.calculate({
      values: closePrices,
      fastPeriod: this.fastPeriod,
      slowPeriod: this.slowPeriod,
      signalPeriod: this.signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
    
    // Create MACD points with timestamps
    const macdPoints = [];
    const startIndex = candles.length - macdResult.length;
    
    for (let i = 0; i < macdResult.length; i++) {
      macdPoints.push({
        timestamp: candles[i + startIndex].timestamp,
        MACD: macdResult[i].MACD,
        signal: macdResult[i].signal,
        histogram: macdResult[i].histogram
      });
    }
    
    // Store MACD data for this symbol
    this.macdData[symbol] = {
      current: macdPoints[macdPoints.length - 1],
      points: macdPoints,
      fastPeriod: this.fastPeriod,
      slowPeriod: this.slowPeriod,
      signalPeriod: this.signalPeriod
    };
    
    return {
      valid: true,
      ...this.macdData[symbol]
    };
  }
  
  /**
   * Get MACD data for a specific symbol
   * @param {string} symbol - The trading pair symbol
   * @returns {Object|null} - MACD data or null if not available
   */
  getMacd(symbol) {
    return this.macdData[symbol] || null;
  }
  
  /**
   * Check for MACD crossovers
   * @param {string} symbol - The trading pair symbol
   * @returns {Object} - Crossover analysis
   */
  checkCrossovers(symbol) {
    if (!this.macdData[symbol] || !this.macdData[symbol].points || this.macdData[symbol].points.length < 2) {
      return {
        valid: false,
        message: 'Insufficient MACD data for crossover analysis'
      };
    }
    
    const points = this.macdData[symbol].points;
    const current = points[points.length - 1];
    const previous = points[points.length - 2];
    
    // Check MACD line crossing signal line
    const crossover = (previous.MACD <= previous.signal && current.MACD > current.signal) ||
                      (previous.MACD >= previous.signal && current.MACD < current.signal);
    
    // Determine crossover direction
    const bullishCrossover = previous.MACD <= previous.signal && current.MACD > current.signal;
    const bearishCrossover = previous.MACD >= previous.signal && current.MACD < current.signal;
    
    // Check histogram changing direction
    const histogramDirectionChange = (previous.histogram <= 0 && current.histogram > 0) ||
                                    (previous.histogram >= 0 && current.histogram < 0);
    
    return {
      valid: true,
      crossover,
      bullishCrossover,
      bearishCrossover,
      histogramDirectionChange,
      histogramIncreasing: current.histogram > previous.histogram,
      histogramDecreasing: current.histogram < previous.histogram
    };
  }
  
  /**
   * Check for MACD divergence (price making new highs/lows but MACD isn't)
   * @param {string} symbol - The trading pair symbol
   * @param {Array} candles - Recent candle data
   * @param {number} lookback - Number of candles to look back
   * @returns {Object} - Divergence analysis
   */
  checkDivergence(symbol, candles, lookback = 5) {
    if (!this.macdData[symbol] || !this.macdData[symbol].points || this.macdData[symbol].points.length < lookback) {
      return {
        valid: false,
        message: 'Insufficient MACD data for divergence analysis'
      };
    }
    
    if (!candles || candles.length < lookback) {
      return {
        valid: false,
        message: 'Insufficient candle data for divergence analysis'
      };
    }
    
    // Sort candles by timestamp (ascending)
    candles = [...candles].sort((a, b) => a.timestamp - b.timestamp).slice(-lookback);
    
    // Get MACD values for the corresponding period
    const macdValues = this.macdData[symbol].points
      .filter(point => candles.some(candle => candle.timestamp === point.timestamp))
      .map(point => point.MACD);
    
    if (macdValues.length < 2) {
      return {
        valid: false,
        message: 'Insufficient matching MACD points for divergence analysis'
      };
    }
    
    // Find highs and lows
    const highPrices = candles.map(candle => candle.high);
    const lowPrices = candles.map(candle => candle.low);
    
    const maxPrice = Math.max(...highPrices);
    const minPrice = Math.min(...lowPrices);
    const maxMacd = Math.max(...macdValues);
    const minMacd = Math.min(...macdValues);
    
    // Check for bearish divergence
    // Price making higher highs but MACD making lower highs
    const priceHighIndex = highPrices.lastIndexOf(maxPrice);
    const macdHighIndex = macdValues.lastIndexOf(maxMacd);
    
    const bearishDivergence = priceHighIndex > macdHighIndex && priceHighIndex === highPrices.length - 1;
    
    // Check for bullish divergence
    // Price making lower lows but MACD making higher lows
    const priceLowIndex = lowPrices.lastIndexOf(minPrice);
    const macdLowIndex = macdValues.lastIndexOf(minMacd);
    
    const bullishDivergence = priceLowIndex > macdLowIndex && priceLowIndex === lowPrices.length - 1;
    
    return {
      valid: true,
      bullishDivergence,
      bearishDivergence
    };
  }
  
  /**
   * Get a trading signal based on MACD analysis
   * @param {string} symbol - The trading pair symbol
   * @returns {Object} - The trading signal
   */
  getSignal(symbol) {
    if (!this.macdData[symbol] || !this.macdData[symbol].points || this.macdData[symbol].points.length < 2) {
      return {
        valid: false,
        message: 'Insufficient MACD data for signal generation'
      };
    }
    
    const crossovers = this.checkCrossovers(symbol);
    
    if (!crossovers.valid) {
      return {
        valid: false,
        message: 'Could not analyze MACD data'
      };
    }
    
    const points = this.macdData[symbol].points;
    const current = points[points.length - 1];
    
    let signal = 'NEUTRAL';
    let strength = 0;
    
    // Bullish signal: MACD crosses above signal line
    if (crossovers.bullishCrossover) {
      signal = 'BUY';
      strength = 2;
      
      // Stronger if MACD and histogram are both positive
      if (current.MACD > 0 && current.histogram > 0) {
        strength = 3;
      }
    }
    // Bearish signal: MACD crosses below signal line
    else if (crossovers.bearishCrossover) {
      signal = 'SELL';
      strength = 2;
      
      // Stronger if MACD and histogram are both negative
      if (current.MACD < 0 && current.histogram < 0) {
        strength = 3;
      }
    }
    // Weakening bullish trend: MACD above signal line but histogram decreasing
    else if (current.MACD > current.signal && crossovers.histogramDecreasing) {
      signal = 'BUY';
      strength = 1;
    }
    // Weakening bearish trend: MACD below signal line but histogram increasing
    else if (current.MACD < current.signal && crossovers.histogramIncreasing) {
      signal = 'SELL';
      strength = 1;
    }
    
    return {
      valid: true,
      signal,
      strength,
      crossovers,
      current
    };
  }
}

module.exports = new MACDIndicator();