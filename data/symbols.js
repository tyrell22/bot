/**
 * Symbol selection module
 * Selects the most suitable symbols for trading based on volume and other criteria
 */
const bybit = require('../api/bybit');
const config = require('../config');

class SymbolSelector {
  constructor() {
    this.topSymbols = [];
    this.lastUpdateTime = 0;
    this.updateInterval = 3600000; // 1 hour
  }
  
  /**
   * Get top symbols by trading volume
   * @param {number} limit - Number of symbols to return
   * @returns {Array} - List of symbol names
   */
  async getTopSymbolsByVolume(limit = config.topSymbolsCount) {
    try {
      // Check if we need to refresh the list
      const now = Date.now();
      if (now - this.lastUpdateTime > this.updateInterval || this.topSymbols.length === 0) {
        logger.info('Fetching top symbols by volume from ByBit...');
        
        // Fetch from API
        const symbols = await bybit.getTopSymbolsByVolume(limit);
        
        if (!symbols || symbols.length === 0) {
          throw new Error('Failed to fetch top symbols');
        }
        
        this.topSymbols = symbols;
        this.lastUpdateTime = now;
        
        logger.info(`Fetched ${symbols.length} top symbols by volume`);
      }
      
      return this.topSymbols;
    } catch (error) {
      logger.error(`Error fetching top symbols: ${error.message}`);
      
      // Return default symbols from config if available
      if (config.symbols && config.symbols.length > 0) {
        logger.info(`Using default symbols from config: ${config.symbols.join(', ')}`);
        return config.symbols;
      }
      
      throw error;
    }
  }
  
  /**
   * Filter symbols by volatility
   * @param {Array} symbols - List of symbols to filter
   * @param {number} minVolatility - Minimum volatility percentage
   * @param {number} maxVolatility - Maximum volatility percentage
   * @returns {Promise<Array>} - Filtered symbols
   */
  async filterByVolatility(symbols, minVolatility = 2, maxVolatility = 10) {
    try {
      const results = [];
      
      for (const symbol of symbols) {
        try {
          // Get ticker data
          const tickers = await bybit.getTickers(symbol);
          
          if (!tickers || tickers.length === 0) {
            continue;
          }
          
          const ticker = tickers[0];
          
          // Calculate volatility
          const highPrice = parseFloat(ticker.highPrice24h);
          const lowPrice = parseFloat(ticker.lowPrice24h);
          const volatility = ((highPrice - lowPrice) / lowPrice) * 100;
          
          // Check if within range
          if (volatility >= minVolatility && volatility <= maxVolatility) {
            results.push({
              symbol,
              volatility,
              lastPrice: parseFloat(ticker.lastPrice),
              volume24h: parseFloat(ticker.volume24h)
            });
          }
        } catch (error) {
          logger.debug(`Error checking volatility for ${symbol}: ${error.message}`);
        }
      }
      
      // Sort by volatility (descending)
      results.sort((a, b) => b.volatility - a.volatility);
      
      logger.info(`Filtered ${results.length} symbols by volatility criteria`);
      
      // Return just the symbol names
      return results.map(item => item.symbol);
    } catch (error) {
      logger.error(`Error filtering symbols by volatility: ${error.message}`);
      return symbols; // Return original list on error
    }
  }
  
  /**
   * Get the best trading symbols based on multiple criteria
   * @param {number} limit - Maximum number of symbols to return
   * @returns {Promise<Array>} - Best trading symbols
   */
  async getBestTradingSymbols(limit = 10) {
    try {
      // Start with top volume symbols
      const topVolumeSymbols = await this.getTopSymbolsByVolume(config.topSymbolsCount);
      
      // Filter by volatility
      const filteredSymbols = await this.filterByVolatility(topVolumeSymbols);
      
      // Return top N symbols
      return filteredSymbols.slice(0, limit);
    } catch (error) {
      logger.error(`Error getting best trading symbols: ${error.message}`);
      return config.symbols.slice(0, limit);
    }
  }
}

module.exports = new SymbolSelector();