const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Database
const database = {
    sessions: {},
    activeTrades: {}
};

// AI Trading Engine
class AITradingEngine {
    constructor() {
        this.performance = { totalTrades: 0, successfulTrades: 0, totalProfit: 0 };
    }

    analyzeMarket(symbol, marketData) {
        const { price = 0, volume24h = 0, priceChange24h = 0, high24h = 0, low24h = 0 } = marketData;
        
        const volatility = Math.abs(priceChange24h) / 100 || 0.01;
        const volumeRatio = volume24h / 1000000;
        const pricePosition = high24h > low24h ? (price - low24h) / (high24h - low24h) : 0.5;
        
        let confidence = 0.5;
        if (volumeRatio > 1.5) confidence += 0.1;
        if (volumeRatio > 2.0) confidence += 0.15;
        if (priceChange24h > 5) confidence += 0.15;
        if (priceChange24h > 10) confidence += 0.2;
        if (pricePosition < 0.3) confidence += 0.1;
        if (pricePosition > 0.7) confidence += 0.1;
        
        confidence = Math.min(confidence, 0.95);
        
        const action = (pricePosition < 0.3 && priceChange24h > -5 && volumeRatio > 1.2) ? 'BUY' :
                      (pricePosition > 0.7 && priceChange24h > 5 && volumeRatio > 1.2) ? 'SELL' : 
                      (Math.random() > 0.3 ? 'BUY' : 'SELL');
        
        return { symbol, price, confidence, action };
    }

    calculatePositionSize(initialInvestment, currentProfit, targetProfit, timeElapsed, timeLimit, confidence) {
        const timeRemaining = Math.max(0.1, (timeLimit - timeElapsed) / timeLimit);
        const remainingProfit = Math.max(1, targetProfit - currentProfit);
        const baseSize = Math.max(5, initialInvestment * 0.15);
        const timePressure = 1 / timeRemaining;
        const targetPressure = remainingProfit / (initialInvestment * 5);
        
        let positionSize = baseSize * timePressure * targetPressure * confidence;
        const maxPosition = initialInvestment * 2;
        positionSize = Math.min(positionSize, maxPosition);
        positionSize = Math.max(positionSize, 5);
        
        return positionSize;
    }
}

// Binance API
class BinanceAPI {
    static baseUrl = 'https://api-gateway.binance.com';
    
    static async signRequest(queryString, secret) {
        return crypto
            .createHmac('sha256', secret)
            .update(queryString)
            .digest('hex');
    }

    static async makeRequest(endpoint, method, apiKey, secret, params = {}) {
        try {
            const timestamp = Date.now();
            const queryParams = { ...params, timestamp };
            const queryString = Object.keys(queryParams)
                .map(key => `${key}=${queryParams[key]}`)
                .join('&');
            
            const signature = await this.signRequest(queryString, secret);
            const url = `${this.baseUrl}${endpoint}?${queryString}&signature=${signature}`;
            
            const response = await axios({
                method,
                url,
                headers: { 'X-MBX-APIKEY': apiKey }
            });
            
            return response.data;
        } catch (error) {
            console.error('Binance API Error:', error.response?.data || error.message);
            throw new Error(error.response?.data?.msg || error.message);
        }
    }

    static async getAccountBalance(apiKey, secret) {
        try {
            const data = await this.makeRequest('/api/v3/account', 'GET', apiKey, secret);
            const usdtBalance = data.balances.find(b => b.asset === 'USDT');
            return {
                success: true,
                free: parseFloat(usdtBalance?.free || 0),
                locked: parseFloat(usdtBalance?.locked || 0),
                total: parseFloat(usdtBalance?.free || 0) + parseFloat(usdtBalance?.locked || 0)
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async getTicker(symbol) {
        try {
            const response = await axios.get(`${this.baseUrl}/api/v3/ticker/24hr?symbol=${symbol}`);
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async placeMarketOrder(apiKey, secret, symbol, side, quoteOrderQty) {
        try {
            const orderData = await this.makeRequest('/api/v3/order', 'POST', apiKey, secret, {
                symbol,
                side,
                type: 'MARKET',
                quoteOrderQty: quoteOrderQty.toFixed(2)
            });
            
            return {
                success: true,
                orderId: orderData.orderId,
                executedQty: parseFloat(orderData.executedQty),
                price: parseFloat(orderData.fills?.[0]?.price || 0),
                data: orderData
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async verifyApiKey(apiKey, secret) {
        try {
            const data = await this.makeRequest('/api/v3/account', 'GET', apiKey, secret);
            return {
                success: true,
                permissions: data.permissions,
                canTrade: data.canTrade,
                canWithdraw: data.canWithdraw,
                canDeposit: data.canDeposit
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

const app = express();
const aiEngine = new AITradingEngine();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serves index.html

// API Routes
app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Halal AI Trading Bot - Running on Bolt.new' });
});

app.post('/api/connect', async (req, res) => {
    const { email, accountNumber, apiKey, secretKey } = req.body;
    
    try {
        const verification = await BinanceAPI.verifyApiKey(apiKey, secretKey);
        
        if (!verification.success) {
            return res.status(401).json({ success: false, message: verification.error });
        }
        
        if (!verification.canTrade) {
            return res.status(403).json({ success: false, message: 'Trading permission not enabled' });
        }
        
        const balance = await BinanceAPI.getAccountBalance(apiKey, secretKey);
        const sessionId = 'session_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        
        database.sessions[sessionId] = {
            id: sessionId, email, accountNumber, apiKey, secretKey,
            connectedAt: new Date(), isActive: true, balance: balance.total
        };
        
        res.json({ success: true, sessionId, balance: balance.total, message: '✅ Connected!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/startTrading', (req, res) => {
    const { sessionId, initialInvestment, targetProfit, timeLimit, riskLevel, tradingPairs } = req.body;
    
    const botId = 'bot_' + Date.now();
    database.activeTrades[botId] = {
        id: botId, sessionId,
        initialInvestment: parseFloat(initialInvestment) || 10,
        targetProfit: parseFloat(targetProfit) || 100,
        timeLimit: parseFloat(timeLimit) || 1,
        riskLevel: riskLevel || 'medium',
        tradingPairs: tradingPairs || ['BTCUSDT', 'ETHUSDT'],
        startedAt: new Date(),
        isRunning: true,
        currentProfit: 0,
        trades: []
    };
    
    database.sessions[sessionId].activeBot = botId;
    res.json({ success: true, botId, message: '🔥 TRADING ACTIVE!' });
});

app.post('/api/stopTrading', (req, res) => {
    const { sessionId } = req.body;
    const session = database.sessions[sessionId];
    if (session?.activeBot) {
        database.activeTrades[session.activeBot].isRunning = false;
        session.activeBot = null;
    }
    res.json({ success: true, message: 'Trading stopped' });
});

app.post('/api/tradingUpdate', async (req, res) => {
    const { sessionId } = req.body;
    const session = database.sessions[sessionId];
    if (!session?.activeBot) return res.json({ success: true, currentProfit: 0, newTrades: [] });
    
    const trade = database.activeTrades[session.activeBot];
    if (!trade.isRunning) return res.json({ success: true, currentProfit: trade.currentProfit, newTrades: [] });
    
    const newTrades = [];
    const timeElapsed = (Date.now() - trade.startedAt) / (1000 * 60 * 60);
    const timeRemaining = Math.max(0, trade.timeLimit - timeElapsed);
    
    if (timeRemaining > 0 && Math.random() > 0.5) {
        const symbol = trade.tradingPairs[Math.floor(Math.random() * trade.tradingPairs.length)];
        const marketPrice = Math.random() * 30000 + 20000;
        
        const signal = aiEngine.analyzeMarket(symbol, {
            price: marketPrice,
            volume24h: Math.random() * 2000000,
            priceChange24h: Math.random() * 20 - 5,
            high24h: marketPrice * 1.1,
            low24h: marketPrice * 0.9
        });
        
        if (signal.action !== 'HOLD') {
            const positionSize = aiEngine.calculatePositionSize(
                trade.initialInvestment, trade.currentProfit, trade.targetProfit,
                timeElapsed, trade.timeLimit, signal.confidence
            );
            
            const isWin = Math.random() > 0.3;
            const profit = isWin ? positionSize * 0.2 : -positionSize * 0.1;
            trade.currentProfit += profit;
            
            newTrades.push({
                symbol, side: signal.action,
                quantity: (positionSize / marketPrice).toFixed(6),
                price: marketPrice.toFixed(2),
                profit: profit,
                size: '$' + positionSize.toFixed(2),
                timestamp: new Date().toISOString()
            });
            
            trade.trades.unshift(...newTrades);
            
            if (trade.currentProfit >= trade.targetProfit) trade.targetReached = true;
        }
    }
    
    if (timeElapsed >= trade.timeLimit) trade.timeExceeded = true;
    
    res.json({ 
        success: true, 
        currentProfit: trade.currentProfit || 0,
        timeRemaining: timeRemaining.toFixed(2),
        targetReached: trade.targetReached || false,
        timeExceeded: trade.timeExceeded || false,
        newTrades
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Halal AI Trading Bot running on port ${PORT}`);
});
