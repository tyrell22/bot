/**
 * TensorFlow utilities for browser-compatible model persistence
 */
const tf = require('@tensorflow/tfjs');
const fs = require('fs-extra');
const path = require('path');

class TensorFlowUtils {
  /**
   * Load model from disk
   * @param {string} modelDir - Directory containing model files
   * @returns {tf.Sequential} - Loaded model
   */
  static async loadModelFromDisk(modelDir) {
    try {
      // Check if model files exist
      const modelPath = path.join(modelDir, 'model.json');
      const weightsPath = path.join(modelDir, 'weights.json');
      
      if (!fs.existsSync(modelPath) || !fs.existsSync(weightsPath)) {
        throw new Error('Model or weights file not found');
      }
      
      // Load model topology
      const modelJSON = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
      
      // Create model from topology
      const model = await tf.models.modelFromJSON(modelJSON);
      
      // Load weights
      const weightsData = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
      
      // Create tensors from weight data
      const weights = [];
      for (const weightData of weightsData) {
        const tensor = tf.tensor(weightData.values, weightData.shape);
        weights.push(tensor);
      }
      
      // Set model weights
      model.setWeights(weights);
      
      return model;
    } catch (error) {
      throw new Error(`Error loading model: ${error.message}`);
    }
  }
  
  /**
   * Save model to disk
   * @param {tf.Sequential} model - The model to save
   * @param {string} modelDir - Directory to save model files
   * @returns {boolean} - Whether the save was successful
   */
  static async saveModelToDisk(model, modelDir) {
    try {
      // Ensure directory exists
      await fs.ensureDir(modelDir);
      
      // Get model topology
      const modelJSON = model.toJSON();
      
      // Save model topology
      const modelPath = path.join(modelDir, 'model.json');
      await fs.writeJson(modelPath, modelJSON, { spaces: 2 });
      
      // Save weights
      const weights = model.getWeights();
      const weightData = [];
      
      for (let i = 0; i < weights.length; i++) {
        const values = await weights[i].data();
        weightData.push({
          name: `weight_${i}`,
          shape: weights[i].shape,
          values: Array.from(values)
        });
      }
      
      const weightsPath = path.join(modelDir, 'weights.json');
      await fs.writeJson(weightsPath, weightData, { spaces: 2 });
      
      return true;
    } catch (error) {
      throw new Error(`Error saving model: ${error.message}`);
    }
  }
  
  /**
   * Clean up tensors to prevent memory leaks
   * @param {Array} tensors - Array of tensors to dispose
   */
  static disposeTensors(tensors) {
    for (const tensor of tensors) {
      if (tensor && tensor.dispose) {
        tensor.dispose();
      }
    }
  }
}

module.exports = TensorFlowUtils;