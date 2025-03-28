/**
 * Order Flow indicator
 * Analyzes buying and selling pressure based on volume and price movement
 */
const config = require('../config');

class OrderFlowIndicator {
  constructor() {
    this.orderFlowData = {};
    this.historyLength = 30; // Number of candles to track
  }
  
  /**
   * Calculate Order Flow metrics for a symbol based on candles
   * @param {string} symbol - The trading pair symbol
   * @param {Array} candles - Array of candle data
   * @returns {Object} - Order Flow calculation result
   */
  calculate(symbol, candles) {
    if (!candles || candles.length < 2) {
      return {
        valid: false,
        message: 'Insufficient candle data provided'
      };
    }
    
    // Sort candles by timestamp (ascending)
    candles = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    
    // Limit to most recent candles
    if (candles.length > this.historyLength) {
      candles = candles.slice(-this.historyLength);
    }
    
    // Calculate buying and selling volume
    const flowMetrics = this.calculateBuySellVolume(candles);
    
    // Calculate delta (buy volume - sell volume)
    const volumeDelta = flowMetrics.buyVolume - flowMetrics.sellVolume;
    
    // Calculate cumulative delta (running sum of delta)
    const cumulativeDelta = this.calculateCumulativeDelta(candles);
    
    // Calculate volume profile (volume at price)
    const volumeProfile = this.calculateVolumeProfile(candles);
    
    // Identify high volume nodes
    const highVolumeNodes = this.identifyHighVolumeNodes(volumeProfile);
    
    // Identify absorption (price rejected after high volume)
    const absorption = this.identifyAbsorption(candles);
    
    // Store data for this symbol
    this.orderFlowData[symbol] = {
      timestamp: Date.now(),
      candles: candles.length,
      buyVolume: flowMetrics.buyVolume,
      sellVolume: flowMetrics.sellVolume,
      volumeDelta,
      buySellRatio: flowMetrics.buyVolume / (flowMetrics.sellVolume || 1),
      cumulativeDelta,
      volumeProfile,
      highVolumeNodes,
      absorption
    };
    
    return {
      valid: true,
      ...this.orderFlowData[symbol]
    };
  }
  
  /**
   * Calculate Buy and Sell Volume based on candle direction
   * @param {Array} candles - Array of candle data
   * @returns {Object} - Buy and sell volume metrics
   */
  calculateBuySellVolume(candles) {
    let buyVolume = 0;
    let sellVolume = 0;
    
    for (const candle of candles) {
      // Determine if candle is bullish or bearish
      const isBullish = candle.close >= candle.open;
      
      // Assign volume based on candle direction
      if (isBullish) {
        buyVolume += candle.volume;
      } else {
        sellVolume += candle.volume;
      }
    }
    
    return {
      buyVolume,
      sellVolume,
      totalVolume: buyVolume + sellVolume,
      buyVolumePercentage: (buyVolume / (buyVolume + sellVolume)) * 100,
      sellVolumePercentage: (sellVolume / (buyVolume + sellVolume)) * 100
    };
  }
  
  /**
   * Calculate Cumulative Delta (running sum of delta)
   * @param {Array} candles - Array of candle data
   * @returns {Array} - Cumulative delta points
   */
  calculateCumulativeDelta(candles) {
    let cumulativeDelta = 0;
    const deltaPoints = [];
    
    for (const candle of candles) {
      const isBullish = candle.close >= candle.open;
      const candleDelta = isBullish ? candle.volume : -candle.volume;
      
      cumulativeDelta += candleDelta;
      
      deltaPoints.push({
        timestamp: candle.timestamp,
        price: candle.close,
        delta: candleDelta,
        cumulativeDelta
      });
    }
    
    return deltaPoints;
  }
  
  /**
   * Calculate Volume Profile (volume at price)
   * @param {Array} candles - Array of candle data
   * @returns {Object} - Volume profile
   */
  calculateVolumeProfile(candles) {
    const volumeByPrice = {};
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    
    // Calculate volume at each price point
    for (const candle of candles) {
      // Track min and max prices
      minPrice = Math.min(minPrice, candle.low);
      maxPrice = Math.max(maxPrice, candle.high);
      
      // Use open, high, low, close as price points (simplification)
      const pricePoints = [candle.open, candle.high, candle.low, candle.close];
      
      // Distribute volume evenly across price points
      const volumePerPoint = candle.volume / pricePoints.length;
      
      for (const price of pricePoints) {
        // Round price to avoid floating point issues
        const roundedPrice = price.toFixed(2);
        
        if (!volumeByPrice[roundedPrice]) {
          volumeByPrice[roundedPrice] = 0;
        }
        
        volumeByPrice[roundedPrice] += volumePerPoint;
      }
    }
    
    // Convert to array for easier sorting
    const volumeProfile = Object.entries(volumeByPrice)
      .map(([price, volume]) => ({
        price: parseFloat(price),
        volume
      }))
      .sort((a, b) => a.price - b.price);
    
    // Calculate Point of Control (price with highest volume)
    const pointOfControl = volumeProfile.reduce(
      (max, current) => (current.volume > max.volume ? current : max),
      { volume: -Infinity }
    );
    
    return {
      profile: volumeProfile,
      pointOfControl,
      minPrice,
      maxPrice
    };
  }
  
  /**
   * Identify High Volume Nodes (price levels with significantly higher volume)
   * @param {Object} volumeProfile - Volume profile object
   * @returns {Array} - High volume nodes
   */
  identifyHighVolumeNodes(volumeProfile) {
    if (!volumeProfile || !volumeProfile.profile || volumeProfile.profile.length === 0) {
      return [];
    }
    
    const profile = volumeProfile.profile;
    
    // Calculate average volume
    const totalVolume = profile.reduce((sum, point) => sum + point.volume, 0);
    const averageVolume = totalVolume / profile.length;
    
    // Identify points with volume 1.5x above average
    const threshold = averageVolume * 1.5;
    
    const highVolumeNodes = profile
      .filter(point => point.volume > threshold)
      .sort((a, b) => b.volume - a.volume); // Sort by volume descending
    
    return highVolumeNodes;
  }
  
  /**
   * Identify Absorption (price rejected after high volume)
   * @param {Array} candles - Array of candle data
   * @returns {Array} - Absorption points
   */
  identifyAbsorption(candles) {
    if (candles.length < 3) {
      return [];
    }
    
    const absorptionPoints = [];
    
    // Look for absorption patterns (high volume followed by rejection)
    for (let i = 1; i < candles.length - 1; i++) {
      const previousCandle = candles[i - 1];
      const currentCandle = candles[i];
      const nextCandle = candles[i + 1];
      
      // Check for high volume candle
      const isHighVolume = currentCandle.volume > previousCandle.volume * 1.5;
      
      if (!isHighVolume) {
        continue;
      }
      
      // Check for price rejection in the next candle
      const isBullishCurrent = currentCandle.close > currentCandle.open;
      const isBullishNext = nextCandle.close > nextCandle.open;
      
      // Bullish absorption: high volume down candle followed by up candle
      const isBullishAbsorption = !isBullishCurrent && isBullishNext && 
                                 nextCandle.low >= currentCandle.low;
      
      // Bearish absorption: high volume up candle followed by down candle
      const isBearishAbsorption = isBullishCurrent && !isBullishNext &&
                                 nextCandle.high <= currentCandle.high;
      
      if (isBullishAbsorption || isBearishAbsorption) {
        absorptionPoints.push({
          timestamp: currentCandle.timestamp,
          price: currentCandle.close,
          volume: currentCandle.volume,
          type: isBullishAbsorption ? 'bullish' : 'bearish'
        });
      }
    }
    
    return absorptionPoints;
  }
  
  /**
   * Get Order Flow data for a specific symbol
   * @param {string} symbol - The trading pair symbol
   * @returns {Object|null} - Order Flow data or null if not available
   */
  getOrderFlow(symbol) {
    return this.orderFlowData[symbol] || null;
  }
  
  /**
   * Get a trading signal based on Order Flow analysis
   * @param {string} symbol - The trading pair symbol
   * @returns {Object} - The trading signal
   */
  getSignal(symbol) {
    const data = this.getOrderFlow(symbol);
    
    if (!data) {
      return {
        valid: false,
        message: 'No Order Flow data available for this symbol'
      };
    }
    
    let signal = 'NEUTRAL';
    let strength = 0;
    
    // Check delta (positive = buying pressure, negative = selling pressure)
    const delta = data.volumeDelta;
    const buySellRatio = data.buySellRatio;
    
    // Check cumulative delta trend
    const cumulativeDelta = data.cumulativeDelta;
    const cdLength = cumulativeDelta.length;
    
    if (cdLength < 3) {
      return {
        valid: false,
        message: 'Insufficient data for signal generation'
      };
    }
    
    // Check if cumulative delta is trending up
    const isIncreasing = cumulativeDelta[cdLength - 1].cumulativeDelta > 
                        cumulativeDelta[cdLength - 3].cumulativeDelta;
    
    // Check for absorption points
    const hasRecentBullishAbsorption = data.absorption.some(
      point => point.type === 'bullish' && 
      point.timestamp > cumulativeDelta[cdLength - 3].timestamp
    );
    
    const hasRecentBearishAbsorption = data.absorption.some(
      point => point.type === 'bearish' && 
      point.timestamp > cumulativeDelta[cdLength - 3].timestamp
    );
    
    // Generate signal based on Order Flow metrics
    if (delta > 0 && isIncreasing && buySellRatio > 1.2) {
      signal = 'BUY';
      strength = 2;
      
      // Stronger if we also have bullish absorption
      if (hasRecentBullishAbsorption) {
        strength = 3;
      }
    }
    else if (delta < 0 && !isIncreasing && buySellRatio < 0.8) {
      signal = 'SELL';
      strength = 2;
      
      // Stronger if we also have bearish absorption
      if (hasRecentBearishAbsorption) {
        strength = 3;
      }
    }
    // Weak signals based just on delta
    else if (delta > 0 && buySellRatio > 1.1) {
      signal = 'BUY';
      strength = 1;
    }
    else if (delta < 0 && buySellRatio < 0.9) {
      signal = 'SELL';
      strength = 1;
    }
    
    return {
      valid: true,
      signal,
      strength,
      metrics: {
        delta,
        buySellRatio,
        isIncreasingDelta: isIncreasing,
        hasRecentBullishAbsorption,
        hasRecentBearishAbsorption
      }
    };
  }
}

module.exports = new OrderFlowIndicator();