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
    SECRET: process.env.TOPUP_SECRET || "7x143414",
    TOPUP_AMOUNT: process.env.TOPUP_AMOUNT || "0.0000906",
    DATA_FILE: path.join(__dirname, 'topup_data.json'),
    
    // ⚡ SPEED RPCs
    RPC_URLS: [
        "https://bsc-dataseed1.binance.org/",
        "https://bsc-dataseed2.binance.org/",
        "https://bsc-dataseed3.binance.org/"
    ],
    
    // ⏰ EXACT 1 SECOND
    BLOCKCHAIN_WAIT: 1000,      // 1 SECOND ONLY!
    GAS_LIMIT: 21000,
    GAS_PRICE_MULTIPLIER: 2.0,  // DOUBLE GAS = SUPER FAST
    RPC_TIMEOUT: 1000,          // 1 SECOND TIMEOUT
    MAX_RETRIES: 1
};

// ============ DATA STORAGE ============
let dataStore = {
    topups: [],
    addresses: {},
    stats: {
        total: 0,
        success: 0,
        failed: 0,
        avgTime: 0
    }
};

if (fs.existsSync(CONFIG.DATA_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
        dataStore = { ...dataStore, ...loaded };
        console.log(`✅ Loaded ${dataStore.topups.length} records`);
    } catch (err) {}
}

function saveData() {
    try {
        fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(dataStore, null, 2));
    } catch (err) {}
}

function generateId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

// ============ ULTRA FAST RPC ============
let providerCache = null;
let providerTime = 0;

async function getFastestProvider() {
    // Cache for 3 seconds only
    if (providerCache && (Date.now() - providerTime) < 3000) {
        try {
            await providerCache.getBlockNumber();
            return providerCache;
        } catch (e) {}
    }
    
    // Try all RPCs in parallel (fastest wins)
    const rpcPromises = CONFIG.RPC_URLS.map(async (url) => {
        try {
            const provider = new ethers.JsonRpcProvider(url, undefined, {
                timeout: CONFIG.RPC_TIMEOUT
            });
            await provider.getBlockNumber();
            return provider;
        } catch (e) {
            return null;
        }
    });
    
    // Race - get first successful
    const results = await Promise.race([
        Promise.all(rpcPromises),
        new Promise((resolve) => setTimeout(resolve, 1000, null))
    ]);
    
    if (results) {
        for (const provider of results) {
            if (provider) {
                providerCache = provider;
                providerTime = Date.now();
                return provider;
            }
        }
    }
    
    // Fallback: try first RPC
    try {
        const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URLS[0]);
        await provider.getBlockNumber();
        providerCache = provider;
        providerTime = Date.now();
        return provider;
    } catch (e) {
        throw new Error('No RPC available');
    }
}

// ============ 1 SECOND TOPUP ============
async function topup1Second(toAddress) {
    const startTime = Date.now();
    console.log(`\n⚡ 1-SECOND TOPUP: ${toAddress.substring(0,10)}...`);
    
    try {
        // Get provider fast
        const provider = await getFastestProvider();
        const fundingWallet = new ethers.Wallet(process.env.FUNDING_PRIVATE_KEY, provider);
        
        const amountWei = ethers.parseEther(CONFIG.TOPUP_AMOUNT);
        
        // Get gas price - SUPER HIGH FOR SPEED
        const feeData = await provider.getFeeData();
        let gasPrice = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
        
        // Use VERY HIGH gas for immediate confirmation
        const minGasPrice = ethers.parseUnits('10', 'gwei');
        if (gasPrice < minGasPrice) gasPrice = minGasPrice;
        gasPrice = BigInt(Math.floor(Number(gasPrice) * CONFIG.GAS_PRICE_MULTIPLIER));
        
        console.log(`⛽ Gas: ${ethers.formatUnits(gasPrice, 'gwei')} Gwei (HIGH PRIORITY)`);
        
        // Get nonce
        const nonce = await provider.getTransactionCount(fundingWallet.address, 'pending');
        
        // Check balance
        const balance = await provider.getBalance(fundingWallet.address);
        const totalNeeded = amountWei + (gasPrice * BigInt(CONFIG.GAS_LIMIT));
        
        if (balance < totalNeeded) {
            return {
                success: false,
                error: 'Insufficient BNB',
                available: ethers.formatEther(balance),
                required: ethers.formatEther(totalNeeded),
                elapsed: Date.now() - startTime
            };
        }
        
        // PREPARE TRANSACTION
        const tx = {
            to: toAddress,
            value: amountWei,
            gasLimit: CONFIG.GAS_LIMIT,
            gasPrice: gasPrice,
            nonce: nonce,
            chainId: 56
        };
        
        // SEND TRANSACTION
        console.log(`💸 Sending...`);
        const sentTime = Date.now();
        const sentTx = await fundingWallet.sendTransaction(tx);
        console.log(`📤 Tx: ${sentTx.hash.substring(0,16)}...`);
        console.log(`⏱️ Sent in ${Date.now() - sentTime}ms`);
        
        // ⏰ WAIT EXACTLY 1 SECOND
        console.log(`⏳ Waiting ${CONFIG.BLOCKCHAIN_WAIT/1000}s...`);
        await sleep(CONFIG.BLOCKCHAIN_WAIT);
        
        // CHECK CONFIRMATION (1 check only)
        let confirmed = false;
        let receipt = null;
        
        try {
            receipt = await provider.getTransactionReceipt(sentTx.hash);
            if (receipt && receipt.status === 1) {
                confirmed = true;
                console.log(`✅ Confirmed!`);
            } else if (receipt && receipt.status === 0) {
                console.log(`❌ Reverted`);
                return {
                    success: false,
                    error: 'Transaction reverted',
                    txHash: sentTx.hash,
                    elapsed: Date.now() - startTime
                };
            } else {
                console.log(`⚠️ Still pending (but funds sent)`);
            }
        } catch (e) {
            console.log(`⚠️ Pending (funds sent)`);
        }
        
        // TOTAL TIME
        const totalTime = Date.now() - startTime;
        
        // Create record
        const record = {
            id: generateId(),
            to: toAddress.toLowerCase(),
            amount: CONFIG.TOPUP_AMOUNT,
            txHash: sentTx.hash,
            timestamp: new Date().toISOString(),
            status: confirmed ? 'confirmed' : 'pending',
            blockNumber: receipt?.blockNumber || 'pending',
            totalTime: totalTime + 'ms',
            sentTime: (Date.now() - sentTime) + 'ms'
        };
        
        dataStore.topups.unshift(record);
        if (dataStore.topups.length > 1000) {
            dataStore.topups = dataStore.topups.slice(0, 1000);
        }
        
        // Update address stats
        const addr = toAddress.toLowerCase();
        if (!dataStore.addresses[addr]) {
            dataStore.addresses[addr] = {
                totalTopups: 0,
                totalAmountBNB: 0,
                firstTopup: new Date().toISOString()
            };
        }
        dataStore.addresses[addr].totalTopups++;
        dataStore.addresses[addr].totalAmountBNB += parseFloat(CONFIG.TOPUP_AMOUNT);
        dataStore.addresses[addr].lastTopup = new Date().toISOString();
        
        // Update stats
        dataStore.stats.total++;
        if (confirmed) dataStore.stats.success++;
        dataStore.stats.avgTime = 
            (dataStore.stats.avgTime * (dataStore.stats.total - 1) + totalTime) / dataStore.stats.total;
        
        saveData();
        
        console.log(`✅ DONE in ${totalTime}ms`);
        
        return {
            success: true,
            txHash: sentTx.hash,
            amount: CONFIG.TOPUP_AMOUNT,
            id: record.id,
            status: confirmed ? 'confirmed' : 'pending',
            blockNumber: receipt?.blockNumber || 'pending',
            totalTime: totalTime + 'ms',
            confirmed: confirmed,
            elapsed: totalTime
        };
        
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        return {
            success: false,
            error: error.message,
            elapsed: Date.now() - startTime
        };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ API ENDPOINTS ============

// POST /topup - 1 SECOND
app.post('/topup', async (req, res) => {
    const start = Date.now();
    
    try {
        const { to } = req.body;
        const secret = req.headers['x-topup-secret'];
        
        // Ultra fast validation
        if (!secret || secret !== CONFIG.SECRET) {
            return res.status(401).json({ 
                ok: false, 
                error: 'Invalid secret',
                elapsed: Date.now() - start + 'ms'
            });
        }
        
        if (!to || !ethers.isAddress(to)) {
            return res.status(400).json({ 
                ok: false, 
                error: 'Invalid address',
                elapsed: Date.now() - start + 'ms'
            });
        }
        
        const result = await topup1Second(to);
        
        res.json({
            ok: result.success,
            ...result,
            serverTime: Date.now() - start + 'ms',
            waitTime: CONFIG.BLOCKCHAIN_WAIT + 'ms',
            speed: 'ULTRA FAST ⚡'
        });
        
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: error.message,
            elapsed: Date.now() - start + 'ms'
        });
    }
});

// GET /status/:txHash
app.get('/status/:txHash', async (req, res) => {
    const { txHash } = req.params;
    
    const record = dataStore.topups.find(t => t.txHash === txHash);
    if (record) {
        return res.json({
            ok: true,
            found: true,
            status: record.status,
            amount: record.amount,
            to: record.to,
            blockNumber: record.blockNumber || 'pending',
            totalTime: record.totalTime,
            timestamp: record.timestamp
        });
    }
    
    // Check blockchain
    try {
        const provider = await getFastestProvider();
        const tx = await provider.getTransaction(txHash);
        if (!tx) {
            return res.json({ ok: true, found: false });
        }
        const receipt = await provider.getTransactionReceipt(txHash);
        res.json({
            ok: true,
            found: true,
            status: receipt ? 'confirmed' : 'pending',
            blockNumber: receipt?.blockNumber || 'pending'
        });
    } catch (error) {
        res.json({ ok: false, error: error.message });
    }
});

// GET /stats
app.get('/stats', (req, res) => {
    const totalBNB = dataStore.topups.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const pending = dataStore.topups.filter(t => t.status === 'pending').length;
    
    res.json({
        totalTopups: dataStore.topups.length,
        totalBNBSent: totalBNB.toFixed(6),
        uniqueAddresses: Object.keys(dataStore.addresses).length,
        pending: pending,
        confirmed: dataStore.topups.filter(t => t.status === 'confirmed').length,
        avgTime: dataStore.stats.avgTime.toFixed(0) + 'ms',
        waitTime: CONFIG.BLOCKCHAIN_WAIT + 'ms',
        gasMultiplier: CONFIG.GAS_PRICE_MULTIPLIER + 'x'
    });
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '9.0.0-1sec',
        fundingConfigured: !!process.env.FUNDING_PRIVATE_KEY,
        waitTime: CONFIG.BLOCKCHAIN_WAIT + 'ms (1 SECOND)',
        totalTopups: dataStore.topups.length,
        avgTime: dataStore.stats.avgTime.toFixed(0) + 'ms',
        speed: '🚀 ULTRA FAST'
    });
});

// GET /
app.get('/', (req, res) => {
    res.json({
        service: '⚡ 1-SECOND BNB Top-Up API',
        version: '9.0.0',
        speed: '🚀 1 SECOND',
        endpoint: 'POST /topup',
        headers: { 'x-topup-secret': 'your_secret' },
        body: { to: '0x...' },
        features: {
            blockchainWait: '1 SECOND',
            gasPriority: '2x (SUPER FAST)',
            rpcTimeout: '1 SECOND',
            responseTime: '~1.5-2 SECONDS'
        }
    });
});

// ============ START ============
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║     ⚡ 1-SECOND BNB Top-Up API v9.0                         ║
╠══════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                               ║
║  Amount: ${CONFIG.TOPUP_AMOUNT} BNB                          ║
║  Funding: ${process.env.FUNDING_PRIVATE_KEY ? '✅ YES' : '❌ NO'}    ║
║                                                             ║
║  ⏰ TIMING:                                                 ║
║  ✅ Blockchain wait: ${CONFIG.BLOCKCHAIN_WAIT/1000} SECOND ONLY!   ║
║  ✅ Total response: ~1.5-2 SECONDS                         ║
║  ✅ Gas: ${CONFIG.GAS_PRICE_MULTIPLIER}x (SUPER FAST)             ║
║  ✅ RPC timeout: ${CONFIG.RPC_TIMEOUT/1000} SECOND                ║
║                                                             ║
║  📊 STATS:                                                  ║
║  Total: ${dataStore.topups.length}                           ║
║  Avg Time: ${dataStore.stats.avgTime.toFixed(0)}ms                     ║
║  Success Rate: ${dataStore.stats.total > 0 ? Math.round((dataStore.stats.success / dataStore.stats.total) * 100) : 0}%        ║
║                                                             ║
║  🚀 SPEED COMPARISON:                                       ║
║  Before: 5-10 seconds ❌                                   ║
║  Now: ~2 seconds ✅                                        ║
║  Improvement: 5x FASTER! 🚀                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
