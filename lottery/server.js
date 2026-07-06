require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Connection, PublicKey } = require('@solana/web3.js');
const db = require('./database');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const MITK_MINT = process.env.MITK_MINT_ADDRESS;

let connection;
if (process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY !== 'your_helius_api_key_here') {
    connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
} else {
    connection = new Connection('https://api.mainnet-beta.solana.com');
}

// Helper function to get token balance
async function getTokenBalance(walletAddress) {
    try {
        const walletPublicKey = new PublicKey(walletAddress);
        const mintPublicKey = new PublicKey(MITK_MINT);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
            mint: mintPublicKey
        });

        if (tokenAccounts.value.length > 0) {
            return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
        }
        return 0;
    } catch (error) {
        console.error('Error fetching token balance:', error);
        return 0;
    }
}

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// --- Endpoints ---

// Register / Login
app.post('/api/auth', async (req, res) => {
    const { walletAddress, pin } = req.body;

    if (!walletAddress || !pin || pin.length !== 6) {
        return res.status(400).json({ error: 'Wallet address and 6-digit PIN are required.' });
    }

    try {
        // Validate if it is a correct Solana Public Key
        new PublicKey(walletAddress);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid Solana Wallet Address.' });
    }

    db.get('SELECT * FROM users WHERE wallet_address = ?', [walletAddress], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (user) {
            // Login
            const match = await bcrypt.compare(pin, user.pin_hash);
            if (match) {
                const token = jwt.sign({ walletAddress }, JWT_SECRET, { expiresIn: '24h' });
                return res.json({ message: 'Login successful', token });
            } else {
                return res.status(401).json({ error: 'Invalid PIN' });
            }
        } else {
            // Register
            const hash = await bcrypt.hash(pin, 10);

            // Get current balance at time of registration
            const previousBalance = await getTokenBalance(walletAddress);

            db.run('INSERT INTO users (wallet_address, pin_hash, previous_balance) VALUES (?, ?, ?)',
                [walletAddress, hash, previousBalance],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Error creating user' });
                    }
                    const token = jwt.sign({ walletAddress }, JWT_SECRET, { expiresIn: '24h' });
                    return res.status(201).json({ message: 'Registration successful', token });
                }
            );
        }
    });
});

// Profile
app.get('/api/profile', authenticateToken, (req, res) => {
    const walletAddress = req.user.walletAddress;

    db.get('SELECT previous_balance, current_remainder, total_accumulated FROM users WHERE wallet_address = ?', [walletAddress], (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'User not found' });

        db.all('SELECT ticket_number FROM tickets WHERE wallet_address = ?', [walletAddress], (err, tickets) => {
            if (err) return res.status(500).json({ error: 'Error fetching tickets' });

            res.json({
                walletAddress,
                previousBalance: user.previous_balance,
                currentRemainder: user.current_remainder,
                totalAccumulated: user.total_accumulated,
                tickets: tickets.map(t => t.ticket_number),
                totalTickets: tickets.length
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Active TXIDs set to prevent race conditions from concurrent requests
const activeProcessingTxids = new Set();

// Submit TXID
app.post('/api/submit-tx', authenticateToken, async (req, res) => {
    const { txid } = req.body;
    const walletAddress = req.user.walletAddress;

    if (!txid) {
        return res.status(400).json({ error: 'TXID is required' });
    }

    if (activeProcessingTxids.has(txid)) {
         return res.status(409).json({ error: 'Transaction is already being processed.' });
    }
    activeProcessingTxids.add(txid);

    try {
        // 1. Check if TXID already exists in DB
        const existingTx = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM transactions WHERE txid = ?', [txid], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (existingTx) {
            activeProcessingTxids.delete(txid);
            return res.status(400).json({ error: 'TXID already used.' });
        }

        // 2. Fetch transaction from Solana
        let txDetails;
        try {
            txDetails = await connection.getParsedTransaction(txid, { maxSupportedTransactionVersion: 0 });
        } catch (error) {
             activeProcessingTxids.delete(txid);
             return res.status(400).json({ error: 'Error fetching transaction from blockchain.' });
        }

        if (!txDetails || !txDetails.meta) {
             activeProcessingTxids.delete(txid);
             return res.status(400).json({ error: 'Transaction not found or unconfirmed.' });
        }

        if (txDetails.meta.err) {
             activeProcessingTxids.delete(txid);
             return res.status(400).json({ error: 'Transaction failed on blockchain.' });
        }

        // 3. Validate transaction details
        // Find MITK token transfers to the logged-in wallet
        const preTokenBalances = txDetails.meta.preTokenBalances || [];
        const postTokenBalances = txDetails.meta.postTokenBalances || [];

        let mitkAmountReceived = 0;

        // Calculate net token change for the specific wallet and mint
        const preBalance = preTokenBalances.find(b => b.mint === MITK_MINT && b.owner === walletAddress);
        const postBalance = postTokenBalances.find(b => b.mint === MITK_MINT && b.owner === walletAddress);

        const preAmount = preBalance ? parseFloat(preBalance.uiTokenAmount.uiAmountString) : 0;
        const postAmount = postBalance ? parseFloat(postBalance.uiTokenAmount.uiAmountString) : 0;

        mitkAmountReceived = postAmount - preAmount;

        if (mitkAmountReceived <= 0) {
            activeProcessingTxids.delete(txid);
            return res.status(400).json({ error: 'No MITK tokens received in this transaction by your wallet.' });
        }

        // Simplistic check for DEX involvement (optional, but requested to avoid P2P)
        // We check if known DEX programs (like Raydium/Jupiter) are in the instruction program IDs.
        // For simplicity in this demo, we'll assume any transaction that increases balance is a "purchase"
        // if it involves multiple instructions typical of a swap, or we can check logs.
        // A robust check would verify the source is a liquidity pool.

        const logMessages = txDetails.meta.logMessages || [];
        const isDexSwap = logMessages.some(log =>
            log.includes('Program JUP') ||
            log.includes('Program route') ||
            log.includes('Program srmq') ||
            log.includes('Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') // Raydium
        );

        if (!isDexSwap) {
             // For strict enforcement:
             // activeProcessingTxids.delete(txid);
             // return res.status(400).json({ error: 'Transaction must be a purchase via DEX, not a P2P transfer.' });
             // Relaxed for now, but we check if it is a swap. Let's enforce it:

             activeProcessingTxids.delete(txid);
             return res.status(400).json({ error: 'Transaction must be a DEX swap, direct transfers are not allowed.' });
        }

        // 4. Calculate tickets
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT current_remainder FROM users WHERE wallet_address = ?', [walletAddress], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        const totalTokensAvailable = user.current_remainder + mitkAmountReceived;
        const TICKETS_PER_UNIT = 200000;
        const ticketsToAward = Math.floor(totalTokensAvailable / TICKETS_PER_UNIT);
        const newRemainder = totalTokensAvailable % TICKETS_PER_UNIT;

        // 5. Database Transaction to save everything
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            db.run('INSERT INTO transactions (txid, wallet_address, amount, tickets_awarded) VALUES (?, ?, ?, ?)',
                [txid, walletAddress, mitkAmountReceived, ticketsToAward],
                (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        activeProcessingTxids.delete(txid);
                        return res.status(500).json({ error: 'Error saving transaction.' });
                    }
                }
            );

            db.run('UPDATE users SET current_remainder = ?, total_accumulated = total_accumulated + ? WHERE wallet_address = ?', [newRemainder, mitkAmountReceived, walletAddress], (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    activeProcessingTxids.delete(txid);
                    return res.status(500).json({ error: 'Error updating user balance.' });
                }
            });

            if (ticketsToAward > 0) {
                 // Fetch all assigned tickets to find available ones
                 db.all('SELECT ticket_number FROM tickets', [], (err, rows) => {
                     if (err) {
                         db.run('ROLLBACK');
                         activeProcessingTxids.delete(txid);
                         return res.status(500).json({ error: 'Error generating tickets.' });
                     }

                     const assignedTickets = new Set(rows.map(r => r.ticket_number));
                     let awarded = [];

                     if (assignedTickets.size >= 1000) {
                          db.run('ROLLBACK');
                          activeProcessingTxids.delete(txid);
                          return res.status(400).json({ error: 'All 1000 tickets have been distributed. Promotion has ended.' });
                     }

                     for (let i = 0; i < ticketsToAward; i++) {
                         if (assignedTickets.size >= 1000) break; // Reached limit

                         let randomTicket;
                         do {
                             randomTicket = Math.floor(Math.random() * 1000) + 1;
                         } while (assignedTickets.has(randomTicket));

                         assignedTickets.add(randomTicket);
                         awarded.push(randomTicket);
                     }

                     if (awarded.length > 0) {
                         const stmt = db.prepare('INSERT INTO tickets (ticket_number, wallet_address, txid) VALUES (?, ?, ?)');
                         awarded.forEach(t => stmt.run(t, walletAddress, txid));
                         stmt.finalize();
                     }

                     db.run('COMMIT', () => {
                         activeProcessingTxids.delete(txid);
                         return res.json({
                             message: 'Transaction processed successfully!',
                             amountAdded: mitkAmountReceived,
                             ticketsAwarded: awarded.length,
                             awardedNumbers: awarded,
                             newRemainder: newRemainder
                         });
                     });
                 });
            } else {
                 db.run('COMMIT', () => {
                     activeProcessingTxids.delete(txid);
                     return res.json({
                         message: 'Transaction processed successfully!',
                         amountAdded: mitkAmountReceived,
                         ticketsAwarded: 0,
                         awardedNumbers: [],
                         newRemainder: newRemainder
                     });
                 });
            }
        });

    } catch (err) {
        console.error(err);
        activeProcessingTxids.delete(txid);
        res.status(500).json({ error: 'Internal server error processing transaction.' });
    }
});


// Admin API
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Invalid admin credentials' });
    }
});

function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err || user.role !== 'admin') return res.sendStatus(403);
        req.user = user;
        next();
    });
}

app.get('/api/admin/stats', authenticateAdmin, (req, res) => {
    db.all('SELECT * FROM transactions', (err, txs) => {
        if (err) return res.status(500).json({ error: 'DB Error' });
        db.all('SELECT * FROM tickets', (err, tickets) => {
            if (err) return res.status(500).json({ error: 'DB Error' });
            db.all('SELECT * FROM users', (err, users) => {
                if (err) return res.status(500).json({ error: 'DB Error' });
                res.json({ transactions: txs, tickets: tickets, users: users });
            });
        });
    });
});
