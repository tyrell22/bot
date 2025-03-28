/**
 * Volume Weighted Average Price (VWAP) indicator
 * VWAP is calculated by adding up the dollars traded for every transaction
 * and dividing by the total shares traded.
 */
class VWAP {
    constructor() {
      this.vwapData = {};
      this.sessionStartTimestamps = {};
      this.config = require('../config').indicators.vwap;
    }
    
    /**
     * Calculate VWAP for a symbol based on candles
     * @param {string} symbol - The trading pair symbol
     * @param {Array} candles - Array of candle data
     * @param {boolean} resetDaily - Whether to reset VWAP calculation daily
     * @returns {Object} - VWAP calculation result
     */
    calculate(symbol, candles, resetDaily = true) {
      if (!candles || candles.length === 0) {
        return {
          valid: false,
          message: 'No candle data provided'
        };
      }
      
      // Sort candles by timestamp (ascending)
      candles = [...candles].sort((a, b) => a.timestamp - b.timestamp);
      
      // Initialize or get session start timestamp
      if (!this.sessionStartTimestamps[symbol] || resetDaily) {
        // Get current date
        const now = new Date();
        // Set to midnight UTC
        const midnightUtc = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0, 0, 0, 0
        ));
        
        this.sessionStartTimestamps[symbol] = midnightUtc.getTime();
      }
      
      // Filter candles for current session
      const sessionCandles = candles.filter(
        candle => candle.timestamp >= this.sessionStartTimestamps[symbol]
      );
      
      if (sessionCandles.length === 0) {
        return {
          valid: false,
          message: 'No candles found in current session'
        };
      }
      
      // Calculate VWAP
      let cumulativeTPV = 0; // Typical Price * Volume
      let cumulativeVolume = 0;
      
      const vwapPoints = [];
      
      for (const candle of sessionCandles) {
        // Calculate typical price: (high + low + close) / 3
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        
        // Calculate price * volume
        const priceVolume = typicalPrice * candle.volume;
        
        // Add to cumulative values
        cumulativeTPV += priceVolume;
        cumulativeVolume += candle.volume;
        
        // Calculate VWAP
        const vwap = cumulativeTPV / cumulativeVolume;
        
        vwapPoints.push({
          timestamp: candle.timestamp,
          vwap
        });
      }
      
      // Calculate standard deviation bands
      let sumSquaredDev = 0;
      for (const candle of sessionCandles) {
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        const latestVwap = vwapPoints[vwapPoints.length - 1].vwap;
        const dev = typicalPrice - latestVwap;
        sumSquaredDev += dev * dev * candle.volume;
      }
      
      const variance = sumSquaredDev / cumulativeVolume;
      const standardDev = Math.sqrt(variance);
      
      // Store VWAP data for this symbol
      this.vwapData[symbol] = {
        vwap: vwapPoints[vwapPoints.length - 1].vwap,
        upperBand1: vwapPoints[vwapPoints.length - 1].vwap + standardDev,
        upperBand2: vwapPoints[vwapPoints.length - 1].vwap + 2 * standardDev,
        lowerBand1: vwapPoints[vwapPoints.length - 1].vwap - standardDev,
        lowerBand2: vwapPoints[vwapPoints.length - 1].vwap - 2 * standardDev,
        standardDev,
        points: vwapPoints
      };
      
      return {
        valid: true,
        ...this.vwapData[symbol]
      };
    }
    
    /**
     * Get VWAP data for a specific symbol
     * @param {string} symbol - The trading pair symbol
     * @returns {Object|null} - VWAP data or null if not available
     */
    getVwap(symbol) {
      return this.vwapData[symbol] || null;
    }
    
    /**
     * Check if price is above or below VWAP
     * @param {string} symbol - The trading pair symbol
     * @param {number} price - Current price to compare
     * @returns {Object} - Comparison results
     */
    checkPriceVsVwap(symbol, price) {
      if (!this.vwapData[symbol]) {
        return {
          valid: false,
          message: 'No VWAP data available for this symbol'
        };
      }
      
      const vwap = this.vwapData[symbol].vwap;
      const upperBand1 = this.vwapData[symbol].upperBand1;
      const upperBand2 = this.vwapData[symbol].upperBand2;
      const lowerBand1 = this.vwapData[symbol].lowerBand1;
      const lowerBand2 = this.vwapData[symbol].lowerBand2;
      
      return {
        valid: true,
        price,
        vwap,
        deviation: price - vwap,
        percentDeviation: ((price - vwap) / vwap) * 100,
        aboveVwap: price > vwap,
        belowVwap: price < vwap,
        aboveUpperBand1: price > upperBand1,
        aboveUpperBand2: price > upperBand2,
        belowLowerBand1: price < lowerBand1,
        belowLowerBand2: price < lowerBand2,
        bands: {
          upperBand1,
          upperBand2,
          lowerBand1,
          lowerBand2
        }
      };
    }
    
    /**
     * Get a trading signal based on VWAP position
     * @param {string} symbol - The trading pair symbol
     * @param {number} price - Current price to evaluate
     * @returns {Object} - The trading signal
     */
    getSignal(symbol, price) {
      const comparison = this.checkPriceVsVwap(symbol, price);
      
      if (!comparison.valid) {
        return {
          valid: false,
          message: comparison.message
        };
      }
      
      let signal = 'NEUTRAL';
      let strength = 0;
      
      // Price crossing above VWAP from below - bullish
      if (comparison.aboveVwap && comparison.percentDeviation < 0.5) {
        signal = 'BUY';
        strength = 1;
      }
      // Price crossing below VWAP from above - bearish
      else if (comparison.belowVwap && comparison.percentDeviation > -0.5) {
        signal = 'SELL';
        strength = 1;
      }
      // Price strongly above VWAP and above upper band - very bullish
      else if (comparison.aboveUpperBand1) {
        strength = comparison.aboveUpperBand2 ? 3 : 2;
        // Too extended above upper band may indicate overextension
        signal = comparison.aboveUpperBand2 ? 'NEUTRAL' : 'BUY';
      }
      // Price strongly below VWAP and below lower band - very bearish
      else if (comparison.belowLowerBand1) {
        strength = comparison.belowLowerBand2 ? 3 : 2;
        // Too extended below lower band may indicate overextension
        signal = comparison.belowLowerBand2 ? 'NEUTRAL' : 'SELL';
      }
      
      return {
        valid: true,
        signal,
        strength,
        comparison
      };
    }
  }
  
  module.exports = new VWAP();