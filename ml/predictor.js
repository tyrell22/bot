/**
 * Machine Learning model trainer
 * Trains and improves the ML model based on trade outcomes
 * Uses browser-based TensorFlow.js
 */
const tf = require('@tensorflow/tfjs');
const dataCollector = require('../data/collector');
const storage = require('../data/storage');
const config = require('../config');
const fs = require('fs-extra');
const path = require('path');

class MLTrainer {
  constructor() {
    this.model = null;
    this.initialized = false;
    this.featureNames = [
      'vwapDeviation', 'aboveVwap',
      'rsi', 'rsiOverbought', 'rsiOversold',
      'emaFastAboveMedium', 'emaFastAboveSlow', 'emaMediumAboveSlow',
      'macdAboveSignal', 'macdPositive',
      'orderbookImbalance', 'orderbookScore',
      'direction'
    ];
  }
  
  /**
   * Initialize the ML trainer
   */
  async init() {
    try {
      // Try to load existing model
      try {
        this.model = await this.loadModel();
        logger.info('Loaded existing ML model');
      } catch (error) {
        logger.info('No existing model found, creating new model');
        this.model = this.createModel();
      }
      
      this.initialized = true;
      logger.info('ML trainer initialized');
      
      return true;
    } catch (error) {
      logger.error(`Error initializing ML trainer: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Create a new model
   * @returns {tf.Sequential} - New TensorFlow model
   */
  createModel() {
    const model = tf.sequential();
    
    // Add layers
    model.add(tf.layers.dense({
      units: 16,
      activation: 'relu',
      inputShape: [this.featureNames.length]
    }));
    
    model.add(tf.layers.dense({
      units: 8,
      activation: 'relu'
    }));
    
    model.add(tf.layers.dense({
      units: 1,
      activation: 'sigmoid'
    }));
    
    // Compile model
    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });
    
    return model;
  }
  
  /**
   * Load model from storage
   * @returns {tf.Sequential} - Loaded model
   */
  async loadModel() {
    try {
      const tfUtils = require('./utils');
      
      // Load model using utility function
      const model = await tfUtils.loadModelFromDisk(config.storage.modelPath);
      
      // Recompile model
      model.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
      });
      
      return model;
    } catch (error) {
      logger.warn(`Error loading model: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Prepare data for training
   * @param {Array} dataset - Trade dataset
   * @returns {Object} - Tensors for training
   */
  prepareTrainingData(dataset) {
    // Extract features and targets
    const featureArrays = dataset.map(item => {
      return this.featureNames.map(name => item.features[name] || 0);
    });
    
    const targetArrays = dataset.map(item => item.target);
    
    // Convert to tensors
    const xsTensor = tf.tensor2d(featureArrays);
    const ysTensor = tf.tensor2d(targetArrays, [targetArrays.length, 1]);
    
    return {
      xs: xsTensor,
      ys: ysTensor,
      numExamples: featureArrays.length
    };
  }
  
  /**
   * Train the model with new data
   * @returns {Object} - Training results
   */
  async train() {
    if (!this.initialized) {
      throw new Error('ML trainer not initialized');
    }
    
    try {
      // Get dataset from data collector
      const dataset = dataCollector.prepareMLDataset();
      
      if (dataset.length < config.ml.minTradesForTraining) {
        logger.info(`Not enough trades for training (${dataset.length}/${config.ml.minTradesForTraining})`);
        return {
          trained: false,
          reason: 'Not enough trades',
          tradesCount: dataset.length,
          requiredCount: config.ml.minTradesForTraining
        };
      }
      
      // Prepare data
      const { xs, ys, numExamples } = this.prepareTrainingData(dataset);
      
      logger.info(`Training model with ${numExamples} examples`);
      
      // Train model
      const result = await this.model.fit(xs, ys, {
        epochs: config.ml.epochs,
        batchSize: 32,
        validationSplit: config.ml.validationSplit,
        shuffle: true,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            logger.debug(`Epoch ${epoch + 1}: loss = ${logs.loss.toFixed(4)}, accuracy = ${logs.acc.toFixed(4)}`);
          }
        }
      });
      
      // Save model
      await this.saveModel();
      
      // Clean up tensors
      xs.dispose();
      ys.dispose();
      
      const finalLoss = result.history.loss[result.history.loss.length - 1];
      const finalAcc = result.history.acc[result.history.acc.length - 1];
      
      logger.info(`Model training completed. Final loss: ${finalLoss.toFixed(4)}, accuracy: ${finalAcc.toFixed(4)}`);
      
      return {
        trained: true,
        loss: finalLoss,
        accuracy: finalAcc,
        epochs: config.ml.epochs,
        examplesCount: numExamples
      };
    } catch (error) {
      logger.error(`Error training model: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Save model to storage
   * @returns {boolean} - Whether the save was successful
   */
  async saveModel() {
    try {
      const tfUtils = require('./utils');
      
      // Save model using utility function
      await tfUtils.saveModelToDisk(this.model, config.storage.modelPath);
      
      logger.info(`Model saved to ${config.storage.modelPath}`);
      return true;
    } catch (error) {
      logger.error(`Error saving model: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Make predictions with the model
   * @param {Array} features - Input features
   * @returns {Object} - Prediction results
   */
  async predict(features) {
    if (!this.initialized || !this.model) {
      throw new Error('ML trainer not initialized or model not loaded');
    }
    
    try {
      // Preprocess features to match expected format
      const processedFeatures = this.featureNames.map(name => features[name] || 0);
      
      // Convert to tensor
      const inputTensor = tf.tensor2d([processedFeatures]);
      
      // Make prediction
      const predictionTensor = this.model.predict(inputTensor);
      const predictionValue = await predictionTensor.data();
      const confidence = predictionValue[0];
      
      // Clean up tensors
      inputTensor.dispose();
      predictionTensor.dispose();
      
      return {
        confidence,
        prediction: confidence > 0.5 ? 1 : 0,
        features: processedFeatures
      };
    } catch (error) {
      logger.error(`Error making prediction: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Evaluate the model on a test dataset
   * @param {Array} testDataset - Test dataset
   * @returns {Object} - Evaluation results
   */
  async evaluate(testDataset) {
    if (!this.initialized || !this.model) {
      throw new Error('ML trainer not initialized or model not loaded');
    }
    
    try {
      // Prepare test data
      const { xs, ys, numExamples } = this.prepareTrainingData(testDataset);
      
      // Evaluate model
      const evaluation = await this.model.evaluate(xs, ys);
      
      // Get metrics
      const loss = await evaluation[0].data();
      const accuracy = await evaluation[1].data();
      
      // Clean up tensors
      xs.dispose();
      ys.dispose();
      evaluation[0].dispose();
      evaluation[1].dispose();
      
      return {
        loss: loss[0],
        accuracy: accuracy[0],
        numExamples
      };
    } catch (error) {
      logger.error(`Error evaluating model: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new MLTrainer();