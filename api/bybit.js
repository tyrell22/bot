const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const loggerModule = require('../utils/logger');

class ByBitAPI {
  constructor() {
    // Get logger instance
    this.logger = loggerModule.getLogger();
    
    this.baseUrl = config.api.testnet ? 'https://api-testnet.bybit.com' : config.api.baseUrl;
    this.apiKey = process.env.BYBIT_API_KEY || config.api.apiKey;
    this.apiSecret = process.env.BYBIT_API_SECRET || config.api.apiSecret;
    
    // Check if API keys are present
    if (!this.apiKey || !this.apiSecret) {
      this.logger.error('API keys not found. Please check your .env file or config.js');
    }
    
    this.logger.debug(`Using API endpoint: ${this.baseUrl}`);
    this.logger.debug(`API Key present: ${this.apiKey ? 'Yes' : 'No'}`);
    this.logger.debug(`API Secret present: ${this.apiSecret ? 'Yes' : 'No'}`);
    
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
     
  
      // Test basic connectivity
      this.logger.info('Testing connection to ByBit API...');
      const response = await this.publicRequest('/v5/market/time');
      
      // Log the full response for debugging
      this.logger.info(`Full response object: ${JSON.stringify(response)}`);
      this.logger.info('Server time response: ' + JSON.stringify(response));
      
      // Validate response structure
      if (!response || !response.result || !response.result.timeSecond) {
        this.logger.error('Invalid response from ByBit API: ' + JSON.stringify(response));
        throw new Error('Invalid response from ByBit API');
      }
      
      // Log server time
      const serverTime = new Date(parseInt(response.result.timeSecond) * 1000).toISOString();
      this.logger.info(`ByBit server time: ${serverTime}`);
      
      // Check account information
      this.logger.info('Getting account information...');
      try {
        const accountInfo = await this.getAccountInfo();
        this.logger.info(`Connected to ByBit account with ${accountInfo.totalEquity} USDT equity`);
        this.logger.info(`Available balance: ${accountInfo.availableBalance} USDT`);
        this.logger.info(`Wallet balance: ${accountInfo.totalWalletBalance} USDT`);
      } catch (accountError) {
        this.logger.error(`Failed to get account info: ${accountError.message}`);
        
        // Handle specific authentication errors
        if (accountError.message.includes('Invalid API key') || 
            accountError.message.includes('Invalid signature') ||
            accountError.message.includes('Unauthorized')) {
          throw new Error('Authentication failed. Please check your API key and secret');
        }
        
        throw accountError;
      }
      
      this.logger.info('ByBit API initialization completed successfully');
      return true;
    } catch (error) {
      this.logger.error(`ByBit API initialization failed: ${error.message}`);
      
      // Detailed error handling
      if (error.response) {
        this.logger.error(`Response status: ${error.response.status}`);
        this.logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
        
        if (error.response.status === 403) {
          throw new Error('API access forbidden. Your IP may be restricted or keys have insufficient permissions');
        } else if (error.response.status === 401) {
          throw new Error('API authentication failed. Check your API keys');
        } else if (error.response.status === 429) {
          throw new Error('Rate limit exceeded. Too many requests to ByBit API');
        }
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error('Cannot connect to ByBit API. Check your internet connection or API endpoint');
      }
      
      throw error;
    }
  }
  
  /**
   * Generate signature for authenticated requests
   */
  generateSignature(timestamp, params = {}, method = 'GET') {
    const recvWindow = '5000'; // Fixed value, no need to take from params
    let signString = `${timestamp}${this.apiKey}${recvWindow}`;
    
    if (method === 'GET') {
      // Remove recv_window from params to avoid duplication
      const filteredParams = { ...params };
      delete filteredParams.recv_window;
      
      if (Object.keys(filteredParams).length > 0) {
        const queryString = Object.keys(filteredParams)
          .sort()
          .map(key => `${key}=${filteredParams[key]}`)
          .join('&');
        signString += queryString;
      }
    } else if (method === 'POST') {
      const filteredParams = { ...params };
      delete filteredParams.recv_window;
      signString += JSON.stringify(filteredParams);
    }
    
    this.logger.debug(`Signature string: ${signString}`); // For debugging
    return crypto.createHmac('sha256', this.apiSecret).update(signString).digest('hex');
  }
  
  /**
   * Make a public request to the ByBit API
   */
  async publicRequest(endpoint, params = {}) {
    try {
      const response = await axios.get(`${this.baseUrl}${endpoint}`, { params });
      this.logger.info(`Response data: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      this.logger.error(`Raw error: ${error.message}`);
      throw error;
    }
  }

   // Additional helper method to verify API key
   async verifyApiKey() {
    try {
      const timestamp = Date.now().toString();
      const recv_window = '5000';
      const queryString = `api_key=${this.apiKey}&recv_window=${recv_window}&timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
      
      const response = await this.axios.get('/v5/user/query-api', {
        params: {
          api_key: this.apiKey,
          recv_window: recv_window,
          timestamp: timestamp,
          sign: signature
        }
      });
      
      if (response.data && response.data.ret_code === 0) {
        this.logger.info('API key verification successful');
        return {
          valid: true,
          data: response.data.result
        };
      } else {
        this.logger.error(`API key verification failed: ${response.data.ret_msg}`);
        return {
          valid: false,
          message: response.data.ret_msg
        };
      }
    } catch (error) {
      this.logger.error(`API key verification error: ${error.message}`);
      return {
        valid: false,
        message: error.message
      };
    }
  }
  
  /**
   * Make a private (authenticated) request to the ByBit API
   */
  async privateRequest(endpoint, method = 'GET', params = {}) {
    try {
      const timestamp = Date.now(); // Ensure 13-digit timestamp
      const requestParams = { ...params }; // Don’t add recv_window here
      
      const signature = this.generateSignature(timestamp, requestParams, method);
      
      const headers = {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-RECV-WINDOW': '5000'
      };
      
      let response;
      if (method === 'GET') {
        response = await this.axios.get(endpoint, { params: requestParams, headers });
      } else if (method === 'POST') {
        response = await this.axios.post(endpoint, requestParams, { headers });
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
    const { result } = await this.privateRequest('/v5/account/wallet-balance', 'GET', { accountType: 'UNIFIED' });
    
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
      category: 'linear',
      settleCoin: 'USDT'
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
      accountType: 'UNIFIED',
      coin
    });
    
    return result.list[0].coin.find(c => c.coin === coin);
  }
}

module.exports = new ByBitAPI();