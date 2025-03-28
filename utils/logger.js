/**
 * Centralized logging module
 * Provides consistent logging across all components
 */
const winston = require('winston');
const fs = require('fs-extra');
const path = require('path');

let logger;

/**
 * Initialize the logger with configuration
 * @param {Object} config - Logging configuration
 * @returns {Object} - Configured logger
 */
function initializeLogger(config) {
  // Ensure config has defaults
  const loggingConfig = config?.logging || {
    level: 'info',
    console: true,
    file: false,
    filePath: './logs/'
  };

  // Create logger with specified format
  logger = winston.createLogger({
    level: loggingConfig.level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ level, message, timestamp }) => {
        return `${timestamp} ${level}: ${message}`;
      })
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
        silent: !loggingConfig.console
      })
    ]
  });

  // Add file transport if enabled
  if (loggingConfig.file) {
    // Ensure log directory exists
    fs.ensureDirSync(loggingConfig.filePath);
    
    logger.add(new winston.transports.File({
      filename: path.join(loggingConfig.filePath, `bot-${new Date().toISOString().split('T')[0]}.log`)
    }));
  }

  // Return the configured logger
  return logger;
}

/**
 * Get the logger instance
 * If not initialized, creates a default logger
 * @returns {Object} - Logger instance
 */
function getLogger() {
  if (!logger) {
    // Create default logger if not initialized
    logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });
    
    logger.warn('Using default logger configuration - call initializeLogger for custom configuration');
  }
  
  return logger;
}

module.exports = {
  initializeLogger,
  getLogger
};