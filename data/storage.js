/**
 * Storage module for persisting trading data
 * Handles saving and loading data to disk
 */
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');

class Storage {
  constructor() {
    this.initialized = false;
    this.dataDir = path.dirname(config.storage.tradesFile);
    this.dataFiles = {
      trades: config.storage.tradesFile,
      signals: path.join(this.dataDir, 'signals.json'),
      stats: path.join(this.dataDir, 'stats.json'),
      ml: path.join(this.dataDir, 'ml_data.json')
    };
    this.backupDir = path.join(this.dataDir, 'backups');
  }
  
  /**
   * Initialize the storage system
   */
  async init() {
    if (this.initialized) {
      return true;
    }
    
    try {
      // Ensure data directory exists
      await fs.ensureDir(this.dataDir);
      
      // Ensure backup directory exists
      await fs.ensureDir(this.backupDir);
      
      // Create empty data files if they don't exist
      for (const [key, filePath] of Object.entries(this.dataFiles)) {
        if (!await fs.pathExists(filePath)) {
          await fs.writeJson(filePath, []);
          logger.info(`Created empty data file: ${filePath}`);
        }
      }
      
      this.initialized = true;
      logger.info('Storage system initialized');
      
      return true;
    } catch (error) {
      logger.error(`Storage initialization error: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Save data to a specific file
   * @param {string} dataType - Type of data to save (trades, signals, etc.)
   * @param {Object|Array} data - The data to save
   * @returns {boolean} - Whether the save was successful
   */
  saveData(dataType, data) {
    if (!this.initialized) {
      logger.warn('Attempted to save data before storage initialization');
      return false;
    }
    
    const filePath = this.dataFiles[dataType];
    
    if (!filePath) {
      logger.error(`Unknown data type: ${dataType}`);
      return false;
    }
    
    try {
      fs.writeJsonSync(filePath, data);
      return true;
    } catch (error) {
      logger.error(`Error saving ${dataType} data: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Load data from a specific file
   * @param {string} dataType - Type of data to load (trades, signals, etc.)
   * @returns {Object|Array|null} - The loaded data or null if there was an error
   */
  loadData(dataType) {
    if (!this.initialized) {
      logger.warn('Attempted to load data before storage initialization');
      return null;
    }
    
    const filePath = this.dataFiles[dataType];
    
    if (!filePath) {
      logger.error(`Unknown data type: ${dataType}`);
      return null;
    }
    
    try {
      if (!fs.pathExistsSync(filePath)) {
        logger.warn(`Data file not found: ${filePath}`);
        return null;
      }
      
      return fs.readJsonSync(filePath);
    } catch (error) {
      logger.error(`Error loading ${dataType} data: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Create a backup of all data files
   * @returns {boolean} - Whether the backup was successful
   */
  async backup() {
    if (!this.initialized) {
      logger.warn('Attempted to create backup before storage initialization');
      return false;
    }
    
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFolder = path.join(this.backupDir, `backup-${timestamp}`);
      
      // Create backup folder
      await fs.ensureDir(backupFolder);
      
      // Copy all data files
      for (const [key, filePath] of Object.entries(this.dataFiles)) {
        if (await fs.pathExists(filePath)) {
          const fileName = path.basename(filePath);
          const backupFilePath = path.join(backupFolder, fileName);
          
          await fs.copy(filePath, backupFilePath);
          logger.debug(`Backed up ${key} data to ${backupFilePath}`);
        }
      }
      
      // Clean up old backups (keep only the last 10)
      const backups = await fs.readdir(this.backupDir);
      const backupFolders = backups
        .filter(folder => folder.startsWith('backup-'))
        .sort()
        .reverse();
      
      if (backupFolders.length > 10) {
        for (let i = 10; i < backupFolders.length; i++) {
          const oldBackupPath = path.join(this.backupDir, backupFolders[i]);
          await fs.remove(oldBackupPath);
          logger.debug(`Removed old backup: ${oldBackupPath}`);
        }
      }
      
      logger.info(`Created backup at ${backupFolder}`);
      return true;
    } catch (error) {
      logger.error(`Backup error: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Save an ML model to disk
   * @param {Object} model - The model to save
   * @param {string} modelName - Name of the model
   * @returns {boolean} - Whether the save was successful
   */
  async saveModel(model, modelName) {
    if (!this.initialized) {
      logger.warn('Attempted to save model before storage initialization');
      return false;
    }
    
    try {
      const modelDir = config.storage.modelPath;
      await fs.ensureDir(modelDir);
      
      const modelPath = path.join(modelDir, `${modelName}`);
      await model.save(`file://${modelPath}`);
      
      logger.info(`Saved model to ${modelPath}`);
      return true;
    } catch (error) {
      logger.error(`Error saving model: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Get statistics about the trading system
   * @returns {Object} - Trading statistics
   */
  getTradeStats() {
    try {
      const trades = this.loadData('trades') || [];
      
      if (trades.length === 0) {
        return {
          totalTrades: 0,
          winRate: 0,
          averagePnl: 0,
          totalPnl: 0
        };
      }
      
      // Calculate statistics
      const closedTrades = trades.filter(trade => trade.status === 'CLOSED');
      const winningTrades = closedTrades.filter(trade => trade.pnl > 0);
      
      const totalTrades = closedTrades.length;
      const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
      
      let totalPnl = 0;
      closedTrades.forEach(trade => {
        totalPnl += trade.pnl || 0;
      });
      
      const averagePnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
      
      const stats = {
        totalTrades,
        openTrades: trades.filter(trade => trade.status === 'OPEN').length,
        winningTrades: winningTrades.length,
        losingTrades: closedTrades.length - winningTrades.length,
        winRate,
        averagePnl,
        totalPnl,
        lastUpdated: Date.now()
      };
      
      // Save stats
      this.saveData('stats', stats);
      
      return stats;
    } catch (error) {
      logger.error(`Error calculating trade stats: ${error.message}`);
      return null;
    }
  }
}

module.exports = new Storage();