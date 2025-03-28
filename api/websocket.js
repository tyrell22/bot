const WebSocket = require('ws');
const crypto = require('crypto');
const config = require('../config');
const EventEmitter = require('events');
const loggerModule = require('../utils/logger');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    // Get logger instance
    this.logger = loggerModule.getLogger();
    
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
      const wsUrl = `${config.api.wsBaseUrl}/public/linear`;
      const ws = new WebSocket(wsUrl);
      
      this.connections['public'] = ws;
      this.reconnectAttempts['public'] = 0;
      
      ws.on('open', () => {
        this.logger.info('Public WebSocket connected');
        
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
        this.logger.error(`Public WebSocket error: ${error.message}`);
        if (!this.connected) {
          reject(error);
        }
      });
      
      ws.on('close', () => {
        this.logger.warn('Public WebSocket closed');
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
      this.logger.warn('API credentials not provided, skipping private WebSocket connection');
      return false;
    }
    
    return new Promise((resolve, reject) => {
      // Connect to the private WebSocket endpoint without authentication params
      const wsUrl = `${config.api.wsBaseUrl}/private`;
      const ws = new WebSocket(wsUrl);
      
      this.connections['private'] = ws;
      this.reconnectAttempts['private'] = 0;
      
      ws.on('open', () => {
        this.logger.info('Private WebSocket connected, authenticating...');
        
        // Generate authentication parameters
        const expires = Date.now() + 10000;
        const signature = crypto
          .createHmac('sha256', config.api.apiSecret)
          .update(`GET/realtime${expires}`)
          .digest('hex');
        
        // Send authentication message
        const authMessage = JSON.stringify({
          op: "auth",
          args: [
            config.api.apiKey,
            expires,
            signature
          ]
        });
        
        ws.send(authMessage);
        
        // We'll wait for the auth response in the message handler
        // Don't resolve the promise yet
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          
          // Check for auth response
          if (message.op === 'auth') {
            if (message.success) {
              this.logger.info(`Private WebSocket authenticated successfully: ${message.conn_id}`);
              
              // Setup ping interval
              this.setupPingInterval('private');
              
              // Subscribe to execution events
              this.subscribeToPrivateTopics(['execution', 'position', 'order']);
              
              resolve(true);
            } else {
              this.logger.error(`Private WebSocket authentication failed: ${message.ret_msg}`);
              reject(new Error(`Authentication failed: ${message.ret_msg}`));
            }
          } else {
            // Handle other message types
            this.handlePrivateMessage(data);
          }
        } catch (error) {
          this.logger.error(`Error processing WebSocket message: ${error.message}`);
        }
      });
      
      ws.on('error', (error) => {
        this.logger.error(`Private WebSocket error: ${error.message}`);
        if (!this.connected) {
          reject(error);
        }
      });
      
      ws.on('close', () => {
        this.logger.warn('Private WebSocket closed');
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
    
    this.logger.info(`Attempting to reconnect public WebSocket in ${delay}ms (attempt ${this.reconnectAttempts[connectionName]})`);
    
    setTimeout(() => {
      this.connectPublicWebSocket(symbols).catch(error => {
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
    
    this.logger.info(`Attempting to reconnect private WebSocket in ${delay}ms (attempt ${this.reconnectAttempts[connectionName]})`);
    
    setTimeout(() => {
      this.connectPrivateWebSocket().catch(error => {
        this.logger.error(`Failed to reconnect private WebSocket: ${error.message}`);
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
    this.logger.info(`Subscribed to klines for ${symbols.length} symbols on ${config.timeframes.length} timeframes`);
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
    this.logger.info(`Subscribed to orderbook data for ${symbols.length} symbols`);
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
    this.logger.info(`Subscribed to ticker data for ${symbols.length} symbols`);
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
    this.logger.info(`Subscribed to private topics: ${topics.join(', ')}`);
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
      
      // Handle ping/pong
      if (message.op === 'pong') {
        this.logger.debug('Received pong from public WebSocket');
        return;
      }
      
      // Handle subscription response
      if (message.op === 'subscribe') {
        this.logger.debug(`Subscription to ${message.args} successful`);
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
            this.logger.debug(`Received unknown topic: ${message.topic}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error processing public WebSocket message: ${error.message}`);
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
      this.logger.debug('Received pong from private WebSocket');
      return;
    }
    
    // Handle authentication response
    if (message.op === 'auth') {
      if (message.success) {
        this.logger.info(`WebSocket authentication successful: ${message.conn_id}`);
      } else {
        this.logger.error(`WebSocket authentication failed: ${message.ret_msg}`);
        // Trigger reconnection with proper authentication
        if (this.connections['private']) {
          this.connections['private'].close();
        }
      }
      return;
    }
    
    // Handle subscription response
    if (message.op === 'subscribe') {
      this.logger.debug(`Subscription to ${message.args} successful`);
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
          this.logger.debug(`Received unknown private topic: ${topic}`);
      }
    }
  } catch (error) {
    this.logger.error(`Error processing private WebSocket message: ${error.message}`);
    // Log the raw message for debugging
    this.logger.debug(`Raw message data: ${data}`);
  }
}
  
  /**
   * Process kline data
   */
  processKlineData(message) {
    // Verify required properties exist
    if (!message || !message.topic || !message.data) {
      this.logger.warn('Received invalid kline data');
      return;
    }

    const topicParts = message.topic.split('.');
    if (topicParts.length < 3) {
      this.logger.warn(`Received invalid kline topic: ${message.topic}`);
      return;
    }

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
    if (message.type === 'delta' && Array.isArray(data) && data.length > 0) {
      // Update the latest candle
      const kline = data[0];
      
      // Validate kline data structure
      if (!kline || !kline.start || kline.open === undefined || kline.high === undefined ||
          kline.low === undefined || kline.close === undefined || kline.volume === undefined) {
        this.logger.warn(`Received invalid kline data for ${symbol}`);
        return;
      }
      
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
    else if (message.type === 'snapshot' && Array.isArray(data)) {
      // Validate each kline in the data
      const validatedKlines = data
        .filter(kline => kline && kline.start && kline.open !== undefined && 
                kline.high !== undefined && kline.low !== undefined && 
                kline.close !== undefined && kline.volume !== undefined)
        .map(kline => ({
          timestamp: kline.start,
          open: parseFloat(kline.open),
          high: parseFloat(kline.high),
          low: parseFloat(kline.low),
          close: parseFloat(kline.close),
          volume: parseFloat(kline.volume),
          turnover: parseFloat(kline.turnover)
        }));
        
      this.marketData.klines[symbol][timeframe] = validatedKlines;
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
    
    // For snapshot, we replace the entire orderbook
    if (message.type === 'snapshot' && data && data.ts && Array.isArray(data.b) && Array.isArray(data.a)) {
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
    else if (message.type === 'delta' && data && data.ts) {
      if (!this.marketData.orderbooks[symbol]) {
        this.logger.warn(`Received orderbook delta for ${symbol} without having a snapshot first`);
        return;
      }
      
      const orderbook = this.marketData.orderbooks[symbol];
      orderbook.timestamp = data.ts;
      
      // Update bids
      if (Array.isArray(data.b) && data.b.length > 0) {
        for (const bid of data.b) {
          if (bid.length < 2) continue; // Skip invalid entries
          
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
      if (Array.isArray(data.a) && data.a.length > 0) {
        for (const ask of data.a) {
          if (ask.length < 2) continue; // Skip invalid entries
          
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
    
    // Emit the updated orderbook event if we have valid data
    if (this.marketData.orderbooks[symbol]) {
      this.emit('orderbook', {
        symbol,
        data: this.marketData.orderbooks[symbol]
      });
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
      this.logger.info(`Raw message: ${JSON.stringify(message)}`);
      return;
    }
  
    const symbol = topicParts[1];
    const data = message.data;
  
    // Log raw data for every message
    this.logger.info(`Raw ticker data for ${symbol}: ${JSON.stringify(data)}`);
  
    // Determine a lastPrice from available fields
    let lastPrice;
    if (data.lastPrice) {
      lastPrice = parseFloat(data.lastPrice);
    } else if (data.bid1Price && data.ask1Price) {
      lastPrice = (parseFloat(data.bid1Price) + parseFloat(data.ask1Price)) / 2;
      this.logger.info(`Calculated lastPrice for ${symbol} from bid/ask: ${lastPrice}`);
    } else if (data.bid1Price) {
      lastPrice = parseFloat(data.bid1Price);
      this.logger.debug(`Using bid1Price as lastPrice for ${symbol}: ${lastPrice}`);
    } else if (data.ask1Price) {
      lastPrice = parseFloat(data.ask1Price);
      this.logger.info(`Using ask1Price as lastPrice for ${symbol}: ${lastPrice}`);
    } else {
      this.logger.warn(`Received invalid ticker data for ${symbol} - no usable price field`);
      return;
    }
  
    // Initialize storage
    if (!this.marketData.tickers) {
      this.marketData.tickers = {};
    }
  
    // Process with fallback values
    this.marketData.tickers[symbol] = {
      symbol,
      lastPrice,
      highPrice24h: data.highPrice24h ? parseFloat(data.highPrice24h) : 0,
      lowPrice24h: data.lowPrice24h ? parseFloat(data.lowPrice24h) : 0,
      volume24h: data.volume24h ? parseFloat(data.volume24h) : 0, // Fallback to 0 if missing
      turnover24h: data.turnover24h ? parseFloat(data.turnover24h) : 0,
      price24hPcnt: data.price24hPcnt != null ? parseFloat(data.price24hPcnt) : 0,
      timestamp: Date.now(),
      bidPrice: data.bid1Price ? parseFloat(data.bid1Price) : null,
      askPrice: data.ask1Price ? parseFloat(data.ask1Price) : null,
      bidSize: data.bid1Size ? parseFloat(data.bid1Size) : null,
      askSize: data.ask1Size ? parseFloat(data.ask1Size) : null
    };
  
    // Warn if key fields are missing
    if (!data.highPrice24h || !data.lowPrice24h || !data.price24hPcnt || !data.volume24h) {
      this.logger.warn(`Partial ticker data for ${symbol} - missing some expected fields`);
    }
  
    this.emit('ticker', { symbol, data: this.marketData.tickers[symbol] });
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
        this.logger.info(`Closing ${name} WebSocket connection`);
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