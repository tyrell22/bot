/**
 * Orderbook analysis module for trading signals
 */
class OrderbookAnalyzer {
  constructor() {
    this.orderbookHistory = {}; // Keep track of recent orderbooks for analysis
    this.maxHistoryLength = 30; // Keep last 30 snapshots for analysis
  }
  
  /**
   * Update the orderbook history with new data
   */
  updateOrderbookHistory(symbol, orderbook) {
    if (!this.orderbookHistory[symbol]) {
      this.orderbookHistory[symbol] = [];
    }
    
    // Add the new orderbook to history
    this.orderbookHistory[symbol].push({
      timestamp: orderbook.timestamp,
      bids: [...orderbook.bids],
      asks: [...orderbook.asks]
    });
    
    // Limit the history length
    if (this.orderbookHistory[symbol].length > this.maxHistoryLength) {
      this.orderbookHistory[symbol].shift();
    }
  }
  
  /**
   * Analyze orderbook for imbalances
   * Imbalances occur when there's significantly more volume on one side
   */
  analyzeImbalances(orderbook, depthPercentage = 1.0) {
    if (!orderbook || !orderbook.bids || !orderbook.asks || 
        orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return {
        valid: false,
        message: 'Invalid orderbook data'
      };
    }
    
    // Get mid price
    const bestBid = orderbook.bids[0].price;
    const bestAsk = orderbook.asks[0].price;
    const midPrice = (bestBid + bestAsk) / 2;
    
    // Calculate price ranges for depth analysis
    const minBidPrice = midPrice * (1 - depthPercentage / 100);
    const maxAskPrice = midPrice * (1 + depthPercentage / 100);
    
    // Calculate total volume within price range
    let bidVolume = 0;
    let askVolume = 0;
    
    for (const bid of orderbook.bids) {
      if (bid.price >= minBidPrice) {
        bidVolume += bid.quantity;
      }
    }
    
    for (const ask of orderbook.asks) {
      if (ask.price <= maxAskPrice) {
        askVolume += ask.quantity;
      }
    }
    
    // Calculate imbalance ratio
    const totalVolume = bidVolume + askVolume;
    const bidRatio = bidVolume / totalVolume;
    const askRatio = askVolume / totalVolume;
    const imbalanceRatio = bidVolume / askVolume;
    
    return {
      valid: true,
      midPrice,
      bidVolume,
      askVolume,
      totalVolume,
      bidRatio,
      askRatio,
      imbalanceRatio,
      // More than 2:1 ratio indicates significant imbalance
      significantImbalance: imbalanceRatio > 2.0 || imbalanceRatio < 0.5,
      bullishFactors,
      bearishFactors,
      totalFactors,
      overallScore,
      signal: overallScore > 0.3 ? 'BUY' : 
              overallScore < -0.3 ? 'SELL' : 
              'NEUTRAL'
    };
  }
}

module.exports = new OrderbookAnalyzer();: imbalanceRatio > 2.0,
      bearish: imbalanceRatio < 0.5
    };
  }
  
  /**
   * Identify large orders (walls) in the orderbook
   */
  findLargeOrders(orderbook, thresholdMultiple = 3) {
    if (!orderbook || !orderbook.bids || !orderbook.asks) {
      return {
        valid: false,
        message: 'Invalid orderbook data'
      };
    }
    
    // Calculate average order size to detect abnormal sizes
    let totalBidQuantity = 0;
    let totalAskQuantity = 0;
    
    orderbook.bids.forEach(bid => totalBidQuantity += bid.quantity);
    orderbook.asks.forEach(ask => totalAskQuantity += ask.quantity);
    
    const avgBidSize = totalBidQuantity / (orderbook.bids.length || 1);
    const avgAskSize = totalAskQuantity / (orderbook.asks.length || 1);
    
    // Find large bids
    const largeBids = orderbook.bids
      .filter(bid => bid.quantity > avgBidSize * thresholdMultiple)
      .map(bid => ({
        price: bid.price,
        quantity: bid.quantity,
        ratio: bid.quantity / avgBidSize
      }));
    
    // Find large asks
    const largeAsks = orderbook.asks
      .filter(ask => ask.quantity > avgAskSize * thresholdMultiple)
      .map(ask => ({
        price: ask.price,
        quantity: ask.quantity,
        ratio: ask.quantity / avgAskSize
      }));
    
    return {
      valid: true,
      avgBidSize,
      avgAskSize,
      largeBids,
      largeAsks,
      hasBidWalls: largeBids.length > 0,
      hasAskWalls: largeAsks.length > 0
    };
  }
  
  /**
   * Calculate the order book depth (liquidity) for buy and sell sides
   */
  calculateDepth(orderbook, priceRange = 0.01) {
    if (!orderbook || !orderbook.bids || !orderbook.asks || 
        orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return {
        valid: false,
        message: 'Invalid orderbook data'
      };
    }
    
    const bestBid = orderbook.bids[0].price;
    const bestAsk = orderbook.asks[0].price;
    const midPrice = (bestBid + bestAsk) / 2;
    
    // Calculate price thresholds
    const lowerBound = midPrice * (1 - priceRange);
    const upperBound = midPrice * (1 + priceRange);
    
    // Calculate depth
    let bidDepth = 0;
    let askDepth = 0;
    
    orderbook.bids.forEach(bid => {
      if (bid.price >= lowerBound) {
        bidDepth += bid.price * bid.quantity;
      }
    });
    
    orderbook.asks.forEach(ask => {
      if (ask.price <= upperBound) {
        askDepth += ask.price * ask.quantity;
      }
    });
    
    // Calculate depth ratio
    const totalDepth = bidDepth + askDepth;
    const bidDepthRatio = bidDepth / totalDepth;
    const askDepthRatio = askDepth / totalDepth;
    
    return {
      valid: true,
      midPrice,
      bidDepth,
      askDepth,
      totalDepth,
      bidDepthRatio,
      askDepthRatio,
      depthRatio: bidDepth / askDepth
    };
  }
  
  /**
   * Analyze spread changes over time
   */
  analyzeSpreadTrend(symbol, windowSize = 10) {
    if (!this.orderbookHistory[symbol] || this.orderbookHistory[symbol].length < windowSize) {
      return {
        valid: false,
        message: 'Insufficient orderbook history'
      };
    }
    
    // Calculate spreads for the recent orderbooks
    const spreads = this.orderbookHistory[symbol]
      .slice(-windowSize)
      .map(ob => {
        const bestBid = ob.bids[0]?.price || 0;
        const bestAsk = ob.asks[0]?.price || 0;
        return bestAsk - bestBid;
      });
    
    // Calculate average spread
    const avgSpread = spreads.reduce((sum, spread) => sum + spread, 0) / spreads.length;
    
    // Calculate spread trend
    const recentSpread = spreads[spreads.length - 1];
    const spreadChange = (recentSpread - spreads[0]) / spreads[0];
    
    // Calculate volatility
    const spreadVariance = spreads.reduce((sum, spread) => {
      const diff = spread - avgSpread;
      return sum + diff * diff;
    }, 0) / spreads.length;
    
    const spreadVolatility = Math.sqrt(spreadVariance);
    
    return {
      valid: true,
      currentSpread: recentSpread,
      averageSpread: avgSpread,
      spreadChange,
      spreadVolatility,
      wideningSpread: spreadChange > 0.1, // 10% increase in spread
      narrowingSpread: spreadChange < -0.1, // 10% decrease in spread
      spreads
    };
  }
  
  /**
   * Analyze order flow (additions and cancellations) over time
   */
  analyzeOrderFlow(symbol, windowSize = 5) {
    if (!this.orderbookHistory[symbol] || this.orderbookHistory[symbol].length < windowSize) {
      return {
        valid: false,
        message: 'Insufficient orderbook history'
      };
    }
    
    const history = this.orderbookHistory[symbol].slice(-windowSize);
    
    // Calculate changes in bid and ask volume
    let bidVolumeChanges = [];
    let askVolumeChanges = [];
    
    for (let i = 1; i < history.length; i++) {
      const prevOb = history[i - 1];
      const currOb = history[i];
      
      const prevBidVolume = prevOb.bids.reduce((sum, bid) => sum + bid.quantity, 0);
      const currBidVolume = currOb.bids.reduce((sum, bid) => sum + bid.quantity, 0);
      
      const prevAskVolume = prevOb.asks.reduce((sum, ask) => sum + ask.quantity, 0);
      const currAskVolume = currOb.asks.reduce((sum, ask) => sum + ask.quantity, 0);
      
      bidVolumeChanges.push(currBidVolume - prevBidVolume);
      askVolumeChanges.push(currAskVolume - prevAskVolume);
    }
    
    // Calculate aggregated changes
    const netBidVolumeChange = bidVolumeChanges.reduce((sum, change) => sum + change, 0);
    const netAskVolumeChange = askVolumeChanges.reduce((sum, change) => sum + change, 0);
    
    // Determine trend
    const totalVolumeChange = Math.abs(netBidVolumeChange) + Math.abs(netAskVolumeChange);
    const bidChangeRatio = netBidVolumeChange / totalVolumeChange;
    const askChangeRatio = netAskVolumeChange / totalVolumeChange;
    
    return {
      valid: true,
      netBidVolumeChange,
      netAskVolumeChange,
      bidVolumeChanges,
      askVolumeChanges,
      bidChangeRatio,
      askChangeRatio,
      bullishFlow: netBidVolumeChange > 0 && netAskVolumeChange < 0,
      bearishFlow: netBidVolumeChange < 0 && netAskVolumeChange > 0
    };
  }
  
  /**
   * Get a comprehensive analysis of the orderbook for a symbol
   */
  getFullAnalysis(symbol, orderbook) {
    // Update history first
    this.updateOrderbookHistory(symbol, orderbook);
    
    // Run all analyses
    const imbalances = this.analyzeImbalances(orderbook);
    const largeOrders = this.findLargeOrders(orderbook);
    const depth = this.calculateDepth(orderbook);
    const spreadTrend = this.analyzeSpreadTrend(symbol);
    const orderFlow = this.analyzeOrderFlow(symbol);
    
    // Combine results and determine overall signal
    let bullishFactors = 0;
    let bearishFactors = 0;
    let totalFactors = 0;
    
    // Analyze imbalances
    if (imbalances.valid) {
      totalFactors++;
      if (imbalances.bullish) bullishFactors++;
      if (imbalances.bearish) bearishFactors++;
    }
    
    // Analyze large orders
    if (largeOrders.valid) {
      // Bid walls are typically bullish (support)
      if (largeOrders.hasBidWalls) {
        totalFactors++;
        bullishFactors++;
      }
      
      // Ask walls are typically bearish (resistance)
      if (largeOrders.hasAskWalls) {
        totalFactors++;
        bearishFactors++;
      }
    }
    
    // Analyze depth
    if (depth.valid) {
      totalFactors++;
      if (depth.bidDepthRatio > 0.6) bullishFactors++; // 60% of depth on buy side
      if (depth.askDepthRatio > 0.6) bearishFactors++; // 60% of depth on sell side
    }
    
    // Analyze spread trends
    if (spreadTrend.valid) {
      totalFactors++;
      // Widening spread with higher volume can indicate volatility/uncertainty
      if (spreadTrend.wideningSpread) bearishFactors += 0.5;
      // Narrowing spread can indicate consolidation
      if (spreadTrend.narrowingSpread) bullishFactors += 0.5;
    }
    
    // Analyze order flow
    if (orderFlow.valid) {
      totalFactors++;
      if (orderFlow.bullishFlow) bullishFactors++;
      if (orderFlow.bearishFlow) bearishFactors++;
    }
    
    // Calculate overall sentiment score (-1 to 1)
    const overallScore = totalFactors > 0 ? 
      (bullishFactors - bearishFactors) / totalFactors : 0;
    
    return {
      symbol,
      timestamp: orderbook.timestamp,
      imbalances,
      largeOrders,
      depth,
      spreadTrend,
      orderFlow,
      bullish