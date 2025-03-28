const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const loggerModule = require('../utils/logger');

class ByBitAPI {
  constructor() {
    // Get logger instance
    this.logger = loggerModule.getLogger();
    
    this.baseUrl = config.api.testnet ? 'https://api-testnet.bybit.com' : config.api.baseUrl;
    this.apiKey = config.api.apiKey;
    this.apiSecret = config.api.apiSecret;
    
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': this.apiKey
      }
    });
  }
  
  async init() {
    try {
      // Test API connection by fetching server time
      const { data } = await this.publicRequest('/v5/market/time');
      if (!data || !data.result || !data.result.timeSecond) {
        throw new Error('Invalid response from ByBit API');
      }
      
      // Check account info
      const accountInfo = await this.getAccountInfo();
      this.logger.info(`Connected to ByBit account with ${accountInfo.totalEquity} USDT equity`);
      
      return true;
    } catch (error) {
      this.logger.error(`ByBit API initialization failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Generate signature for authenticated requests
   */
  generateSignature(timestamp, params = {}) {
    const queryString = timestamp + this.apiKey + (Object.keys(params).length === 0 ? '' : JSON.stringify(params));
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }
  
  /**
   * Make a public request to the ByBit API
   */
  async publicRequest(endpoint, params = {}) {
    try {
      const response = await this.axios.get(endpoint, { params });
      this.validateResponse(response.data);
      return response.data;
    } catch (error) {
      this.handleApiError(error, 'Public request failed', endpoint, params);
      throw error;
    }
  }
  
  /**
   * Make a private (authenticated) request to the ByBit API
   */
  async privateRequest(endpoint, method = 'GET', params = {}) {
    try {
      const timestamp = Date.now().toString();
      const signature = this.generateSignature(timestamp, params);
      
      const headers = {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature
      };
      
      let response;
      if (method === 'GET') {
        response = await this.axios.get(endpoint, { params, headers });
      } else if (method === 'POST') {
        response = await this.axios.post(endpoint, params, { headers });
      } else {
        throw new Error(`Unsupported method: ${method}`);
      }
      
      this.validateResponse(response.data);
      return response.data;
    } catch (error) {
      this.handleApiError(error, 'Private request failed', endpoint, params);
      throw error;
    }
  }
  
  /**
   * Validate API response
   */
  validateResponse(data) {
    if (!data) {
      throw new Error('Empty response from ByBit API');
    }
    
    if (data.retCode !== 0) {
      throw new Error(`ByBit API error: ${data.retMsg} (${data.retCode})`);
    }
    
    return true;
  }
  
  /**
   * Handle API errors
   */
  handleApiError(error, message, endpoint, params) {
    if (error.response) {
      const { status, data } = error.response;
      this.logger.error(`${message}: ${endpoint} - Status ${status}: ${JSON.stringify(data)}`);
    } else if (error.request) {
      this.logger.error(`${message}: ${endpoint} - No response received`);
    } else {
      this.logger.error(`${message}: ${endpoint} - ${error.message}`);
    }
    
    this.logger.debug(`Request params: ${JSON.stringify(params)}`);
  }
  
  /**
   * Get account information
   */
  async getAccountInfo() {
    const { result } = await this.privateRequest('/v5/account/wallet-balance', 'GET', { accountType: 'CONTRACT' });
    
    if (!result || !result.list || result.list.length === 0) {
      throw new Error('Failed to fetch account information');
    }
    
    const account = result.list[0];
    const usdtCoin = account.coin.find(c => c.coin === 'USDT');
    
    if (!usdtCoin) {
      throw new Error('No USDT balance found in account');
    }
    
    return {
      totalEquity: usdtCoin.equity,
      availableBalance: usdtCoin.availableBalance,
      totalWalletBalance: usdtCoin.walletBalance
    };
  }
  
  /**
   * Get market tickers for all symbols or a specific symbol
   */
  async getTickers(symbol = '') {
    const params = symbol ? { symbol } : {};
    const { result } = await this.publicRequest('/v5/market/tickers', params);
    return result.list;
  }
  
  /**
   * Get top symbols by volume
   */
  async getTopSymbolsByVolume(limit = 50, category = 'linear') {
    const { result } = await this.publicRequest('/v5/market/tickers', { category });
    
    if (!result || !result.list) {
      throw new Error('Failed to fetch tickers');
    }
    
    // Sort by 24h volume and filter USDT perpetuals
    return result.list
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, limit)
      .map(ticker => ticker.symbol);
  }
  
  /**
   * Get kline/candlestick data
   */
  async getKlines(symbol, interval, limit = 200) {
    const { result } = await this.publicRequest('/v5/market/kline', {
      symbol,
      interval,
      limit
    });
    
    return result.list.map(kline => ({
      timestamp: parseInt(kline[0]),
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5])
    }));
  }
  
  /**
   * Get orderbook data
   */
  async getOrderBook(symbol, limit = 50) {
    try {
      const { result } = await this.publicRequest('/v5/market/orderbook', {
        symbol,
        limit
      });
      
      // Validate required data properties exist
      if (!result || !result.symbol || !result.timestamp || !result.bids || !result.asks) {
        throw new Error(`Invalid orderbook data received for ${symbol}`);
      }
      
      return {
        symbol: result.symbol,
        timestamp: result.timestamp,
        bids: result.bids.map(bid => ({
          price: parseFloat(bid[0]),
          quantity: parseFloat(bid[1])
        })),
        asks: result.asks.map(ask => ({
          price: parseFloat(ask[0]),
          quantity: parseFloat(ask[1])
        }))
      };
    } catch (error) {
      this.logger.error(`Error fetching orderbook for ${symbol}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Place an order
   */
  async placeOrder(params) {
    const orderParams = {
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType || 'Market',
      qty: params.quantity.toString(),
      timeInForce: params.timeInForce || 'GTC',
      positionIdx: 0 // One-Way Mode
    };
    
    if (params.orderType === 'Limit') {
      orderParams.price = params.price.toString();
    }
    
    if (params.takeProfit) {
      orderParams.takeProfit = params.takeProfit.toString();
    }
    
    if (params.stopLoss) {
      orderParams.stopLoss = params.stopLoss.toString();
    }
    
    const { result } = await this.privateRequest('/v5/order/create', 'POST', orderParams);
    return result;
  }
  
  /**
   * Cancel an order
   */
  async cancelOrder(symbol, orderId) {
    const { result } = await this.privateRequest('/v5/order/cancel', 'POST', {
      category: 'linear',
      symbol,
      orderId
    });
    
    return result;
  }
  
  /**
   * Get active orders
   */
  async getActiveOrders(symbol = '') {
    const params = {
      category: 'linear'
    };
    
    if (symbol) {
      params.symbol = symbol;
    }
    
    const { result } = await this.privateRequest('/v5/order/realtime', 'GET', params);
    return result.list;
  }
  
  /**
   * Get positions
   */
  async getPositions(symbol = '') {
    const params = {
      category: 'linear'
    };
    
    if (symbol) {
      params.symbol = symbol;
    }
    
    const { result } = await this.privateRequest('/v5/position/list', 'GET', params);
    return result.list;
  }
  
  /**
   * Set leverage
   */
  async setLeverage(symbol, leverage) {
    const { result } = await this.privateRequest('/v5/position/set-leverage', 'POST', {
      category: 'linear',
      symbol,
      buyLeverage: leverage.toString(),
      sellLeverage: leverage.toString()
    });
    
    return result;
  }
  
  /**
   * Set trading stop (modify take profit, stop loss, trailing stop)
   */
  async setTradingStop(symbol, params) {
    const requestParams = {
      category: 'linear',
      symbol,
      positionIdx: 0 // One-Way Mode
    };
    
    if (params.takeProfit) {
      requestParams.takeProfit = params.takeProfit.toString();
    }
    
    if (params.stopLoss) {
      requestParams.stopLoss = params.stopLoss.toString();
    }
    
    if (params.trailingStop) {
      requestParams.trailingStop = params.trailingStop.toString();
    }
    
    if (params.tpTriggerBy) {
      requestParams.tpTriggerBy = params.tpTriggerBy;
    }
    
    if (params.slTriggerBy) {
      requestParams.slTriggerBy = params.slTriggerBy;
    }
    
    const { result } = await this.privateRequest('/v5/position/trading-stop', 'POST', requestParams);
    return result;
  }
  
  /**
   * Get wallet balance
   */
  async getWalletBalance(coin = 'USDT') {
    const { result } = await this.privateRequest('/v5/account/wallet-balance', 'GET', {
      accountType: 'CONTRACT',
      coin
    });
    
    return result.list[0].coin.find(c => c.coin === coin);
  }
}

module.exports = new ByBitAPI();