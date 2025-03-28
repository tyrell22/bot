/**
 * Relative Strength Index (RSI) indicator
 * RSI measures the magnitude of recent price changes to evaluate
 * overbought or oversold conditions in the price of an asset.
 */
const { RSI } = require('technicalindicators');
const config = require('../config').indicators.rsi;

class RSIIndicator {
  constructor() {
    this.rsiData = {};
    this.period = config.period;
    this.overbought = config.overbought;
    this.oversold = config.oversold;
  }
  
  /**
   * Calculate RSI for a symbol based on candles
   * @param {string} symbol - The trading pair symbol
   * @param {Array} candles - Array of candle data
   * @param {number} period - RSI period (default: 14)
   * @returns {Object} - RSI calculation result
   */
  calculate(symbol, candles, period = this.period) {
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
    
    // Calculate RSI
    const rsiValues = RSI.calculate({
      values: closePrices,
      period
    });
    
    // Merge with timestamps
    const rsiPoints = [];
    
    // The RSI calculation returns an array with undefined values for the first 'period' entries,
    // so we need to align the timestamps correctly
    for (let i = period; i < candles.length; i++) {
      rsiPoints.push({
        timestamp: candles[i].timestamp,
        value: rsiValues[i - period]
      });
    }
    
    // Store RSI data for this symbol
    this.rsiData[symbol] = {
      current: rsiPoints[rsiPoints.length - 1].value,
      points: rsiPoints,
      period
    };
    
    return {
      valid: true,
      ...this.rsiData[symbol]
    };
  }
  
  /**
   * Get RSI data for a specific symbol
   * @param {string} symbol - The trading pair symbol
   * @returns {Object|null} - RSI data or null if not available
   */
  getRsi(symbol) {
    return this.rsiData[symbol] || null;
  }
  
  /**
   * Check if RSI indicates overbought or oversold conditions
   * @param {string} symbol - The trading pair symbol
   * @param {number} overbought - Overbought threshold (default: 70)
   * @param {number} oversold - Oversold threshold (default: 30)
   * @returns {Object} - Condition check result
   */
  checkConditions(symbol, overbought = this.overbought, oversold = this.oversold) {
    if (!this.rsiData[symbol]) {
      return {
        valid: false,
        message: 'No RSI data available for this symbol'
      };
    }
    
    const rsi = this.rsiData[symbol].current;
    
    return {
      valid: true,
      rsi,
      overbought: rsi >= overbought,
      oversold: rsi <= oversold,
      neutral: rsi > oversold && rsi < overbought
    };
  }
  
  /**
   * Check for RSI divergence (price making new highs/lows but RSI isn't)
   * @param {string} symbol - The trading pair symbol
   * @param {Array} candles - Recent candle data
   * @param {number} lookback - Number of candles to look back
   * @returns {Object} - Divergence analysis
   */
  checkDivergence(symbol, candles, lookback = 5) {
    if (!this.rsiData[symbol] || !this.rsiData[symbol].points || this.rsiData[symbol].points.length < 2) {
      return {
        valid: false,
        message: 'Insufficient RSI data for divergence analysis'
      };
    }
    
    if (!candles || candles.length < lookback) {
      return {
        valid: false,
        message: 'Insufficient candle data for divergence analysis'
      };
    }
    
    // Get recent candles and RSI points
    const recentCandles = [...candles].sort((a, b) => a.timestamp - b.timestamp).slice(-lookback);
    
    // Find matching RSI points for these candles
    const recentRsiPoints = this.rsiData[symbol].points.filter(
      point => recentCandles.some(candle => candle.timestamp === point.timestamp)
    );
    
    if (recentRsiPoints.length < 2) {
      return {
        valid: false,
        message: 'Insufficient matching RSI points for divergence analysis'
      };
    }
    
    // Check for highs and lows
    const highPrices = recentCandles.map(candle => candle.high);
    const lowPrices = recentCandles.map(candle => candle.low);
    const rsiValues = recentRsiPoints.map(point => point.value);
    
    const maxPrice = Math.max(...highPrices);
    const minPrice = Math.min(...lowPrices);
    const maxRsi = Math.max(...rsiValues);
    const minRsi = Math.min(...rsiValues);
    
    // Check for bullish divergence (price making lower lows but RSI making higher lows)
    const priceIndex = lowPrices.indexOf(minPrice);
    const rsiIndex = rsiValues.indexOf(minRsi);
    
    const bullishDivergence = priceIndex !== rsiIndex && 
      priceIndex > rsiIndex && 
      recentRsiPoints[recentRsiPoints.length - 1].value > minRsi;
    
    // Check for bearish divergence (price making higher highs but RSI making lower highs)
    const priceHighIndex = highPrices.indexOf(maxPrice);
    const rsiHighIndex = rsiValues.indexOf(maxRsi);
    
    const bearishDivergence = priceHighIndex !== rsiHighIndex && 
      priceHighIndex > rsiHighIndex && 
      recentRsiPoints[recentRsiPoints.length - 1].value < maxRsi;
    
    return {
      valid: true,
      bullishDivergence,
      bearishDivergence,
      recentCandles,
      recentRsiPoints
    };
  }
  
  /**
   * Get a trading signal based on RSI conditions
   * @param {string} symbol - The trading pair symbol
   * @param {Array} candles - Recent candle data for divergence check
   * @returns {Object} - The trading signal
   */
  getSignal(symbol, candles) {
    const conditions = this.checkConditions(symbol);
    
    if (!conditions.valid) {
      return {
        valid: false,
        message: conditions.message
      };
    }
    
    let signal = 'NEUTRAL';
    let strength = 0;
    
    // Check for extreme oversold condition (strong buy signal)
    if (conditions.oversold) {
      signal = 'BUY';
      strength = conditions.rsi <= 20 ? 3 : 2;
    }
    // Check for extreme overbought condition (strong sell signal)
    else if (conditions.overbought) {
      signal = 'SELL';
      strength = conditions.rsi >= 80 ? 3 : 2;
    }
    
    // Check for divergence if we have candle data
    if (candles && candles.length > 0) {
      const divergence = this.checkDivergence(symbol, candles);
      
      if (divergence.valid) {
        // Bullish divergence strengthens buy signal or weakens sell signal
        if (divergence.bullishDivergence) {
          if (signal === 'NEUTRAL' || signal === 'BUY') {
            signal = 'BUY';
            strength += 1;
          } else if (signal === 'SELL') {
            strength -= 1;
            if (strength <= 0) {
              signal = 'NEUTRAL';
              strength = 0;
            }
          }
        }
        // Bearish divergence strengthens sell signal or weakens buy signal
        else if (divergence.bearishDivergence) {
          if (signal === 'NEUTRAL' || signal === 'SELL') {
            signal = 'SELL';
            strength += 1;
          } else if (signal === 'BUY') {
            strength -= 1;
            if (strength <= 0) {
              signal = 'NEUTRAL';
              strength = 0;
            }
          }
        }
      }
    }
    
    return {
      valid: true,
      signal,
      strength,
      conditions
    };
  }
}

module.exports = new RSIIndicator();