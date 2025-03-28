/**
 * Exponential Moving Average (EMA) indicator
 * EMA gives more weight to recent prices, making it more responsive to new information.
 */
const { EMA } = require('technicalindicators');
const config = require('../config').indicators.ema;

class EMAIndicator {
  constructor() {
    this.emaData = {};
    this.fastPeriod = config.fast;
    this.mediumPeriod = config.medium;
    this.slowPeriod = config.slow;
  }
  
  /**
   * Calculate EMA for a symbol based on candles
   * @param {string} symbol - The trading pair symbol
   * @param {Array} candles - Array of candle data
   * @returns {Object} - EMA calculation result
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
    
    // Calculate EMAs with different periods
    const fastEma = EMA.calculate({
      values: closePrices,
      period: this.fastPeriod
    });
    
    const mediumEma = EMA.calculate({
      values: closePrices,
      period: this.mediumPeriod
    });
    
    const slowEma = EMA.calculate({
      values: closePrices,
      period: this.slowPeriod
    });
    
    // Create EMA points with timestamps
    const emaPoints = [];
    const maxPeriod = Math.max(this.fastPeriod, this.mediumPeriod, this.slowPeriod);
    
    for (let i = maxPeriod - 1; i < candles.length; i++) {
      const fastIdx = i - (maxPeriod - this.fastPeriod);
      const mediumIdx = i - (maxPeriod - this.mediumPeriod);
      const slowIdx = i - (maxPeriod - this.slowPeriod);
      
      emaPoints.push({
        timestamp: candles[i].timestamp,
        fast: fastEma[fastIdx],
        medium: mediumEma[mediumIdx],
        slow: slowEma[slowIdx]
      });
    }
    
    // Store EMA data for this symbol
    this.emaData[symbol] = {
      fast: {
        current: fastEma[fastEma.length - 1],
        period: this.fastPeriod
      },
      medium: {
        current: mediumEma[mediumEma.length - 1],
        period: this.mediumPeriod
      },
      slow: {
        current: slowEma[slowEma.length - 1],
        period: this.slowPeriod
      },
      points: emaPoints
    };
    
    return {
      valid: true,
      ...this.emaData[symbol]
    };
  }
  
  /**
   * Get EMA data for a specific symbol
   * @param {string} symbol - The trading pair symbol
   * @returns {Object|null} - EMA data or null if not available
   */
  getEma(symbol) {
    return this.emaData[symbol] || null;
  }
  
  /**
   * Check EMA crossovers
   * @param {string} symbol - The trading pair symbol
   * @returns {Object} - Crossover analysis
   */
  checkCrossovers(symbol) {
    if (!this.emaData[symbol] || !this.emaData[symbol].points || this.emaData[symbol].points.length < 2) {
      return {
        valid: false,
        message: 'Insufficient EMA data for crossover analysis'
      };
    }
    
    const points = this.emaData[symbol].points;
    const current = points[points.length - 1];
    const previous = points[points.length - 2];
    
    // Check fast/medium crossover
    const fastMediumCrossover = (previous.fast <= previous.medium && current.fast > current.medium) ||
                               (previous.fast >= previous.medium && current.fast < current.medium);
    
    // Check fast/slow crossover
    const fastSlowCrossover = (previous.fast <= previous.slow && current.fast > current.slow) ||
                             (previous.fast >= previous.slow && current.fast < current.slow);
    
    // Check medium/slow crossover
    const mediumSlowCrossover = (previous.medium <= previous.slow && current.medium > current.slow) ||
                               (previous.medium >= previous.slow && current.medium < current.slow);
    
    // Determine crossover direction
    const fastMediumBullish = previous.fast <= previous.medium && current.fast > current.medium;
    const fastSlowBullish = previous.fast <= previous.slow && current.fast > current.slow;
    const mediumSlowBullish = previous.medium <= previous.slow && current.medium > current.slow;
    
    return {
      valid: true,
      fastMediumCrossover,
      fastSlowCrossover,
      mediumSlowCrossover,
      fastMediumBullish,
      fastSlowBullish,
      mediumSlowBullish
    };
  }
  
  /**
   * Check price position relative to EMAs
   * @param {string} symbol - The trading pair symbol
   * @param {number} price - Current price
   * @returns {Object} - Position analysis
   */
  checkPricePosition(symbol, price) {
    if (!this.emaData[symbol]) {
      return {
        valid: false,
        message: 'No EMA data available for this symbol'
      };
    }
    
    const { fast, medium, slow } = this.emaData[symbol];
    
    return {
      valid: true,
      price,
      aboveFast: price > fast.current,
      aboveMedium: price > medium.current,
      aboveSlow: price > slow.current,
      percentFromFast: ((price - fast.current) / fast.current) * 100,
      percentFromMedium: ((price - medium.current) / medium.current) * 100,
      percentFromSlow: ((price - slow.current) / slow.current) * 100
    };
  }
  
  /**
   * Get a trading signal based on EMA analysis
   * @param {string} symbol - The trading pair symbol
   * @param {number} price - Current price
   * @returns {Object} - The trading signal
   */
  getSignal(symbol, price) {
    if (!this.emaData[symbol]) {
      return {
        valid: false,
        message: 'No EMA data available for this symbol'
      };
    }
    
    const crossovers = this.checkCrossovers(symbol);
    const pricePosition = this.checkPricePosition(symbol, price);
    
    if (!crossovers.valid || !pricePosition.valid) {
      return {
        valid: false,
        message: 'Could not analyze EMA data'
      };
    }
    
    let signal = 'NEUTRAL';
    let strength = 0;
    
    // Strong bullish signal: Price above all EMAs and EMAs aligned (fast > medium > slow)
    if (pricePosition.aboveFast && pricePosition.aboveMedium && pricePosition.aboveSlow &&
        this.emaData[symbol].fast.current > this.emaData[symbol].medium.current &&
        this.emaData[symbol].medium.current > this.emaData[symbol].slow.current) {
      signal = 'BUY';
      strength = 3;
    }
    // Strong bearish signal: Price below all EMAs and EMAs aligned (fast < medium < slow)
    else if (!pricePosition.aboveFast && !pricePosition.aboveMedium && !pricePosition.aboveSlow &&
             this.emaData[symbol].fast.current < this.emaData[symbol].medium.current &&
             this.emaData[symbol].medium.current < this.emaData[symbol].slow.current) {
      signal = 'SELL';
      strength = 3;
    }
    // Bullish crossover: Fast EMA crosses above medium or slow EMA
    else if (crossovers.fastMediumBullish || crossovers.fastSlowBullish) {
      signal = 'BUY';
      strength = crossovers.fastMediumBullish && crossovers.fastSlowBullish ? 2 : 1;
    }
    // Bearish crossover: Fast EMA crosses below medium or slow EMA
    else if (!crossovers.fastMediumBullish && crossovers.fastMediumCrossover ||
             !crossovers.fastSlowBullish && crossovers.fastSlowCrossover) {
      signal = 'SELL';
      strength = (!crossovers.fastMediumBullish && crossovers.fastMediumCrossover) &&
                (!crossovers.fastSlowBullish && crossovers.fastSlowCrossover) ? 2 : 1;
    }
    
    return {
      valid: true,
      signal,
      strength,
      crossovers,
      pricePosition
    };
  }
}

module.exports = new EMAIndicator();