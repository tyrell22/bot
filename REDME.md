# ByBit Scalping Bot

An automated trading bot for cryptocurrency scalping on the ByBit exchange with machine learning-powered strategy optimization.

## Features

- **Modular Architecture**: Well-organized code structure for easy maintenance and extensibility
- **Real-time Data**: WebSocket connections to ByBit for up-to-date market data
- **Advanced Technical Indicators**: Uses VWAP, RSI, EMA, MACD, and more
- **Order Book Analysis**: Analyzes market depth and order flow
- **Risk Management**: Position sizing, stop loss, and take profit management
- **Trailing Stop Strategy**: Secures profits as trades move favorably
- **Machine Learning**: Self-improving strategy using TensorFlow.js
- **Position Management**: Monitors and manages open positions
- **Data Persistence**: Saves trading history for analysis
- **Automated Symbol Selection**: Selects the best trading pairs by volume

## Architecture

The bot is structured into several modules:

- **API**: Handles communication with ByBit (REST and WebSockets)
- **Indicators**: Technical analysis tools
- **Strategy**: Trading strategy implementation
- **Trade**: Order execution and position management
- **Data**: Data collection and storage
- **ML**: Machine learning model training and prediction

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/bybit-scalping-bot.git
cd bybit-scalping-bot
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with your ByBit API keys:
```
BYBIT_API_KEY=your_api_key
BYBIT_API_SECRET=your_api_secret
```

4. Configure the bot in `config.js` according to your preferences.

## Usage

Start the bot:

```bash
npm start
```

## Configuration

The bot's behavior can be customized in the `config.js` file:

### API Configuration
- `api.baseUrl`: ByBit API base URL
- `api.wsBaseUrl`: ByBit WebSocket URL
- `api.testnet`: Whether to use testnet (true/false)

### Trading Parameters
- `trading.leverage`: Trading leverage (default: 10x)
- `trading.targetProfit`: Profit target percentage (default: 3%)
- `trading.stopLoss`: Stop loss percentage (default: 1.5%)
- `trading.trailingStopActivation`: When to activate trailing stop (default: 2%)
- `trading.maxTradesPerHour`: Maximum trades per hour (default: 15)
- `trading.maxOpenPositions`: Maximum open positions (default: 10)
- `trading.positionSizePercentage`: Position size as percentage of balance (default: 5%)
- `trading.inactivePositionMinutes`: Close positions not moving after this time (default: 20 minutes)

### Indicators Configuration
- `indicators.vwap.period`: VWAP period (default: 24 hours)
- `indicators.rsi.period`: RSI period (default: 14)
- `indicators.rsi.overbought`: RSI overbought threshold (default: 70)
- `indicators.rsi.oversold`: RSI oversold threshold (default: 30)
- `indicators.ema.fast`: Fast EMA period (default: 9)
- `indicators.ema.medium`: Medium EMA period (default: 21)
- `indicators.ema.slow`: Slow EMA period (default: 50)
- `indicators.macd.*`: MACD parameters

### Machine Learning
- `ml.trainingFrequency`: Hours between training (default: 4)
- `ml.minTradesForTraining`: Minimum trades needed for training (default: 100)
- `ml.predictThreshold`: Confidence threshold for trade execution (default: 0.65)

## Warning

This bot is for educational purposes. Trading cryptocurrency involves significant risk. Use at your own risk.

## License

MIT License