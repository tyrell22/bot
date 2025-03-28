/**
 * Signal generation and processing module
 * Centralized place for handling signals from different strategies
 */
const EventEmitter = require('events');
const storage = require('../data/storage');

class SignalProcessor extends EventEmitter {
  constructor() {
    super();
    this.lastProcessedSignals = {};
    this.signalHistory = [];
    this.maxHistorySize = 1000;
  }
  
  /**
   * Process a new trading signal
   * @param {Object} signal - The trading signal
   * @returns {Object} - The processed signal
   */
  processSignal(signal) {
    // Check for duplicates or cooldown
    if (this.isDuplicateSignal(signal)) {
      return null;
    }
    
    // Store the signal
    this.storeSignal(signal);
    
    // Emit processed signal
    this.emit('signal', signal);
    
    return signal;
  }
  
  /**
   * Check if a signal is a duplicate or in cooldown
   * @param {Object} signal - The trading signal
   * @returns {boolean} - Whether the signal should be skipped
   */
  isDuplicateSignal(signal) {
    const signalKey = `${signal.symbol}-${signal.direction}`;
    const lastSignal = this.lastProcessedSignals[signalKey];
    
    // Skip if we recently processed a similar signal (within 5 minutes)
    if (lastSignal && (signal.timestamp - lastSignal.timestamp) < 5 * 60 * 1000) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Store a signal for future reference
   * @param {Object} signal - The trading signal
   */
  storeSignal(signal) {
    const signalKey = `${signal.symbol}-${signal.direction}`;
    
    // Update last processed signal
    this.lastProcessedSignals[signalKey] = {
      timestamp: signal.timestamp,
      strength: signal.strength
    };
    
    // Add to history
    this.signalHistory.push({
      ...signal,
      id: `${signal.symbol}-${signal.direction}-${signal.timestamp}`
    });
    
    // Limit history size
    if (this.signalHistory.length > this.maxHistorySize) {
      this.signalHistory = this.signalHistory.slice(-this.maxHistorySize);
    }
    
    // Persist signals
    this.saveSignals();
  }
  
  /**
   * Save signals to persistent storage
   */
  saveSignals() {
    // Store only last 100 signals
    const recentSignals = this.signalHistory.slice(-100);
    
    try {
      storage.saveData('signals', recentSignals);
    } catch (error) {
      logger.error(`Error saving signals: ${error.message}`);
    }
  }
  
  /**
   * Load signals from storage
   */
  loadSignals() {
    try {
      const loadedSignals = storage.loadData('signals') || [];
      this.signalHistory = loadedSignals;
      
      // Rebuild last processed signals
      for (const signal of loadedSignals) {
        const signalKey = `${signal.symbol}-${signal.direction}`;
        
        // Only update if this signal is newer
        if (!this.lastProcessedSignals[signalKey] || 
            signal.timestamp > this.lastProcessedSignals[signalKey].timestamp) {
          this.lastProcessedSignals[signalKey] = {
            timestamp: signal.timestamp,
            strength: signal.strength
          };
        }
      }
      
      logger.info(`Loaded ${loadedSignals.length} signals from storage`);
    } catch (error) {
      logger.error(`Error loading signals: ${error.message}`);
    }
  }
  
  /**
   * Get signals for a specific symbol
   * @param {string} symbol - The trading pair symbol
   * @param {number} limit - Maximum number of signals to return
   * @returns {Array} - Array of signals
   */
  getSignalsForSymbol(symbol, limit = 10) {
    return this.signalHistory
      .filter(signal => signal.symbol === symbol)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
  
  /**
   * Get recent signals
   * @param {number} limit - Maximum number of signals to return
   * @returns {Array} - Array of recent signals
   */
  getRecentSignals(limit = 10) {
    return this.signalHistory
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

module.exports = new SignalProcessor();