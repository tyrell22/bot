const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('../config');
const EventEmitter = require('events');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.connections = {};
    this.subscriptions = {};
    this.marketData = {};
    this.reconnectAttempts = {};
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
    this.pingInterval = 20000; // 20 seconds
    this.pingTimeouts = {};
    this.connected = false;
  }
  
  /**
   * Initialize WebSocket connections for multiple symbols
   */
  async initConnections(symbols) {
    // Public channels
    await this.connectPublicWebSocket(symbols);
    
    // Private channels
    await this.connectPrivateWebSocket();
    
    this.connected = true;
    return true;
  }
  
  /**
   * Connect to public WebSocket
   */
  async connectPublicWebSocket(symbols) {
    return new Promise((resolve, reject) => {
      const wsUrl = `${config.api.wsBaseUrl}/public`;
      const ws = new WebSocket(wsUrl);
      
      this.connections['public'] = ws;
      this.reconnectAttempts['public'] = 0;
      
      ws.on('open', () => {
        logger.info('Public WebSocket connected');
        
        // Setup ping interval
        this.setupPingInterval('public');
        
        // Subscribe to klines (candlesticks)
        this.subscribeToKlines(symbols);
        
        // Subscribe to orderbooks
        this.subscribeToOrderbooks(symbols);
        
        // Subscribe to tickers
        this.subscribeToTickers(symbols);
        
        resolve(true);
      });
      
      ws.on('message', (data) => {
        this.handlePublicMessage(data);
      });
      
      ws.on('error', (error) => {
        logger.error(`Public WebSocket error: ${error.message}`);
        if (!this.connected) {
          reject(error);
        }
      });
      
      ws.on('close', () => {
        logger.warn('Public WebSocket closed');
        clearInterval(this.pingTimeouts['public']);
        
        // Attempt to reconnect
        this.reconnectPublicWebSocket(symbols);
      });
    });
  }
  
  /**
   * Connect to private WebSocket
   */
  async connectPrivateWebSocket() {
    if (!config.api.apiKey || !config.api.apiSecret) {
      logger.warn('API credentials not provided, skipping private WebSocket connection');
      return false;
    }
    
    return new Promise((resolve, reject) => {
      // Generate authentication parameters
      const expires = Date.now() + 10000;
      const signature = crypto
        .createHmac('sha256', config.api.apiSecret)
        .update(`GET/realtime${expires}`)
        .digest('hex');
      
      const wsUrl = `${config.api.wsBaseUrl}/private?api_key=${config.api.apiKey}&expires=${expires}&signature=${signature}`;
      const ws = new WebSocket(wsUrl);
      
      this.connections['private'] = ws;
      this.reconnectAttempts['private'] = 0;
      
      ws.on('open', () => {
        logger.info('Private WebSocket connected');
        
        // Setup ping interval
        this.setupPingInterval('private');
        
        // Subscribe to execution events
        this.subscribeToPrivateTopics(['execution', 'position', 'order']);
        
        resolve(true);
      });
      
      ws.on('message', (data) => {
        this.handlePrivateMessage(data);
      });
      
      ws.on('error', (error) => {
        logger.error(`Private WebSocket error: ${error.message}`);
        if (!this.connected) {
          reject(error);
        }
      });
      
      ws.on('close', () => {
        logger.warn('Private WebSocket closed');
        clearInterval(this.pingTimeouts['private']);
        
        // Attempt to reconnect
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
        logger.debug(`Sent ping to ${connectionName} WebSocket`);
      }
    }, this.pingInterval);
  }
  
  /**
   * Reconnect to public WebSocket
   */
  reconnectPublicWebSocket(symbols) {
    const connectionName = 'public';
    if (this.reconnectAttempts[connectionName] >= this.maxReconnectAttempts) {
      logger.error('Maximum reconnect attempts reached for public WebSocket');
      return;
    }
    
    this.reconnectAttempts[connectionName]++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts[connectionName]);
    
    logger.info(`Attempting to reconnect public WebSocket in ${delay}ms (attempt ${this.reconnectAttempts[connectionName]})`);
    
    setTimeout(() => {
      this.connectPublicWebSocket(symbols).catch(error => {
        logger.error(`Failed to reconnect public WebSocket: ${error.message}`);
      });
    }, delay);
  }
  
  /**
   * Reconnect to private WebSocket
   */
  reconnectPrivateWebSocket() {
    const connectionName = 'private';
    if (this.reconnectAttempts[connectionName] >= this.maxReconnectAttempts) {
      logger.error('Maximum reconnect attempts reached for private WebSocket');
      return;
    }
    
    this.reconnectAttempts[connectionName]++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts[connectionName]);
    
    logger.info(`Attempting to reconnect private WebSocket in ${delay}ms (attempt ${this.reconnectAttempts[connectionName]})`);
    
    setTimeout(() => {
      this.connectPrivateWebSocket().catch(error => {
        logger.error(`Failed to reconnect private WebSocket: ${error.message}`);
      });
    }, delay);
  }
  
  /**
   * Subscribe to klines (candlesticks)
   */
  subscribeToKlines(symbols) {
    const args = [];
    
    // Build args for subscribing to multiple timeframes for each symbol
    for (const symbol of symbols) {
      for (const timeframe of config.timeframes) {
        args.push(`kline.${timeframe}.${symbol}`);
      }
    }
    
    const subscribeMsg = {
      op: 'subscribe',
      args
    };
    
    this.send('public', subscribeMsg);
    logger.info(`Subscribed to klines for ${symbols.length} symbols on ${config.timeframes.length} timeframes`);
  }
  
  /**
   * Subscribe to orderbooks
   */
  subscribeToOrderbooks(symbols) {
    const args = symbols.map(symbol => `orderbook.${config.orderbook.depth}.${symbol}`);
    
    const subscribeMsg = {
      op: 'subscribe',
      args
    };
    
    this.send('public', subscribeMsg);
    logger.info(`Subscribed to orderbook data for ${symbols.length} symbols`);
  }
  
  /**
   * Subscribe to tickers
   */
  subscribeToTickers(symbols) {
    const args = symbols.map(symbol => `tickers.${symbol}`);
    
    const subscribeMsg = {
      op: 'subscribe',
      args
    };
    
    this.send('public', subscribeMsg);
    logger.info(`Subscribed to ticker data for ${symbols.length} symbols`);
  }
  
  /**
   * Subscribe to private topics
   */
  subscribeToPrivateTopics(topics) {
    const subscribeMsg = {
      op: 'subscribe',
      args: topics
    };
    
    this.send('private', subscribeMsg);
    logger.info(`Subscribed to private topics: ${topics.join(', ')}`);
  }
  
  /**
   * Send message to WebSocket
   */
  send(connectionName, data) {
    const ws = this.connections[connectionName];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.error(`Cannot send message: ${connectionName} WebSocket is not open`);
      return false;
    }
    
    try {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      ws.send(message);
      return true;
    } catch (error) {
      logger.error(`Failed to send message to ${connectionName} WebSocket: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Handle public WebSocket messages
   */
  handlePublicMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Handle ping/pong
      if (message.op === 'pong') {
        logger.debug('Received pong from public WebSocket');
        return;
      }
      
      // Handle subscription response
      if (message.op === 'subscribe') {
        logger.debug(`Subscription to ${message.args} successful`);
        return;
      }
      
      // Handle data message
      if (message.topic && message.data) {
        // Extract topic parts
        const topicParts = message.topic.split('.');
        const dataType = topicParts[0];
        
        // Process different data types
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
            logger.debug(`Received unknown topic: ${message.topic}`);
        }
      }
    } catch (error) {
      logger.error(`Error processing public WebSocket message: ${error.message}`);
    }
  }
  
  /**
   * Handle private WebSocket messages
   */
  handlePrivateMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Handle ping/pong
      if (message.op === 'pong') {
        logger.debug('Received pong from private WebSocket');
        return;
      }
      
      // Handle subscription response
      if (message.op === 'subscribe') {
        logger.debug(`Subscription to ${message.args} successful`);
        return;
      }
      
      // Handle data message
      if (message.topic && message.data) {
        // Extract topic
        const topic = message.topic;
        
        // Process different private topics
        switch (topic) {
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
            logger.debug(`Received unknown private topic: ${topic}`);
        }
      }
    } catch (error) {
      logger.error(`Error processing private WebSocket message: ${error.message}`);
    }
  }
  
  /**
   * Process kline data
   */
  processKlineData(message) {
    const topicParts = message.topic.split('.');
    const timeframe = topicParts[1];
    const symbol = topicParts[2];
    const data = message.data;
    
    // Initialize storage for this symbol and timeframe if needed
    if (!this.marketData.klines) {
      this.marketData.klines = {};
    }
    
    if (!this.marketData.klines[symbol]) {
      this.marketData.klines[symbol] = {};
    }
    
    if (!this.marketData.klines[symbol][timeframe]) {
      this.marketData.klines[symbol][timeframe] = [];
    }
    
    // Store the latest klines
    // For delta, we update the existing data
    if (message.type === 'delta') {
      // Update the latest candle
      const kline = data[0];
      const formattedKline = {
        timestamp: kline.start,
        open: parseFloat(kline.open),
        high: parseFloat(kline.high),
        low: parseFloat(kline.low),
        close: parseFloat(kline.close),
        volume: parseFloat(kline.volume),
        turnover: parseFloat(kline.turnover)
      };
      
      // Find and update the existing candle or add a new one
      const existingIndex = this.marketData.klines[symbol][timeframe].findIndex(
        k => k.timestamp === formattedKline.timestamp
      );
      
      if (existingIndex !== -1) {
        this.marketData.klines[symbol][timeframe][existingIndex] = formattedKline;
      } else {
        this.marketData.klines[symbol][timeframe].push(formattedKline);
        // Keep array sorted by timestamp
        this.marketData.klines[symbol][timeframe].sort((a, b) => a.timestamp - b.timestamp);
      }
    } 
    // For snapshot, we replace the entire dataset
    else if (message.type === 'snapshot') {
      this.marketData.klines[symbol][timeframe] = data.map(kline => ({
        timestamp: kline.start,
        open: parseFloat(kline.open),
        high: parseFloat(kline.high),
        low: parseFloat(kline.low),
        close: parseFloat(kline.close),
        volume: parseFloat(kline.volume),
        turnover: parseFloat(kline.turnover)
      }));
    }
    
    // Limit the kline history to a reasonable amount
    const maxKlines = 500;
    if (this.marketData.klines[symbol][timeframe].length > maxKlines) {
      this.marketData.klines[symbol][timeframe] = this.marketData.klines[symbol][timeframe].slice(
        -maxKlines
      );
    }
    
    // Emit the updated kline event
    this.emit('kline', {
      symbol,
      timeframe,
      data: this.marketData.klines[symbol][timeframe]
    });
  }
  
  /**
   * Process orderbook data
   */
  processOrderbookData(message) {
    const topicParts = message.topic.split('.');
    const depth = topicParts[1];
    const symbol = topicParts[2];
    const data = message.data;
    
    // Initialize storage for this symbol if needed
    if (!this.marketData.orderbooks) {
      this.marketData.orderbooks = {};
    }
    
    // For snapshot, we replace the entire orderbook
    if (message.type === 'snapshot') {
      this.marketData.orderbooks[symbol] = {
        symbol,
        timestamp: data.ts,
        bids: data.b.map(bid => ({
          price: parseFloat(bid[0]),
          quantity: parseFloat(bid[1])
        })),
        asks: data.a.map(ask => ({
          price: parseFloat(ask[0]),
          quantity: parseFloat(ask[1])
        }))
      };
    } 
    // For delta, we update the existing orderbook
    else if (message.type === 'delta') {
      if (!this.marketData.orderbooks[symbol]) {
        logger.warn(`Received orderbook delta for ${symbol} without having a snapshot first`);
        return;
      }
      
      const orderbook = this.marketData.orderbooks[symbol];
      orderbook.timestamp = data.ts;
      
      // Update bids
      if (data.b && data.b.length > 0) {
        for (const bid of data.b) {
          const price = parseFloat(bid[0]);
          const quantity = parseFloat(bid[1]);
          
          // Remove price level if quantity is 0
          if (quantity === 0) {
            orderbook.bids = orderbook.bids.filter(b => b.price !== price);
          } else {
            // Update existing price level or add new one
            const existingBid = orderbook.bids.find(b => b.price === price);
            if (existingBid) {
              existingBid.quantity = quantity;
            } else {
              orderbook.bids.push({ price, quantity });
            }
          }
        }
        
        // Sort bids (descending)
        orderbook.bids.sort((a, b) => b.price - a.price);
      }
      
      // Update asks
      if (data.a && data.a.length > 0) {
        for (const ask of data.a) {
          const price = parseFloat(ask[0]);
          const quantity = parseFloat(ask[1]);
          
          // Remove price level if quantity is 0
          if (quantity === 0) {
            orderbook.asks = orderbook.asks.filter(a => a.price !== price);
          } else {
            // Update existing price level or add new one
            const existingAsk = orderbook.asks.find(a => a.price === price);
            if (existingAsk) {
              existingAsk.quantity = quantity;
            } else {
              orderbook.asks.push({ price, quantity });
            }
          }
        }
        
        // Sort asks (ascending)
        orderbook.asks.sort((a, b) => a.price - b.price);
      }
    }
    
    // Emit the updated orderbook event
    this.emit('orderbook', {
      symbol,
      data: this.marketData.orderbooks[symbol]
    });
  }
  
  /**
   * Process ticker data
   */
  processTickerData(message) {
    const topicParts = message.topic.split('.');
    const symbol = topicParts[1];
    const data = message.data;
    
    // Initialize storage for tickers if needed
    if (!this.marketData.tickers) {
      this.marketData.tickers = {};
    }
    
    // Process ticker data
    this.marketData.tickers[symbol] = {
      symbol,
      lastPrice: parseFloat(data.lastPrice),
      highPrice24h: parseFloat(data.highPrice24h),
      lowPrice24h: parseFloat(data.lowPrice24h),
      volume24h: parseFloat(data.volume24h),
      turnover24h: parseFloat(data.turnover24h),
      price24hPcnt: parseFloat(data.price24hPcnt),
      timestamp: Date.now()
    };
    
    // Emit the updated ticker event
    this.emit('ticker', {
      symbol,
      data: this.marketData.tickers[symbol]
    });
  }
  
  /**
   * Process execution data
   */
  processExecutionData(data) {
    this.emit('execution', data);
  }
  
  /**
   * Process position data
   */
  processPositionData(data) {
    this.emit('position', data);
  }
  
  /**
   * Process order data
   */
  processOrderData(data) {
    this.emit('order', data);
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
   * Changed from static to instance method to fix access to instance properties
   */
  async closeAll() {
    for (const [name, ws] of Object.entries(this.connections)) {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        logger.info(`Closing ${name} WebSocket connection`);
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