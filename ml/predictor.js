/**
 * Machine Learning predictor module
 * Makes predictions on new trading opportunities
 */
const mlTrainer = require('./trainer');
const dataCollector = require('../data/collector');
const config = require('../config');

class MLPredictor {
  constructor() {
    this.recentPredictions = [];
    this.maxPredictionsHistory = 100;
  }
  
  /**
   * Predict success likelihood for a trading signal
   * @param {Object} signal - Trading signal
   * @returns {Object} - Prediction results
   */
  async predict(signal) {
    try {
      const { symbol, direction, indicators } = signal;
      
      // If ML model is not ready, return neutral prediction
      if (!mlTrainer.initialized || !mlTrainer.model) {
        return {
          valid: false,
          message: 'ML model not initialized',
          confidence: 0.5
        };
      }
      
      // Extract features from indicators
      const features = this.extractFeatures(symbol, direction, indicators);
      
      // Make prediction
      const prediction = await mlTrainer.predict(features);
      
      // Store prediction for later analysis
      this.storePrediction({
        symbol,
        direction,
        timestamp: Date.now(),
        signalStrength: signal.strength,
        confidence: prediction.confidence,
        features
      });
      
      return {
        valid: true,
        confidence: prediction.confidence,
        prediction: prediction.prediction === 1 ? 'BUY' : 'SELL',
        features
      };
    } catch (error) {
      logger.error(`Error making ML prediction: ${error.message}`);
      
      // Return neutral prediction on error
      return {
        valid: false,
        message: `Prediction error: ${error.message}`,
        confidence: 0.5
      };
    }
  }
  
  /**
   * Extract features from signal indicators
   * @param {string} symbol - Trading symbol
   * @param {string} direction - Trade direction
   * @param {Object} indicators - Signal indicators
   * @returns {Object} - Extracted features
   */
  extractFeatures(symbol, direction, indicators) {
    try {
      // Get features from data collector if available
      const collectedFeatures = dataCollector.getFeatures(symbol);
      
      // VWAP features
      const vwapFeatures = indicators.vwap && indicators.vwap.comparison ? {
        vwapDeviation: indicators.vwap.comparison.percentDeviation,
        aboveVwap: indicators.vwap.comparison.aboveVwap ? 1 : 0
      } : {
        vwapDeviation: 0,
        aboveVwap: 0
      };
      
      // RSI features
      const rsiFeatures = indicators.rsi && indicators.rsi.conditions ? {
        rsi: indicators.rsi.conditions.rsi,
        rsiOverbought: indicators.rsi.conditions.overbought ? 1 : 0,
        rsiOversold: indicators.rsi.conditions.oversold ? 1 : 0
      } : {
        rsi: 50,
        rsiOverbought: 0,
        rsiOversold: 0
      };
      
      // EMA features
      const emaFeatures = indicators.ema && indicators.ema.crossovers ? {
        emaFastAboveMedium: indicators.ema.crossovers.fastMediumBullish ? 1 : 0,
        emaFastAboveSlow: indicators.ema.crossovers.fastSlowBullish ? 1 : 0,
        emaMediumAboveSlow: indicators.ema.crossovers.mediumSlowBullish ? 1 : 0
      } : {
        emaFastAboveMedium: 0,
        emaFastAboveSlow: 0,
        emaMediumAboveSlow: 0
      };
      
      // MACD features
      const macdFeatures = indicators.macd && indicators.macd.current ? {
        macdAboveSignal: indicators.macd.current.MACD > indicators.macd.current.signal ? 1 : 0,
        macdPositive: indicators.macd.current.MACD > 0 ? 1 : 0
      } : {
        macdAboveSignal: 0,
        macdPositive: 0
      };
      
      // Orderbook features
      const orderbookFeatures = indicators.orderbook ? {
        orderbookImbalance: indicators.orderbook.imbalances && indicators.orderbook.imbalances.valid ? 
          indicators.orderbook.imbalances.imbalanceRatio : 1,
        orderbookScore: indicators.orderbook.overallScore || 0
      } : {
        orderbookImbalance: 1,
        orderbookScore: 0
      };
      
      // Direction features
      const directionFeatures = {
        direction: direction === 'BUY' ? 1 : 0
      };
      
      // Combine all features
      return {
        ...vwapFeatures,
        ...rsiFeatures,
        ...emaFeatures,
        ...macdFeatures,
        ...orderbookFeatures,
        ...directionFeatures
      };
    } catch (error) {
      logger.error(`Error extracting features: ${error.message}`);
      
      // Return default features on error
      return {
        vwapDeviation: 0,
        aboveVwap: 0,
        rsi: 50,
        rsiOverbought: 0,
        rsiOversold: 0,
        emaFastAboveMedium: 0,
        emaFastAboveSlow: 0,
        emaMediumAboveSlow: 0,
        macdAboveSignal: 0,
        macdPositive: 0,
        orderbookImbalance: 1,
        orderbookScore: 0,
        direction: direction === 'BUY' ? 1 : 0
      };
    }
  }
  
  /**
   * Store prediction for later analysis
   * @param {Object} prediction - The prediction to store
   */
  storePrediction(prediction) {
    this.recentPredictions.push(prediction);
    
    // Limit history size
    if (this.recentPredictions.length > this.maxPredictionsHistory) {
      this.recentPredictions.shift();
    }
  }
  
  /**
   * Get recent predictions
   * @param {number} limit - Number of predictions to return
   * @returns {Array} - Recent predictions
   */
  getRecentPredictions(limit = 10) {
    return this.recentPredictions
      .slice(-limit)
      .sort((a, b) => b.timestamp - a.timestamp);
  }
  
  /**
   * Get prediction statistics
   * @returns {Object} - Prediction statistics
   */
  getPredictionStats() {
    if (this.recentPredictions.length === 0) {
      return {
        count: 0,
        avgConfidence: 0,
        buyCount: 0,
        sellCount: 0
      };
    }
    
    let totalConfidence = 0;
    let buyCount = 0;
    
    for (const pred of this.recentPredictions) {
      totalConfidence += pred.confidence;
      if (pred.direction === 'BUY') {
        buyCount++;
      }
    }
    
    return {
      count: this.recentPredictions.length,
      avgConfidence: totalConfidence / this.recentPredictions.length,
      buyCount,
      sellCount: this.recentPredictions.length - buyCount,
      buyPercentage: (buyCount / this.recentPredictions.length) * 100,
      sellPercentage: ((this.recentPredictions.length - buyCount) / this.recentPredictions.length) * 100
    };
  }
}

module.exports = new MLPredictor();