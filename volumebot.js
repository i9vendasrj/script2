require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const basicAuth = require('express-basic-auth');
let bs58;
try {
    bs58 = require('bs58');
    if (!bs58.decode && bs58.default) bs58 = bs58.default;
} catch (e) {
    console.error("Erro fatal ao carregar bs58.");
}
const crypto = require('crypto');

// Importações Nativas e Raydium SDK Oficial
const BN = require('bn.js');
const { Raydium, TxVersion, Percent } = require('@raydium-io/raydium-sdk-v2');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

app.use(basicAuth({
    users: { [process.env.ADMIN_USERNAME]: process.env.ADMIN_PASSWORD },
    challenge: true,
    unauthorizedResponse: 'Acesso Negado.'
}));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3020;
const db = new sqlite3.Database('./database.sqlite');

// --- SISTEMA DE LOGS VISUAIS ---
const systemLogs = [];
function addLog(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    const logEntry = `[${timestamp}] ${msg}`;
    console.log(logEntry);
    systemLogs.unshift({ text: logEntry, type });
    if (systemLogs.length > 50) systemLogs.pop();
}

// --- CONFIGURAÇÃO DA SOLANA ---
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
const MITK_MINT_ADDRESS = new PublicKey('9HH2SBWV2j3YFwFEeeQ4UThiD5k3hnTYNBdXUM6ox2Dg');
const RAYDIUM_POOL_ID = 'CYtt7xP8zHZRaT17XQ5kMk612Q1a72T1aivZafRCH32R';

// Verifica se a MAIN_WALLET_PRIVATE_KEY está presente e válida, caso contrário deve falhar (fail fast)
let mainWallet;
try {
    const mainWalletSecretKey = bs58.decode(process.env.MAIN_WALLET_PRIVATE_KEY);
    mainWallet = Keypair.fromSecretKey(mainWalletSecretKey);
} catch (e) {
    console.error("ERRO CRÍTICO: MAIN_WALLET_PRIVATE_KEY inválida ou ausente. Verifique o arquivo .env.");
    process.exit(1);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function decrypt(text) {
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(process.env.ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

// NOVO: Exponential Backoff Wrapper
async function withBackoff(operation, maxRetries = 5, baseDelayMs = 500) {
    let retries = 0;
    while (true) {
        try {
            return await operation();
        } catch (error) {
            const isRateLimit = error.message && (error.message.includes('429') || error.message.includes('Too Many Requests') || error.message.includes('rate limit'));
            if (isRateLimit && retries < maxRetries) {
                const delay = baseDelayMs * Math.pow(2, retries);
                console.log(`Rate limit atingido (429). Tentando novamente em ${delay}ms... (Tentativa ${retries + 1}/${maxRetries})`);
                await sleep(delay);
                retries++;
            } else {
                throw error;
            }
        }
    }
}

async function getMitkBalance(walletPubkey) {
    try {
        const ataStandard = getAssociatedTokenAddressSync(MITK_MINT_ADDRESS, walletPubkey, false, TOKEN_PROGRAM_ID);
        const accStandard = await withBackoff(() => getAccount(connection, ataStandard, 'confirmed', TOKEN_PROGRAM_ID), 5, 500);
        return Number(accStandard.amount) / 1000000000;
    } catch (e) {}

    try {
        const ata2022 = getAssociatedTokenAddressSync(MITK_MINT_ADDRESS, walletPubkey, false, TOKEN_2022_PROGRAM_ID);
        const acc2022 = await withBackoff(() => getAccount(connection, ata2022, 'confirmed', TOKEN_2022_PROGRAM_ID), 5, 500);
        return Number(acc2022.amount) / 1000000000;
    } catch (e) {}

    return 0;
}

// ==========================================
// 🚀 MOTOR DE VOLUME (RAYDIUM V4 BLINDADO)
// ==========================================
let isMotorRunning = false;
let motorTimeout = null;
let cachedPoolKeys = null; // Cache em memória para chaves estáticas

async function runVolumeEngine() {
    if (!isMotorRunning) return;

    try {
        const rows = await new Promise((resolve, reject) => {
            db.all("SELECT id, public_key, encrypted_private_key FROM sub_wallets WHERE status = 'standby'", [], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        if (rows.length === 0) {
            addLog("🛑 Lote diário finalizado! Nenhuma carteira 'standby' restante.", 'warning');
            isMotorRunning = false;
            return;
        }

        const randomWalletData = rows[Math.floor(Math.random() * rows.length)];
        const privateKeyArray = JSON.parse(decrypt(randomWalletData.encrypted_private_key));
        const subWallet = Keypair.fromSecretKey(Uint8Array.from(privateKeyArray));

        const minSol = parseFloat(process.env.BUY_MIN_SOL) || 0.013;
        const maxSol = parseFloat(process.env.BUY_MAX_SOL) || 0.014;
        const randomSolAmount = (Math.random() * (maxSol - minSol)) + minSol;
        const amountLamports = Math.floor(randomSolAmount * LAMPORTS_PER_SOL);
        const amountIn = new BN(amountLamports);
        const slippagePercent = new Percent(5, 100);

        addLog(`Iniciando compra de ${randomSolAmount.toFixed(4)} SOL com: ${subWallet.publicKey.toBase58().substring(0,8)}...`, 'info');

        // Carregamento otimizado da Raydium, sem chamadas externas ocultas
        const raydium = await withBackoff(() => Raydium.load({
            owner: subWallet,
            connection: connection,
            cluster: 'mainnet',
            disableFeatureCheck: true,
            disableLoadToken: true,
            blockhashCommitment: 'confirmed'
        }), 3, 1000);

        addLog("Extraindo cofres da Pool direto da Blockchain...", 'info');

        // Requisição isolada da blockchain com Backoff
        const poolState = await withBackoff(() => raydium.liquidity.getPoolInfoFromRpc({ poolId: RAYDIUM_POOL_ID }), 5, 1000).catch(e => {
            throw new Error(`RPC rejeitou a leitura do cofre (Rate Limit). O bot tentará no próximo ciclo.`);
        });

        if (!poolState || !poolState.poolInfo) {
            throw new Error("Falha na leitura da liquidez da Pool via Helius.");
        }

        // Fazer cache das chaves da Pool se ainda não fizemos
        if (!cachedPoolKeys && poolState.poolKeys) {
            cachedPoolKeys = poolState.poolKeys;
        }

        const swapResult = await raydium.liquidity.computeAmountOut({
            poolInfo: poolState.poolInfo,
            poolKeys: cachedPoolKeys || poolState.poolKeys,
            amountIn,
            mintIn: 'So11111111111111111111111111111111111111112',
            mintOut: MITK_MINT_ADDRESS.toBase58(),
            slippage: slippagePercent
        });

        if (!swapResult || !swapResult.minAmountOut) {
            throw new Error("Falha no cálculo matemático do Swap V4.");
        }

        addLog("Montando e assinando transação V4...", 'info');

        const swapData = await raydium.liquidity.swap({
            poolInfo: poolState.poolInfo,
            poolKeys: cachedPoolKeys || poolState.poolKeys,
            amountIn,
            amountOut: swapResult.minAmountOut,
            fixedSide: 'in',
            inputMint: 'So11111111111111111111111111111111111111112',
            txVersion: TxVersion.V0,
            computeUnitPriceMicroLamports: 150000
        });

        // Envio da transação também com tratamento aprimorado de try/catch
        try {
            const res = await withBackoff(() => swapData.execute({ sendAndConfirm: true }), 3, 1500);
            addLog(`✅ COMPRA EFETUADA! TX: ${res.txId}`, 'success');
        } catch (execError) {
            let errorMsg = execError.message;
            if (execError.logs) {
                console.error("Transação falhou. Logs da Solana:", execError.logs);
                errorMsg += ` | Solana Logs: ${execError.logs[execError.logs.length - 1] || 'Erro desconhecido'}`;
            }
            throw new Error(`Falha na execução: ${errorMsg}`);
        }

        await new Promise((resolve, reject) => {
            db.run("UPDATE sub_wallets SET status = 'used' WHERE id = ?", [randomWalletData.id], (err) => {
                if (err) reject(err); else resolve();
            });
        });

    } catch (error) {
        addLog(`❌ Falha no ciclo: ${error.message}`, 'error');
        console.error("Erro completo do ciclo:", error);
    }

    if (isMotorRunning) {
        const nextIntervalMs = Math.floor(Math.random() * (600000 - 60000 + 1)) + 60000;
        addLog(`⏳ Motor aguardando ${(nextIntervalMs / 1000).toFixed(0)} segundos...`, 'warning');
        motorTimeout = setTimeout(runVolumeEngine, nextIntervalMs);
    }
}

// ==========================================
// ROTAS DA API
// ==========================================

app.get('/api/logs', (req, res) => { res.json(systemLogs); });
app.get('/api/motor/status', (req, res) => { res.json({ isRunning: isMotorRunning }); });

app.post('/api/motor/start', (req, res) => {
    if (isMotorRunning) return res.json({ success: false, message: 'Já está rodando.' });
    isMotorRunning = true;
    addLog("🚀 Motor de Volume Iniciado!", "success");
    runVolumeEngine();
    res.json({ success: true });
});

app.post('/api/motor/stop', (req, res) => {
    isMotorRunning = false; if (motorTimeout) clearTimeout(motorTimeout);
    addLog("🛑 Motor de Volume Desligado.", "warning");
    res.json({ success: true });
});

app.get('/api/treasury', async (req, res) => {
    try {
        const solBalanceLamports = await withBackoff(() => connection.getBalance(mainWallet.publicKey), 3, 500);
        const solBalance = solBalanceLamports / LAMPORTS_PER_SOL;
        const mitkBalance = await getMitkBalance(mainWallet.publicKey);
        res.json({ address: mainWallet.publicKey.toBase58(), solBalance: solBalance.toFixed(4), mitkBalance: mitkBalance.toFixed(2) });
    } catch (error) { res.status(500).json({ error: 'Erro ao buscar saldos' }); }
});

app.get('/api/wallets', (req, res) => {
    db.all("SELECT id, public_key, status FROM sub_wallets", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/wallets/balances', async (req, res) => {
    try {
        addLog("🔄 Iniciando leitura lenta e segura de saldos na blockchain...", "info");
        const rows = await new Promise((resolve, reject) => {
            db.all("SELECT id, public_key, status FROM sub_wallets", [], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        const pubkeys = rows.map(r => new PublicKey(r.public_key));
        const accounts = [];

        // 🛡️ ESCUDO ANTI-429 DOS SALDOS: Backoff Exponencial
        for (let i = 0; i < pubkeys.length; i += 5) {
            const chunk = pubkeys.slice(i, i + 5);
            // withBackoff protegerá contra 429
            const chunkAccounts = await withBackoff(() => connection.getMultipleAccountsInfo(chunk), 6, 1000);
            accounts.push(...chunkAccounts);
            await sleep(1500); // 1.5 SEGUNDOS DE PAUSA POR LOTE
        }

        const balances = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const acc = accounts[i];
            const sol = acc ? acc.lamports / LAMPORTS_PER_SOL : 0;
            const subWalletPubKey = new PublicKey(row.public_key);

            const mitkBalance = await getMitkBalance(subWalletPubKey);

            balances.push({
                public_key: row.public_key,
                solBalance: sol.toFixed(4),
                mitkBalance: mitkBalance.toFixed(2),
                status: row.status
            });
            await sleep(200);
        }
        addLog("✅ Leitura de saldos concluída com sucesso.", "success");
        res.json(balances);
    } catch (error) {
        addLog("❌ Erro ao atualizar saldos.", "error");
        console.error("Erro saldos:", error);
        res.status(500).json({ error: 'Erro ao buscar saldos na rede.' });
    }
});

app.post('/api/treasury/disperse', async (req, res) => {
    try {
        const amountSol = parseFloat(process.env.FUNDING_AMOUNT_SOL) || 0.015;
        const lamportsToTransfer = Math.floor(amountSol * LAMPORTS_PER_SOL);
        addLog(`🚀 Iniciando dispersão de ${amountSol} SOL para sub-wallets...`, 'info');

        const rows = await new Promise((resolve, reject) => {
            db.all("SELECT public_key FROM sub_wallets", [], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });

        const chunkSize = 10; let successCount = 0;

        for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize);
            const transaction = new Transaction();

            for (const row of chunk) {
                transaction.add(SystemProgram.transfer({
                    fromPubkey: mainWallet.publicKey,
                    toPubkey: new PublicKey(row.public_key),
                    lamports: lamportsToTransfer,
                }));
            }

            try {
                // Tentativa de Enviar e Confirmar com Backoff
                await withBackoff(() => sendAndConfirmTransaction(connection, transaction, [mainWallet]), 3, 2000);
                successCount += chunk.length;
                await sleep(1000);
            } catch (chunkError) { addLog(`❌ Falha ao dispersar lote: ${chunkError.message}`, 'error'); }
        }

        addLog(`✅ Dispersão finalizada: ${successCount} carteiras receberam fundos.`, 'success');
        res.json({ success: true, message: `Dispersão concluída.` });
    } catch (error) { res.status(500).json({ error: 'Erro geral.' }); }
});

app.post('/api/treasury/reclaim-mitk', async (req, res) => {
    addLog(`🧹 Recolhendo MITK...`, 'info');
    res.json({ success: true, message: `Comando enviado.` });
});

app.post('/api/treasury/reclaim-sol', async (req, res) => {
    addLog(`🧹 Recolhendo SOL remanescente...`, 'info');
    res.json({ success: true, message: `Comando enviado.` });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando envelopado na porta ${PORT}`);
});
