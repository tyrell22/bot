/**
 * Risk management module
 * Handles position sizing, risk per trade, and risk controls
 */
const bybit = require('../api/bybit');
const config = require('../config');

class RiskManager {
  constructor() {
    this.maxRiskPerTrade = 0.02; // 2% of account
    this.maxDailyRisk = 0.1; // 10% of account
    this.dailyLossCounter = 0;
    this.dailyResetTime = null;
  }
  
  /**
   * Calculate position size based on risk parameters
   * @param {string} symbol - The trading pair symbol
   * @param {string} direction - Trade direction (BUY/SELL)
   * @returns {Object} - Position size calculation result
   */
  async calculatePositionSize(symbol, direction) {
    try {
      // Get account information
      const accountInfo = await bybit.getAccountInfo();
      
      if (!accountInfo) {
        throw new Error('Failed to get account information');
      }
      
      // Get symbol ticker
      const tickers = await bybit.getTickers(symbol);
      
      if (!tickers || tickers.length === 0) {
        throw new Error(`Failed to get ticker information for ${symbol}`);
      }
      
      const ticker = tickers[0];
      const currentPrice = parseFloat(ticker.lastPrice);
      
      // Calculate account value
      const accountEquity = parseFloat(accountInfo.totalEquity);
      
      // Calculate risk amount based on account size
      const riskAmount = accountEquity * Math.min(
        config.trading.positionSizePercentage,
        this.maxRiskPerTrade
      );
      
      // Calculate position size
      // For simplicity, we'll use a fixed percentage of account size
      const positionValue = riskAmount * config.trading.leverage;
      const positionSize = positionValue / currentPrice;
      
      // Check if we have exceeded daily risk limit
      if (this.dailyLossCounter > this.maxDailyRisk * accountEquity) {
        return {
          valid: false,
          message: 'Daily loss limit reached',
          dailyLossCounter: this.dailyLossCounter,
          maxDailyLoss: this.maxDailyRisk * accountEquity
        };
      }
      
      // Reset daily loss counter if needed
      this.checkDailyReset();
      
      return {
        valid: true,
        positionSize: positionSize.toFixed(6),
        riskAmount,
        accountEquity,
        currentPrice,
        positionValue,
        maxRiskPerTrade: this.maxRiskPerTrade,
        maxDailyRisk: this.maxDailyRisk
      };
    } catch (error) {
      logger.error(`Error calculating position size: ${error.message}`);
      return {
        valid: false,
        message: `Risk calculation error: ${error.message}`
      };
    }
  }
  
  /**
   * Check and reset daily loss counter if needed
   */
  checkDailyReset() {
    const now = new Date();
    const currentDay = now.getUTCDate();
    
    // Initialize reset time if not set
    if (!this.dailyResetTime) {
      // Set reset time to midnight UTC
      this.dailyResetTime = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      );
    }
    
    // If we've passed the reset time, reset the counter
    if (now > this.dailyResetTime) {
      this.dailyLossCounter = 0;
      
      // Set next reset time
      this.dailyResetTime = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
      );
      
      logger.info('Daily risk counter reset');
    }
  }
  
  /**
   * Update daily loss counter when a trade is closed at a loss
   * @param {number} lossAmount - The amount lost in the trade
   */
  updateDailyLossCounter(lossAmount) {
    if (lossAmount > 0) {
      return;
    }
    
    // Add absolute loss to counter
    this.dailyLossCounter += Math.abs(lossAmount);
    
    logger.info(`Daily loss counter updated: ${this.dailyLossCounter.toFixed(2)} USDT`);
    
    // Check if we need to reset
    this.checkDailyReset();
  }
  
  /**
   * Get risk analysis for a symbol
   * @param {string} symbol - The trading pair symbol
   * @returns {Object} - Risk analysis
   */
  async analyzeSymbolRisk(symbol) {
    try {
      // Get volatility information
      const tickers = await bybit.getTickers(symbol);
      
      if (!tickers || tickers.length === 0) {
        throw new Error(`Failed to get ticker information for ${symbol}`);
      }
      
      const ticker = tickers[0];
      
      // Calculate volatility based on 24h high/low
      const highPrice = parseFloat(ticker.highPrice24h);
      const lowPrice = parseFloat(ticker.lowPrice24h);
      const lastPrice = parseFloat(ticker.lastPrice);
      
      const volatility24h = (highPrice - lowPrice) / lowPrice;
      const volatilityPercentage = volatility24h * 100;
      
      // Determine risk level based on volatility
      let riskLevel = 'MEDIUM';
      
      if (volatilityPercentage < 3) {
        riskLevel = 'LOW';
      } else if (volatilityPercentage > 8) {
        riskLevel = 'HIGH';
      }
      
      // Recommend leverage based on risk level
      let recommendedLeverage = config.trading.leverage;
      
      if (riskLevel === 'HIGH') {
        recommendedLeverage = Math.min(5, config.trading.leverage);
      } else if (riskLevel === 'LOW') {
        recommendedLeverage = Math.min(15, config.trading.leverage);
      }
      
      return {
        valid: true,
        symbol,
        volatility24h,
        volatilityPercentage,
        highPrice,
        lowPrice,
        lastPrice,
        riskLevel,
        recommendedLeverage
      };
    } catch (error) {
      logger.error(`Error analyzing symbol risk: ${error.message}`);
      return {
        valid: false,
        message: `Risk analysis error: ${error.message}`
      };
    }
  }
  
  /**
   * Calculate optimal take profit and stop loss levels
   * @param {string} symbol - The trading pair symbol
   * @param {string} direction - Trade direction (BUY/SELL)
   * @param {number} entryPrice - Entry price
   * @returns {Object} - Calculated levels
   */
  async calculateExitLevels(symbol, direction, entryPrice) {
    try {
      // Get risk analysis
      const riskAnalysis = await this.analyzeSymbolRisk(symbol);
      
      if (!riskAnalysis.valid) {
        throw new Error(riskAnalysis.message);
      }
      
      // Base values from config
      let takeProfitPercent = config.trading.targetProfit;
      let stopLossPercent = config.trading.stopLoss;
      
      // Adjust based on volatility
      const volatilityFactor = riskAnalysis.volatilityPercentage / 5; // Normalize to a factor around 1
      
      // More volatile assets might need wider stops and targets
      if (riskAnalysis.riskLevel === 'HIGH') {
        takeProfitPercent = Math.max(takeProfitPercent, 0.04); // At least 4%
        stopLossPercent = Math.max(stopLossPercent, 0.02); // At least 2%
      }
      
      // Calculate actual price levels
      let takeProfitPrice, stopLossPrice;
      
      if (direction === 'BUY') {
        takeProfitPrice = entryPrice * (1 + takeProfitPercent);
        stopLossPrice = entryPrice * (1 - stopLossPercent);
      } else {
        takeProfitPrice = entryPrice * (1 - takeProfitPercent);
        stopLossPrice = entryPrice * (1 + stopLossPercent);
      }
      
      // Calculate risk/reward ratio
      const riskAmount = Math.abs(entryPrice - stopLossPrice);
      const rewardAmount = Math.abs(takeProfitPrice - entryPrice);
      const riskRewardRatio = rewardAmount / riskAmount;
      
      return {
        valid: true,
        symbol,
        direction,
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        takeProfitPercent,
        stopLossPercent,
        riskRewardRatio,
        volatilityAdjusted: riskAnalysis.riskLevel !== 'MEDIUM'
      };
    } catch (error) {
      logger.error(`Error calculating exit levels: ${error.message}`);
      return {
        valid: false,
        message: `Exit level calculation error: ${error.message}`
      };
    }
  }
}

module.exports = new RiskManager();