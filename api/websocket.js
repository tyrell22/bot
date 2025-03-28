const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('../config');
const EventEmitter = require('events');
const loggerModule = require('../utils/logger');
const ByBitAPI = require('./bybit'); // Adjust path to your ByBitAPI file

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.logger = loggerModule.getLogger();
    this.bybitApi = ByBitAPI; // Use the existing instance
    this.connections = {};
    this.subscriptions = {};
    this.marketData = {};
    this.reconnectAttempts = {};
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.pingInterval = 20000;
    this.pingTimeouts = {};
    this.connected = false;
  }

  /**
   * Initialize WebSocket connections for multiple symbols with historical data
   * @param {string[]} symbols - Array of symbols to initialize
   */
  async initConnections(symbols) {
    try {
      this.logger.debug('Fetching historical klines for initialization...');
      for (const symbol of symbols) {
        for (const timeframe of config.timeframes) {
          await this.fetchHistoricalKlines(symbol, timeframe, 50);
        }
      }

      await this.connectPublicWebSocket(symbols);
      await this.connectPrivateWebSocket();

      this.connected = true;
      this.logger.debug('WebSocketManager initialized successfully with historical data');
      return true;
    } catch (error) {
      this.logger.error(`Failed to initialize WebSocketManager: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch historical klines using ByBitAPI
   * @param {string} symbol - Trading pair (e.g., BTCUSDT)
   * @param {string} timeframe - Kline interval (e.g., '1' for 1 minute)
   * @param {number} limit - Number of klines to fetch (default: 50)
   */
  async fetchHistoricalKlines(symbol, timeframe, limit = 50) {
    try {
      const klines = await this.bybitApi.getKlines(symbol, timeframe, limit);
      if (!klines || klines.length === 0) {
        throw new Error('No historical klines returned');
      }

      if (!this.marketData.klines) this.marketData.klines = {};
      if (!this.marketData.klines[symbol]) this.marketData.klines[symbol] = {};

      this.marketData.klines[symbol][timeframe] = klines.sort((a, b) => a.timestamp - b.timestamp);

      this.logger.debug(`Fetched ${klines.length} historical klines for ${symbol} on ${timeframe}`);
      this.emit('kline', { symbol, timeframe, data: this.marketData.klines[symbol][timeframe] });
    } catch (error) {
      this.logger.error(`Failed to fetch historical klines for ${symbol} (${timeframe}): ${error.message}`);
    }
  }

  /**
   * Connect to public WebSocket
   */
  async connectPublicWebSocket(symbols) {
    return new Promise((resolve, reject) => {
      const wsUrl = `${config.api.wsBaseUrl}/public/linear`;
      const ws = new WebSocket(wsUrl);

      this.connections['public'] = ws;
      this.reconnectAttempts['public'] = 0;

      ws.on('open', () => {
        this.logger.debug('Public WebSocket connected');
        this.setupPingInterval('public');
        this.subscribeToKlines(symbols);
        this.subscribeToOrderbooks(symbols);
        this.subscribeToTickers(symbols);
        resolve(true);
      });

      ws.on('message', (data) => this.handlePublicMessage(data));
      ws.on('error', (error) => {
        this.logger.error(`Public WebSocket error: ${error.message}`);
        if (!this.connected) reject(error);
      });
      ws.on('close', () => {
        this.logger.warn('Public WebSocket closed');
        clearInterval(this.pingTimeouts['public']);
        this.reconnectPublicWebSocket(symbols);
      });
    });
  }

  /**
   * Connect to private WebSocket
   */
  async connectPrivateWebSocket() {
    if (!config.api.apiKey || !config.api.apiSecret) {
      this.logger.warn('API credentials not provided, skipping private WebSocket connection');
      return false;
    }

    return new Promise((resolve, reject) => {
      const wsUrl = `${config.api.wsBaseUrl}/private`;
      const ws = new WebSocket(wsUrl);

      this.connections['private'] = ws;
      this.reconnectAttempts['private'] = 0;

      ws.on('open', () => {
        this.logger.debug('Private WebSocket connected, authenticating...');

        const expires = Date.now() + 10000;
        const signature = crypto
          .createHmac('sha256', config.api.apiSecret)
          .update(`GET/realtime${expires}`)
          .digest('hex');

        const authMessage = JSON.stringify({
          op: 'auth',
          args: [config.api.apiKey, expires, signature],
        });

        ws.send(authMessage);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          if (message.op === 'auth') {
            if (message.success) {
              this.logger.debug(`Private WebSocket authenticated successfully: ${message.conn_id}`);
              this.setupPingInterval('private');
              this.subscribeToPrivateTopics(['execution', 'position', 'order']);
              resolve(true);
            } else {
              this.logger.error(`Private WebSocket authentication failed: ${message.ret_msg}`);
              reject(new Error(`Authentication failed: ${message.ret_msg}`));
            }
          } else {
            this.handlePrivateMessage(data);
          }
        } catch (error) {
          this.logger.error(`Error processing WebSocket message: ${error.message}`);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`Private WebSocket error: ${error.message}`);
        if (!this.connected) reject(error);
      });

      ws.on('close', () => {
        this.logger.warn('Private WebSocket closed');
        clearInterval(this.pingTimeouts['private']);
        this.reconnectPrivateWebSocket();
      });
    });
  }

  /**
   * Set up ping interval to keep WebSocket alive
   */
  setupPingInterval(connectionName) {
    if (this.pingTimeouts[connectionName]) {
      clearInterval(this.pingTimeouts[connectionName]);
    }

    this.pingTimeouts[connectionName] = setInterval(() => {
      const ws = this.connections[connectionName];
      if (ws && ws.readyState === WebSocket.OPEN) {
        const pingMessage = JSON.stringify({ op: 'ping' });
        ws.send(pingMessage);
        this.logger.debug(`Sent ping to ${connectionName} WebSocket`);
      }
    }, this.pingInterval);
  }

  /**
   * Reconnect to public WebSocket
   */
  reconnectPublicWebSocket(symbols) {
    const connectionName = 'public';
    if (this.reconnectAttempts[connectionName] >= this.maxReconnectAttempts) {
      this.logger.error('Maximum reconnect attempts reached for public WebSocket');
      return;
    }

    this.reconnectAttempts[connectionName]++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts[connectionName]);

    this.logger.debug(`Attempting to reconnect public WebSocket in ${delay}ms (attempt ${this.reconnectAttempts[connectionName]})`);

    setTimeout(() => {
      this.connectPublicWebSocket(symbols).catch((error) => {
        this.logger.error(`Failed to reconnect public WebSocket: ${error.message}`);
      });
    }, delay);
  }

  /**
   * Reconnect to private WebSocket
   */
  reconnectPrivateWebSocket() {
    const connectionName = 'private';
    if (this.reconnectAttempts[connectionName] >= this.maxReconnectAttempts) {
      this.logger.error('Maximum reconnect attempts reached for private WebSocket');
      return;
    }

    this.reconnectAttempts[connectionName]++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts[connectionName]);

    this.logger.debug(`Attempting to reconnect private WebSocket in ${delay}ms (attempt ${this.reconnectAttempts[connectionName]})`);

    setTimeout(() => {
      this.connectPrivateWebSocket().catch((error) => {
        this.logger.error(`Failed to reconnect private WebSocket: ${error.message}`);
      });
    }, delay);
  }

  /**
   * Process real-time kline updates from WebSocket
   */
  processKlineData(message) {
    try {
      if (!message || !message.topic || !message.data) {
        this.logger.warn('Received invalid kline data - missing required fields');
        return;
      }

      const topicParts = message.topic.split('.');
      const timeframe = topicParts[1];
      const symbol = topicParts[2];
      const data = message.data;

      if (!this.marketData.klines[symbol] || !this.marketData.klines[symbol][timeframe]) {
        this.logger.warn(`No historical data found for ${symbol} (${timeframe}), initializing empty array`);
        if (!this.marketData.klines) this.marketData.klines = {};
        if (!this.marketData.klines[symbol]) this.marketData.klines[symbol] = {};
        this.marketData.klines[symbol][timeframe] = [];
      }

      const klines = this.marketData.klines[symbol][timeframe];
      let newKlineCount = 0;

      this.logger.debug(`${symbol} ${timeframe} - Pre-processing kline count: ${klines.length}`);

      if (Array.isArray(data)) {
        data.forEach((kline) => {
          const formattedKline = this.formatKline(kline);
          const existingIndex = klines.findIndex((k) => k.timestamp === formattedKline.timestamp);
          if (existingIndex === -1) {
            klines.push(formattedKline);
            newKlineCount++;
            this.logger.debug(`Added new kline for ${symbol} (${timeframe}) at ${formattedKline.timestamp}`);
          } else {
            klines[existingIndex] = formattedKline;
            this.logger.debug(`Updated kline for ${symbol} (${timeframe}) at ${formattedKline.timestamp}`);
          }
        });
      } else if (typeof data === 'object') {
        const formattedKline = this.formatKline(data);
        const existingIndex = klines.findIndex((k) => k.timestamp === formattedKline.timestamp);
        if (existingIndex === -1) {
          klines.push(formattedKline);
          newKlineCount++;
          this.logger.debug(`Added new kline for ${symbol} (${timeframe}) at ${formattedKline.timestamp}`);
        } else {
          klines[existingIndex] = formattedKline;
          this.logger.debug(`Updated kline for ${symbol} (${timeframe}) at ${formattedKline.timestamp}`);
        }
      }

      klines.sort((a, b) => a.timestamp - b.timestamp);

      if (klines.length > 100) {
        klines.splice(0, klines.length - 100);
      }

      this.logger.debug(`${symbol} ${timeframe} - Added ${newKlineCount} new klines, total now: ${klines.length}`);
      this.emit('kline', { symbol, timeframe, data: klines });
    } catch (error) {
      this.logger.error(`Error processing kline data: ${error.message}`);
      this.logger.error(`Error stack: ${error.stack}`);
    }
  }

  /**
   * Format kline data consistently
   */
  formatKline(kline) {
    if (typeof kline.start !== 'undefined') {
      return {
        timestamp: kline.start,
        open: parseFloat(kline.open),
        high: parseFloat(kline.high),
        low: parseFloat(kline.low),
        close: parseFloat(kline.close),
        volume: parseFloat(kline.volume),
        turnover: parseFloat(kline.turnover || 0),
      };
    }
    return {
      timestamp: kline.t || kline.timestamp || Date.now(),
      open: parseFloat(kline.o || kline.open || 0),
      high: parseFloat(kline.h || kline.high || 0),
      low: parseFloat(kline.l || kline.low || 0),
      close: parseFloat(kline.c || kline.close || 0),
      volume: parseFloat(kline.v || kline.volume || 0),
      turnover: parseFloat(kline.V || kline.turnover || 0),
    };
  }

  /**
   * Subscribe to klines (candlesticks)
   */
  subscribeToKlines(symbols) {
    const args = [];
    for (const symbol of symbols) {
      for (const timeframe of config.timeframes) {
        args.push(`kline.${timeframe}.${symbol}`);
      }
    }

    this.logger.debug(`Subscribing to klines with args: ${JSON.stringify(args)}`);
    const subscribeMsg = { op: 'subscribe', args };
    this.send('public', subscribeMsg);
    this.logger.debug(`Subscribed to klines for ${symbols.length} symbols on ${config.timeframes.length} timeframes`);
  }

  /**
   * Subscribe to orderbooks
   */
  subscribeToOrderbooks(symbols) {
    const args = symbols.map((symbol) => `orderbook.${config.orderbook.depth}.${symbol}`);
    this.logger.debug(`Subscribing to orderbooks with args: ${JSON.stringify(args)}`);
    const subscribeMsg = { op: 'subscribe', args };
    this.send('public', subscribeMsg);
    this.logger.debug(`Subscribed to orderbook data for ${symbols.length} symbols`);
  }

  /**
   * Subscribe to tickers
   */
  subscribeToTickers(symbols) {
    const args = symbols.map((symbol) => `tickers.${symbol}`);
    const subscribeMsg = { op: 'subscribe', args };
    this.send('public', subscribeMsg);
    this.logger.debug(`Subscribed to ticker data for ${symbols.length} symbols`);
  }

  /**
   * Subscribe to private topics
   */
  subscribeToPrivateTopics(topics) {
    const subscribeMsg = { op: 'subscribe', args: topics };
    this.send('private', subscribeMsg);
    this.logger.debug(`Subscribed to private topics: ${topics.join(', ')}`);
  }

  /**
   * Send message to WebSocket
   */
  send(connectionName, data) {
    const ws = this.connections[connectionName];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.error(`Cannot send message: ${connectionName} WebSocket is not open`);
      return false;
    }
    try {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      ws.send(message);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send message to ${connectionName} WebSocket: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle public WebSocket messages
   */
  handlePublicMessage(data) {
    try {
      const message = JSON.parse(data);

      if (message.op === 'pong') {
        this.logger.debug('Received pong from public WebSocket');
        return;
      }

      if (message.op === 'subscribe') {
        this.logger.debug(`Subscription to ${message.args} successful`);
        return;
      }

      if (message.topic && message.data) {
        const topicParts = message.topic.split('.');
        const dataType = topicParts[0];

        switch (dataType) {
          case 'kline':
            this.processKlineData(message);
            break;
          case 'orderbook':
            this.processOrderbookData(message);
            break;
          case 'tickers':
            this.processTickerData(message);
            break;
          default:
            this.logger.debug(`Received unknown topic: ${message.topic}`);
        }
      } else {
        this.logger.debug(`Received message without topic or data: ${JSON.stringify(message)}`);
      }
    } catch (error) {
      this.logger.error(`Error processing public WebSocket message: ${error.message}`);
      this.logger.error(`Raw message that caused error: ${data}`);
    }
  }

  /**
   * Handle private WebSocket messages
   */
  handlePrivateMessage(data) {
    try {
      const message = JSON.parse(data);

      if (message.op === 'pong') {
        this.logger.debug('Received pong from private WebSocket');
        return;
      }

      if (message.op === 'auth') {
        if (message.success) {
          this.logger.debug(`WebSocket authentication successful: ${message.conn_id}`);
        } else {
          this.logger.error(`WebSocket authentication failed: ${message.ret_msg}`);
          if (this.connections['private']) {
            this.connections['private'].close();
          }
        }
        return;
      }

      if (message.op === 'subscribe') {
        this.logger.debug(`Subscription to ${message.args} successful`);
        return;
      }

      if (message.topic && message.data) {
        switch (message.topic) {
          case 'execution':
            this.processExecutionData(message.data);
            break;
          case 'position':
            this.processPositionData(message.data);
            break;
          case 'order':
            this.processOrderData(message.data);
            break;
          default:
            this.logger.debug(`Received unknown private topic: ${message.topic}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error processing private WebSocket message: ${error.message}`);
      this.logger.debug(`Raw message data: ${data}`);
    }
  }


  
  processOrderbookData(message) {
    try {
      // Verify required properties exist
      if (!message || !message.topic || !message.data) {
        this.logger.warn('Received invalid orderbook data');
        return;
      }
  
      const topicParts = message.topic.split('.');
      if (topicParts.length < 3) {
        this.logger.warn(`Received invalid orderbook topic: ${message.topic}`);
        return;
      }
  
      const depth = topicParts[1];
      const symbol = topicParts[2];
      const data = message.data;
      
      // Initialize storage for this symbol if needed
      if (!this.marketData.orderbooks) {
        this.marketData.orderbooks = {};
      }
      
      // For ByBit V5 API, most updates are deltas
      if (message.type === 'delta') {
        
        
        // If we don't have an orderbook yet, create one
        if (!this.marketData.orderbooks[symbol]) {
          this.marketData.orderbooks[symbol] = {
            symbol,
            timestamp: message.ts || data.ts || Date.now(),
            bids: [],
            asks: []
          };
          this.logger.debug(`Created new orderbook for ${symbol}`);
        }
        
        const orderbook = this.marketData.orderbooks[symbol];
        orderbook.timestamp = message.ts || data.ts || Date.now();
        
        // Process bids
        if (Array.isArray(data.b)) {
          for (const bid of data.b) {
            if (!Array.isArray(bid) || bid.length < 2) continue;
            
            const price = parseFloat(bid[0]);
            const quantity = parseFloat(bid[1]);
            
            // Remove or update
            if (quantity === 0) {
              orderbook.bids = orderbook.bids.filter(b => b.price !== price);
            } else {
              const index = orderbook.bids.findIndex(b => b.price === price);
              if (index >= 0) {
                orderbook.bids[index].quantity = quantity;
              } else {
                orderbook.bids.push({ price, quantity });
              }
            }
          }
          
          // Sort bids
          orderbook.bids.sort((a, b) => b.price - a.price);
          
        }
        
        // Process asks
        if (Array.isArray(data.a)) {
          for (const ask of data.a) {
            if (!Array.isArray(ask) || ask.length < 2) continue;
            
            const price = parseFloat(ask[0]);
            const quantity = parseFloat(ask[1]);
            
            // Remove or update
            if (quantity === 0) {
              orderbook.asks = orderbook.asks.filter(a => a.price !== price);
            } else {
              const index = orderbook.asks.findIndex(a => a.price === price);
              if (index >= 0) {
                orderbook.asks[index].quantity = quantity;
              } else {
                orderbook.asks.push({ price, quantity });
              }
            }
          }
          
          // Sort asks
          orderbook.asks.sort((a, b) => a.price - b.price);
          this.logger.debug(`Updated asks for ${symbol}, now have ${orderbook.asks.length} asks`);
        }
        
        // Always emit the update, even if we just received a delta
        this.emit('orderbook', {
          symbol,
          data: orderbook
        });
        
        return;
      }
      
      // Handle snapshot updates (though ByBit V5 mostly uses deltas)
      if (message.type === 'snapshot') {
        this.logger.debug(`Processing snapshot for ${symbol} orderbook`);
        
        if (!data || !Array.isArray(data.b) || !Array.isArray(data.a)) {
          this.logger.warn(`Invalid snapshot data for ${symbol}`);
          return;
        }
        
        this.marketData.orderbooks[symbol] = {
          symbol,
          timestamp: message.ts || data.ts || Date.now(),
          bids: data.b.map(bid => ({
            price: parseFloat(bid[0]),
            quantity: parseFloat(bid[1])
          })),
          asks: data.a.map(ask => ({
            price: parseFloat(ask[0]),
            quantity: parseFloat(ask[1])
          }))
        };
        
        this.logger.debug(`Created orderbook snapshot for ${symbol} with ${data.b.length} bids and ${data.a.length} asks`);
        
        // Emit the updated orderbook
        this.emit('orderbook', {
          symbol,
          data: this.marketData.orderbooks[symbol]
        });
      }
    } catch (error) {
      this.logger.error(`Error processing orderbook data: ${error.message}`);
      this.logger.error(`Message that caused error: ${JSON.stringify(message)}`);
    }
  }
  
  
/**
 * Process ticker data
 */
processTickerData(message) {
  if (!message || !message.topic || !message.data) {
    this.logger.warn('Received invalid ticker data');
    this.logger.debug(`Raw message: ${JSON.stringify(message)}`);
    return;
  }

  const topicParts = message.topic.split('.');
  if (topicParts.length < 2) {
    this.logger.warn(`Received invalid ticker topic: ${message.topic}`);
    this.logger.debug(`Raw message: ${JSON.stringify(message)}`);
    return;
  }

  const symbol = topicParts[1];
  const data = message.data;

  // Initialize storage
  if (!this.marketData.tickers) {
    this.marketData.tickers = {};
  }

  // Get existing ticker or create new one
  const existingTicker = this.marketData.tickers[symbol] || {
    symbol,
    lastPrice: 0,
    highPrice24h: 0,
    lowPrice24h: 0,
    volume24h: 0,
    turnover24h: 0,
    price24hPcnt: 0,
    timestamp: Date.now(),
    bidPrice: null,
    askPrice: null,
    bidSize: null,
    askSize: null
  };

  // Determine a lastPrice from available fields
  if (data.lastPrice) {
    existingTicker.lastPrice = parseFloat(data.lastPrice);
  } else if (data.bid1Price && data.ask1Price) {
    // Calculate mid price if no lastPrice is available
    const midPrice = (parseFloat(data.bid1Price) + parseFloat(data.ask1Price)) / 2;
    existingTicker.lastPrice = midPrice;
  } else if (existingTicker.lastPrice === 0 && data.bid1Price) {
    existingTicker.lastPrice = parseFloat(data.bid1Price);
  } else if (existingTicker.lastPrice === 0 && data.ask1Price) {
    existingTicker.lastPrice = parseFloat(data.ask1Price);
  }

  // Update only the fields that are present in the current message
  if (data.highPrice24h) existingTicker.highPrice24h = parseFloat(data.highPrice24h);
  if (data.lowPrice24h) existingTicker.lowPrice24h = parseFloat(data.lowPrice24h);
  if (data.volume24h) existingTicker.volume24h = parseFloat(data.volume24h);
  if (data.turnover24h) existingTicker.turnover24h = parseFloat(data.turnover24h);
  if (data.price24hPcnt) existingTicker.price24hPcnt = parseFloat(data.price24hPcnt);
  if (data.bid1Price) existingTicker.bidPrice = parseFloat(data.bid1Price);
  if (data.ask1Price) existingTicker.askPrice = parseFloat(data.ask1Price);
  if (data.bid1Size) existingTicker.bidSize = parseFloat(data.bid1Size);
  if (data.ask1Size) existingTicker.askSize = parseFloat(data.ask1Size);
  
  // Always update timestamp
  existingTicker.timestamp = Date.now();

  // Save updated ticker
  this.marketData.tickers[symbol] = existingTicker;

  // Only log the ticker once fully populated
  const isMissingEssentialData = !existingTicker.highPrice24h || 
                                !existingTicker.lowPrice24h || 
                                !existingTicker.volume24h;
  
  if (isMissingEssentialData && message.type === 'snapshot') {
    this.logger.warn(`Incomplete ticker snapshot for ${symbol} - missing some expected fields`);
  }

  this.emit('ticker', { symbol, data: existingTicker });
}
  
  /**
   * Process execution data
   */
  processExecutionData(data) {
    // Validate execution data before emitting
    if (Array.isArray(data) && data.length > 0) {
      this.emit('execution', data);
    } else {
      this.logger.warn('Received invalid execution data');
    }
  }
  
  /**
   * Process position data
   */
  processPositionData(data) {
    // Validate position data before emitting
    if (Array.isArray(data) && data.length > 0) {
      this.emit('position', data);
    } else {
      this.logger.warn('Received invalid position data');
    }
  }
  
  /**
   * Process order data
   */
  processOrderData(data) {
    // Validate order data before emitting
    if (Array.isArray(data) && data.length > 0) {
      this.emit('order', data);
    } else {
      this.logger.warn('Received invalid order data');
    }
  }
  
  /**
   * Get kline data for a symbol and timeframe
   */
  getKlines(symbol, timeframe) {
    if (!this.marketData.klines || !this.marketData.klines[symbol] || !this.marketData.klines[symbol][timeframe]) {
      return [];
    }
    
    return this.marketData.klines[symbol][timeframe];
  }
  
  /**
   * Get orderbook data for a symbol
   */
  getOrderbook(symbol) {
    if (!this.marketData.orderbooks || !this.marketData.orderbooks[symbol]) {
      return null;
    }
    
    return this.marketData.orderbooks[symbol];
  }
  
  /**
   * Get ticker data for a symbol
   */
  getTicker(symbol) {
    if (!this.marketData.tickers || !this.marketData.tickers[symbol]) {
      return null;
    }
    
    return this.marketData.tickers[symbol];
  }
  
  /**
   * Close all WebSocket connections
   * Instance method to close all connections
   */
  async closeAll() {
    for (const [name, ws] of Object.entries(this.connections)) {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        this.logger.debug(`Closing ${name} WebSocket connection`);
        ws.close();
      }
      
      if (this.pingTimeouts[name]) {
        clearInterval(this.pingTimeouts[name]);
      }
    }
    
    return true;
  }
}

module.exports = WebSocketManager;