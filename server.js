const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
    // Secret key (must match frontend's secretInput)
    SECRET: process.env.TOPUP_SECRET || "secret",
    
    // BNB amount to send per top-up
    TOPUP_AMOUNT: process.env.TOPUP_AMOUNT || "0.0005",
    
    // Maximum top-ups per address per day
    MAX_TOPUPS_PER_DAY: parseInt(process.env.MAX_TOPUPS_PER_DAY) || 3,
    
    // BSC RPC URL
    RPC_URL: process.env.RPC_URL || "https://bsc-dataseed.binance.org/",
    
    // Data file
    DATA_FILE: path.join(__dirname, 'topup_data.json')
};

// ============ DATA STORAGE ============
let dataStore = {
    topups: [],
    addresses: {}
};

// Rate limiting tracker
let topupTracker = {
    daily: {} // address -> { count, lastReset }
};

// Load existing data
if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        dataStore = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        console.log('✅ Data loaded');
    } catch (err) {
        console.error('Error loading data:', err);
    }
}

function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(dataStore, null, 2));
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

// ============ TOP-UP ENDPOINT ============

/**
 * POST /topup
 * Headers: { "x-topup-secret": "7x143414" }
 * Body: { "to": "0x..." }
 * Response: { ok: true, txHash: string, amount: string }
 */
app.post('/topup', async (req, res) => {
    console.log('📨 POST /topup:', req.body);
    
    try {
        const { to } = req.body;
        const secret = req.headers['x-topup-secret'];
        
        // Validate secret
        if (!secret || secret !== CONFIG.SECRET) {
            console.log('❌ Invalid secret');
            return res.status(401).json({
                ok: false,
                error: 'Invalid or missing x-topup-secret'
            });
        }
        
        // Validate address
        if (!to || !ethers.isAddress(to)) {
            return res.status(400).json({
                ok: false,
                error: 'Invalid recipient address'
            });
        }
        
        // Check if funding wallet is configured
        if (!process.env.FUNDING_PRIVATE_KEY) {
            console.log('❌ FUNDING_PRIVATE_KEY not set');
            return res.status(500).json({
                ok: false,
                error: 'Top-up service not configured on server'
            });
        }
        
        const normalizedAddress = to.toLowerCase();
        
        // Rate limiting
        const today = new Date().toDateString();
        
        if (!topupTracker.daily[normalizedAddress] || 
            topupTracker.daily[normalizedAddress].lastReset !== today) {
            topupTracker.daily[normalizedAddress] = { count: 0, lastReset: today };
        }
        
        const currentCount = topupTracker.daily[normalizedAddress].count;
        
        if (currentCount >= CONFIG.MAX_TOPUPS_PER_DAY) {
            console.log(`❌ Daily limit reached for ${normalizedAddress}`);
            return res.status(429).json({
                ok: false,
                error: `Daily top-up limit reached (${CONFIG.MAX_TOPUPS_PER_DAY} max)`,
                remaining: 0,
                limit: CONFIG.MAX_TOPUPS_PER_DAY
            });
        }
        
        // Setup provider and funding wallet
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
        const fundingWallet = new ethers.Wallet(process.env.FUNDING_PRIVATE_KEY, provider);
        
        console.log(`💰 Funding wallet: ${fundingWallet.address}`);
        console.log(`🎯 Sending ${CONFIG.TOPUP_AMOUNT} BNB to ${normalizedAddress}`);
        
        // Check funding wallet balance
        const fundingBalance = await provider.getBalance(fundingWallet.address);
        const fundingBalanceBNB = parseFloat(ethers.formatEther(fundingBalance));
        const topupAmountWei = ethers.parseEther(CONFIG.TOPUP_AMOUNT);
        
        console.log(`   Funding wallet BNB balance: ${fundingBalanceBNB}`);
        
        if (fundingBalance < topupAmountWei) {
            console.log('❌ Insufficient BNB in funding wallet');
            return res.status(500).json({
                ok: false,
                error: 'Top-up service temporarily unavailable (insufficient funds)',
                status: 'low_balance'
            });
        }
        
        // Send BNB
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
        
        const tx = await fundingWallet.sendTransaction({
            to: normalizedAddress,
            value: topupAmountWei,
            gasLimit: 21000,
            gasPrice: gasPrice
        });
        
        console.log(`📤 Top-up tx sent: ${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        
        console.log(`✅ Top-up confirmed! Block: ${receipt.blockNumber}`);
        
        // Update tracker
        topupTracker.daily[normalizedAddress].count++;
        
        // Store in dataStore
        const topupRecord = {
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            to: normalizedAddress,
            amount: CONFIG.TOPUP_AMOUNT,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            timestamp: new Date().toISOString()
        };
        
        dataStore.topups.push(topupRecord);
        
        // Update address stats
        if (!dataStore.addresses[normalizedAddress]) {
            dataStore.addresses[normalizedAddress] = {
                totalTopups: 0,
                totalAmountBNB: 0,
                firstTopup: new Date().toISOString()
            };
        }
        
        dataStore.addresses[normalizedAddress].totalTopups++;
        dataStore.addresses[normalizedAddress].totalAmountBNB += parseFloat(CONFIG.TOPUP_AMOUNT);
        dataStore.addresses[normalizedAddress].lastTopup = new Date().toISOString();
        
        // Keep only last 1000 top-ups
        if (dataStore.topups.length > 1000) {
            dataStore.topups = dataStore.topups.slice(-1000);
        }
        
        saveData();
        
        res.json({
            ok: true,
            txHash: tx.hash,
            amount: CONFIG.TOPUP_AMOUNT,
            blockNumber: receipt.blockNumber,
            remaining: CONFIG.MAX_TOPUPS_PER_DAY - topupTracker.daily[normalizedAddress].count
        });
        
    } catch (error) {
        console.error('❌ Top-up error:', error.message);
        
        // Handle specific errors
        if (error.message.includes('insufficient funds')) {
            return res.status(500).json({
                ok: false,
                error: 'Funding wallet has insufficient BNB'
            });
        }
        
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// ============ INFO ENDPOINTS ============

/**
 * GET /topup/check/:address
 * Check remaining top-ups for an address
 */
app.get('/topup/check/:address', (req, res) => {
    const { address } = req.params;
    
    if (!ethers.isAddress(address)) {
        return res.status(400).json({
            ok: false,
            error: 'Invalid address'
        });
    }
    
    const normalized = address.toLowerCase();
    const today = new Date().toDateString();
    const tracker = topupTracker.daily[normalized];
    
    const used = (tracker && tracker.lastReset === today) ? tracker.count : 0;
    const remaining = Math.max(0, CONFIG.MAX_TOPUPS_PER_DAY - used);
    
    const addressStats = dataStore.addresses[normalized] || {
        totalTopups: 0,
        totalAmountBNB: 0
    };
    
    res.json({
        ok: true,
        address: normalized,
        usedToday: used,
        remainingToday: remaining,
        limit: CONFIG.MAX_TOPUPS_PER_DAY,
        totalTopups: addressStats.totalTopups,
        totalAmountBNB: addressStats.totalAmountBNB
    });
});

/**
 * GET /health
 * Service health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        config: {
            topupAmount: CONFIG.TOPUP_AMOUNT,
            maxPerDay: CONFIG.MAX_TOPUPS_PER_DAY,
            fundingConfigured: !!process.env.FUNDING_PRIVATE_KEY
        },
        stats: {
            totalTopups: dataStore.topups.length,
            uniqueAddresses: Object.keys(dataStore.addresses).length
        }
    });
});

/**
 * GET /stats
 * Detailed statistics
 */
app.get('/stats', (req, res) => {
    const today = new Date().toDateString();
    const todayTopups = dataStore.topups.filter(t => 
        t.timestamp.startsWith(today)
    );
    
    const totalBNBSent = dataStore.topups.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const todayBNBSent = todayTopups.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    
    res.json({
        ok: true,
        total: {
            topups: dataStore.topups.length,
            bnbSent: totalBNBSent.toFixed(6),
            uniqueAddresses: Object.keys(dataStore.addresses).length
        },
        today: {
            topups: todayTopups.length,
            bnbSent: todayBNBSent.toFixed(6)
        },
        config: {
            amountPerTopup: CONFIG.TOPUP_AMOUNT,
            maxPerAddressPerDay: CONFIG.MAX_TOPUPS_PER_DAY
        }
    });
});

/**
 * GET /
 * API information
 */
app.get('/', (req, res) => {
    res.json({
        service: 'BNB Top-Up API',
        version: '1.0.0',
        endpoint: 'POST /topup',
        requiredHeaders: {
            'Content-Type': 'application/json',
            'x-topup-secret': CONFIG.SECRET.substring(0, 3) + '...'
        },
        bodyFormat: {
            to: '0x... (recipient address)'
        },
        response: {
            ok: true,
            txHash: '0x...',
            amount: CONFIG.TOPUP_AMOUNT
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     🚀 BNB Top-Up API Service                     ║
╠══════════════════════════════════════════════════╣
║  Port: ${PORT}                                      ║
║  Top-up Amount: ${CONFIG.TOPUP_AMOUNT} BNB                 ║
║  Max per day: ${CONFIG.MAX_TOPUPS_PER_DAY}                                   ║
║                                                  ║
║  POST /topup           - Send BNB                ║
║  GET  /topup/check/:addr - Check remaining       ║
║  GET  /health          - Service status          ║
║  GET  /stats           - Statistics              ║
╚══════════════════════════════════════════════════╝
    `);
});
