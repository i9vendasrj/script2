require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const https = require('https');

// BIBLIOTECAS WEB3 (SOLANA)
const solanaWeb3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');

// CORREÇÃO BS58
let bs58;
try {
    bs58 = require('bs58');
    if (!bs58.decode && bs58.default) bs58 = bs58.default;
} catch (e) {
    console.error("Erro fatal ao carregar bs58.");
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let db;

// ============================================================================
// REDUNDÂNCIA MULTI-ORÁCULO E FUNÇÕES HTTP (DÓLAR, SOLANA E TELEGRAM)
// ============================================================================
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'MultiToken-Server/1.0' }, timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function postJson(url, body) {
    return new Promise((resolve, reject) => {
        const dataString = JSON.stringify(body);
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dataString) },
            timeout: 5000
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(dataString); req.end();
    });
}

async function getCotacaoDolar() {
    try { const data = await fetchJson('https://economia.awesomeapi.com.br/json/last/USD-BRL'); if (data?.USDBRL?.ask) return parseFloat(data.USDBRL.ask); } catch (e) {}
    try { const data = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL'); if (data?.price) return parseFloat(data.price); } catch (e) {}
    try { const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl'); if (data?.tether?.brl) return parseFloat(data.tether.brl); } catch (e) {}
    throw new Error("Falha catastrófica de rede na VPS. Nenhum provedor de câmbio alcançável.");
}

async function getCotacaoSolana() {
    try { const data = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'); if (data?.price) return parseFloat(data.price); } catch (e) {}
    try { const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'); if (data?.solana?.usd) return parseFloat(data.solana.usd); } catch (e) {}
    throw new Error("Falha ao buscar preço da Solana.");
}

// ============================================================================
// NOVO: SISTEMA DE NOTIFICAÇÃO TELEGRAM BUY BOT
// ============================================================================
async function dispararBotTelegram(presale, carteira, valorGastoTexto, amountTokens, txHash) {
    if (!process.env.TG_BOT_TOKEN) return;

    try {
        const walletShort = carteira.substring(0, 4) + '...' + carteira.slice(-4);
        const dataFim = new Date(presale.end_date).toLocaleDateString('pt-BR');

        const caption = `🚀 <b>NOVA COMPRA DE PRÉ-VENDA!</b> 🚀

👤 <b>Investidor:</b> <code>${walletShort}</code>
💎 <b>Token:</b> ${presale.name}
💵 <b>Investimento:</b> ${valorGastoTexto}
🎯 <b>Tokens Comprados:</b> ${new Intl.NumberFormat('en-US').format(amountTokens)} ${presale.symbol}
🎁 <b>Bônus da Campanha:</b> ${presale.bonus_percent}%

📝 <b>Contrato:</b> <code>${presale.mint_address}</code>
⏳ <b>Fim da Pré-venda:</b> ${dataFim}
🔗 <a href="https://solscan.io/tx/${txHash}">Ver Recibo na Solscan</a>

🛒 <b>COMPRE NA PRÉ VENDA (${presale.symbol})</b>
👉 <a href="https://privatesale.multitoken.top">privatesale.multitoken.top</a>`;

        const chats = [];
        if (process.env.TG_CHAT_ID_GLOBAL) chats.push(process.env.TG_CHAT_ID_GLOBAL);
        if (presale.tg_chat_id) chats.push(presale.tg_chat_id);

        const uniqueChats = [...new Set(chats)];

        for (let chatId of uniqueChats) {
            await postJson(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendPhoto`, {
                chat_id: chatId,
                photo: presale.logo_url,
                caption: caption,
                parse_mode: 'HTML'
            });
        }
    } catch (e) { console.error("Erro ao disparar alerta no Telegram:", e.message); }
}

// ============================================================================
// 1. INICIALIZAÇÃO DO BANCO DE DADOS
// ============================================================================
(async () => {
    try {
        db = await open({ filename: './privatesale.sqlite', driver: sqlite3.Database });

        await db.exec(`CREATE TABLE IF NOT EXISTS presale_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT, mint_address TEXT UNIQUE, symbol TEXT, name TEXT,
            logo_url TEXT, website_url TEXT, twitter_url TEXT, discord_url TEXT, tg_group_url TEXT, tg_chat_id TEXT,
            price_usd REAL, min_purchase_usd REAL DEFAULT 0, max_purchase_usd REAL DEFAULT 0,
            bonus_percent REAL DEFAULT 0, start_date DATETIME, end_date DATETIME, hardcap_tokens REAL,
            tokens_sold REAL DEFAULT 0, native_tax_percent REAL DEFAULT 0, is_active INTEGER DEFAULT 1,
            dev_wallet TEXT
        )`);

        try { await db.exec(`ALTER TABLE presale_tokens ADD COLUMN dev_wallet TEXT;`); } catch(e) {}

        await db.exec(`CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY, presale_id INTEGER, amount_brl REAL, amount_tokens REAL,
            payment_method TEXT, wallet TEXT, txid_proof TEXT, status TEXT, tx_hash TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.exec(`CREATE TABLE IF NOT EXISTS users (
            wallet TEXT PRIMARY KEY, pin_hash TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.exec(`CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT)`);
        await db.run("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('taxa_pix', '4.9')");
        await db.run("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('taxa_cartao', '8.0')");
        await db.run("INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('wallet_cofre', '')");

        const PORT = process.env.PORT || 3340;
        app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT} com Swap Dinâmico P2P`));
    } catch (error) { console.error('❌ Erro no BD:', error); }
})();

// ============================================================================
// 2. FUNÇÃO MESTRE: DISPARO DE TOKENS (WEB3)
// ============================================================================
async function enviarTokensSolana(destinoAddress, mintAddress, quantidade) {
    try {
        if (!process.env.WALLET_PRIVATE_KEY) throw new Error("Chave privada não configurada.");
        if (typeof bs58.decode !== 'function') throw new Error("Biblioteca bs58 falhou.");

        const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('mainnet-beta'), 'confirmed');
        const secretKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
        const feePayer = solanaWeb3.Keypair.fromSecretKey(secretKey);

        const toWallet = new solanaWeb3.PublicKey(destinoAddress);
        const mint = new solanaWeb3.PublicKey(mintAddress);

        const mintAccountInfo = await connection.getAccountInfo(mint);
        if (!mintAccountInfo) throw new Error("Contrato não encontrado na rede Solana.");
        const tokenProgramId = mintAccountInfo.owner;

        const mintInfo = await splToken.getMint(connection, mint, 'confirmed', tokenProgramId);

        const quantidadeExataInteira = Math.floor(quantidade);
        const amountEmMenorUnidade = BigInt(quantidadeExataInteira) * BigInt(Math.pow(10, mintInfo.decimals));

        const fromTokenAccount = await splToken.getOrCreateAssociatedTokenAccount(
            connection, feePayer, mint, feePayer.publicKey, false, 'confirmed', undefined, tokenProgramId
        );

        const toTokenAccount = await splToken.getOrCreateAssociatedTokenAccount(
            connection, feePayer, mint, toWallet, false, 'confirmed', undefined, tokenProgramId
        );

        console.log(`📡 Disparando ${quantidadeExataInteira} tokens via transferChecked...`);

        const signature = await splToken.transferChecked(
            connection, feePayer, fromTokenAccount.address, mint, toTokenAccount.address, feePayer,
            amountEmMenorUnidade, mintInfo.decimals, [], undefined, tokenProgramId
        );

        console.log(`✅ Sucesso Web3! Transação confirmada. Hash: ${signature}`);
        return { sucesso: true, signature };
    } catch (error) {
        console.error("❌ Erro no envio Solana:", error);
        return { sucesso: false, erro: error.message };
    }
}

// ============================================================================
// 3. SEGURANÇA: MIDDLEWARES
// ============================================================================
const verifyAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(403).json({ erro: 'Acesso Negado.' });
    jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET, (err, decoded) => {
        if (err || !decoded.admin) return res.status(401).json({ erro: 'Sessão Inválida' });
        next();
    });
};

const verifyInvestor = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(403).json({ erro: 'Acesso Negado.' });
    jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET, (err, decoded) => {
        if (err || decoded.role !== 'investor') return res.status(401).json({ erro: 'Sessão Inválida' });
        req.user = decoded;
        next();
    });
};

const hashPin = (pin) => crypto.createHash('sha256').update(pin).digest('hex');

// ============================================================================
// 4. ROTAS: AUTH E GESTÃO (ADMIN)
// ============================================================================
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === process.env.ADMIN_PASSWORD) {
        res.json({ sucesso: true, token: jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '24h' }) });
    } else { res.status(401).json({ erro: 'Senha incorreta' }); }
});

app.post('/api/admin/presales', verifyAdmin, async (req, res) => {
    try {
        const d = req.body;
        await db.run(`INSERT INTO presale_tokens (mint_address, symbol, name, logo_url, website_url, twitter_url, discord_url, tg_group_url, tg_chat_id, price_usd, min_purchase_usd, max_purchase_usd, bonus_percent, start_date, end_date, hardcap_tokens, native_tax_percent, dev_wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [d.mint_address, d.symbol, d.name, d.logo_url, d.website_url||null, d.twitter_url||null, d.discord_url||null, d.tg_group_url||null, d.tg_chat_id||null, d.price_usd, d.min_purchase_usd||0, d.max_purchase_usd||0, d.bonus_percent||0, d.start_date, d.end_date, d.hardcap_tokens, d.native_tax_percent||0, d.dev_wallet||null]);
        res.json({ sucesso: true, mensagem: 'Cadastrada!' });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/admin/presales', verifyAdmin, async (req, res) => {
    try {
        const query = `
            SELECT p.*,
            COALESCE((SELECT SUM(amount_brl) FROM transactions WHERE presale_id = p.id AND payment_method = 'pix' AND status = 'concluida'), 0) as total_pix,
            COALESCE((SELECT SUM(amount_brl) FROM transactions WHERE presale_id = p.id AND payment_method LIKE '%solana%' AND status = 'concluida'), 0) as total_solana,
            COALESCE((SELECT SUM(amount_tokens) FROM transactions WHERE presale_id = p.id AND status = 'concluida'), 0) as real_tokens_sold
            FROM presale_tokens p ORDER BY p.id DESC
        `;
        res.json(await db.all(query));
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

app.put('/api/admin/presales/:id', verifyAdmin, async (req, res) => {
    try {
        const d = req.body;
        await db.run(`UPDATE presale_tokens SET price_usd=?, min_purchase_usd=?, max_purchase_usd=?, bonus_percent=?, end_date=?, hardcap_tokens=?, native_tax_percent=?, website_url=?, twitter_url=?, discord_url=?, tg_group_url=?, tg_chat_id=?, is_active=?, dev_wallet=? WHERE id=?`,
            [d.price_usd, d.min_purchase_usd, d.max_purchase_usd, d.bonus_percent, d.end_date, d.hardcap_tokens, d.native_tax_percent, d.website_url, d.twitter_url, d.discord_url, d.tg_group_url, d.tg_chat_id, d.is_active, d.dev_wallet, req.params.id]);
        res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/admin/presales/:id', verifyAdmin, async (req, res) => { try { await db.run(`DELETE FROM presale_tokens WHERE id = ?`, [req.params.id]); res.json({ sucesso: true }); } catch (e) { res.status(500).json({ erro: e.message }); } });

app.get('/api/admin/settings', verifyAdmin, async (req, res) => { try { const s = await db.all("SELECT * FROM platform_settings"); const c = {}; s.forEach(x => c[x.key] = x.value); res.json(c); } catch (e) { res.status(500).json({ erro: e.message }); } });
app.put('/api/admin/settings', verifyAdmin, async (req, res) => { try { const d = req.body; await db.run("UPDATE platform_settings SET value = ? WHERE key = 'taxa_pix'", [d.taxa_pix]); await db.run("UPDATE platform_settings SET value = ? WHERE key = 'taxa_cartao'", [d.taxa_cartao]); await db.run("UPDATE platform_settings SET value = ? WHERE key = 'wallet_cofre'", [d.wallet_cofre||'']); res.json({ sucesso: true }); } catch (e) { res.status(500).json({ erro: e.message }); } });

app.get('/api/admin/transactions', verifyAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 10, presale_id, status } = req.query; const offset = (page - 1) * limit; let w = "1=1"; let p = [];
        if (presale_id) { w += " AND t.presale_id = ?"; p.push(presale_id); }
        if (status) { w += " AND t.status = ?"; p.push(status); }
        const tot = await db.get(`SELECT COUNT(*) as count FROM transactions t WHERE ${w}`, p);
        const txs = await db.all(`SELECT t.*, p.symbol FROM transactions t LEFT JOIN presale_tokens p ON t.presale_id = p.id WHERE ${w} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
        res.json({ total: tot.count, page: Number(page), totalPages: Math.ceil(tot.count / limit), data: txs });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/admin/transactions/:id', verifyAdmin, async (req, res) => { try { await db.run("DELETE FROM transactions WHERE id = ? AND status != 'concluida'", [req.params.id]); res.json({ sucesso: true }); } catch (e) { res.status(500).json({ erro: e.message }); } });

// ============================================================================
// ROTA: INJEÇÃO MANUAL / REPROCESSAMENTO DE TRANSAÇÃO (ADMIN)
// ============================================================================
app.post('/api/admin/force-validate', verifyAdmin, async (req, res) => {
    try {
        const { txid, presale_id, wallet } = req.body;

        if (!txid || !presale_id || !wallet) return res.status(400).json({ erro: 'Preencha todos os campos.' });

        const presale = await db.get("SELECT * FROM presale_tokens WHERE id = ?", [presale_id]);
        if (!presale || !presale.dev_wallet) return res.status(404).json({ erro: 'Campanha inválida ou sem carteira DEV.' });

        // 1. VERIFICA SE A TRANSAÇÃO JÁ EXISTE NO BANCO DE DADOS
        const txExistente = await db.get("SELECT * FROM transactions WHERE txid_proof = ?", [txid]);

        if (txExistente) {
            if (txExistente.status === 'concluida') {
                return res.status(400).json({ erro: 'Esta transação já foi processada e os tokens já foram enviados.' });
            }

            const solanaRes = await enviarTokensSolana(txExistente.wallet, presale.mint_address, txExistente.amount_tokens);

            if (solanaRes.sucesso) {
                await db.run("UPDATE transactions SET status = 'concluida', tx_hash = ? WHERE id = ?", [solanaRes.signature, txExistente.id]);

                // Disparo no TG (Injeção de Retentativa)
                const valorGastoTexto = txExistente.payment_method.includes('solana') ? `$ ${txExistente.amount_brl.toFixed(2)} USD` : `R$ ${txExistente.amount_brl.toFixed(2)} (PIX)`;
                dispararBotTelegram(presale, txExistente.wallet, valorGastoTexto, txExistente.amount_tokens, solanaRes.signature);

                return res.json({ sucesso: true, mensagem: `Transação destravada! ${txExistente.amount_tokens} tokens foram enviados com sucesso.` });
            } else {
                return res.status(500).json({ erro: 'O reenvio de tokens falhou. Verifique o saldo do cofre ou rede Solana. Erro: ' + solanaRes.erro });
            }
        }

        // =======================================================
        // 2. SE NÃO EXISTIR (É UMA TRANSFERÊNCIA FANTASMA PURA)
        // =======================================================
        const connection = new solanaWeb3.Connection('https://solana-rpc.publicnode.com', 'confirmed');
        const txInfo = await connection.getTransaction(txid, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

        if (!txInfo) return res.status(404).json({ erro: 'Transação não encontrada na rede Solana.' });

        const accountKeys = txInfo.transaction.message.accountKeys.map(k => k.toString());
        const devWalletIndex = accountKeys.indexOf(presale.dev_wallet);

        if (devWalletIndex === -1) return res.status(400).json({ erro: 'Os fundos desta Hash não foram para a carteira DEV desta campanha.' });

        const preBalance = txInfo.meta.preBalances[devWalletIndex];
        const postBalance = txInfo.meta.postBalances[devWalletIndex];
        const amountLamports = postBalance - preBalance;

        if (amountLamports <= 0) return res.status(400).json({ erro: 'Nenhum saldo depositado para o DEV nesta transação.' });

        const amountSolRecebido = amountLamports / solanaWeb3.LAMPORTS_PER_SOL;
        const solPriceUsd = await getCotacaoSolana();
        const amountUsdRecebido = amountSolRecebido * solPriceUsd;

        const tokensBase = amountUsdRecebido / presale.price_usd;
        const totalTokens = Math.floor(tokensBase + ((tokensBase * presale.bonus_percent) / 100));

        const userExist = await db.get("SELECT wallet FROM users WHERE wallet = ?", [wallet]);
        if (!userExist) {
            await db.run("INSERT INTO users (wallet, pin_hash) VALUES (?, ?)", [wallet, '1234']);
        }

        const newId = uuidv4();
        await db.run(`INSERT INTO transactions (id, presale_id, amount_brl, amount_tokens, payment_method, wallet, status, txid_proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId, presale_id, amountUsdRecebido, totalTokens, 'solana_manual', wallet, 'concluida', txid]
        );

        await db.run("UPDATE presale_tokens SET tokens_sold = tokens_sold + ? WHERE id = ?", [totalTokens, presale_id]);

        const solanaRes = await enviarTokensSolana(wallet, presale.mint_address, totalTokens);

        if (solanaRes.sucesso) {
            await db.run("UPDATE transactions SET tx_hash = ? WHERE id = ?", [solanaRes.signature, newId]);

            // Disparo no TG (Injeção Pura)
            dispararBotTelegram(presale, wallet, `$ ${amountUsdRecebido.toFixed(2)} USD`, totalTokens, solanaRes.signature);

            return res.json({ sucesso: true, mensagem: `Sucesso! Sistema leu ${amountSolRecebido.toFixed(4)} SOL. ${totalTokens} tokens disparados para o investidor.` });
        } else {
            await db.run("UPDATE transactions SET status = 'pendente' WHERE id = ?", [newId]);
            return res.status(500).json({ erro: 'A transação foi salva, mas o envio falhou (Saldo do cofre?). Erro: ' + solanaRes.erro });
        }

    } catch (e) {
        console.error("Erro na Injeção Manual:", e);
        res.status(500).json({ erro: 'Falha interna: ' + e.message });
    }
});

// ============================================================================
// ROTA DO SENSOR DE TESOURARIA (ADMIN)
// ============================================================================
app.get('/api/admin/treasury', verifyAdmin, async (req, res) => {
    try {
        if (!process.env.WALLET_PRIVATE_KEY) throw new Error("Chave privada do Cofre não configurada.");
        if (typeof bs58.decode !== 'function') throw new Error("Biblioteca bs58 falhou.");

        const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('mainnet-beta'), 'confirmed');
        const secretKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
        const feePayer = solanaWeb3.Keypair.fromSecretKey(secretKey);
        const cofrePubkey = feePayer.publicKey;

        const campanhas = await db.all("SELECT id, symbol, mint_address FROM presale_tokens WHERE is_active = 1");
        let saldos = [];

        const saldosPromises = campanhas.map(async (campanha) => {
            try {
                const mint = new solanaWeb3.PublicKey(campanha.mint_address);
                const mintAccountInfo = await connection.getAccountInfo(mint);
                if (!mintAccountInfo) return { ...campanha, balance: 0, error: 'Token não encontrado.' };
                const tokenProgramId = mintAccountInfo.owner;

                const tokenAccountAddress = await splToken.getAssociatedTokenAddress(mint, cofrePubkey, false, tokenProgramId);
                const info = await connection.getTokenAccountBalance(tokenAccountAddress);
                return { ...campanha, balance: info.value.uiAmount || 0 };
            } catch (err) { return { ...campanha, balance: 0, error: err.message }; }
        });

        saldos = await Promise.all(saldosPromises);
        res.json({ cofre_address: cofrePubkey.toString(), saldos: saldos });

    } catch (e) {
        console.error("Erro no Sensor de Tesouraria:", e);
        res.status(500).json({ erro: e.message });
    }
});

// ============================================================================
// 5. ROTAS PÚBLICAS, CHECKOUT PIX E AUDITORIA SOLANA
// ============================================================================
app.get('/api/public/settings', async (req, res) => {
    try {
        const s = await db.all("SELECT * FROM platform_settings WHERE key IN ('taxa_pix', 'taxa_cartao')");
        const c = {}; s.forEach(x => c[x.key] = x.value);
        res.json(c);
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/public/cotacao', async (req, res) => {
    try { res.json({ cotacao: await getCotacaoDolar() }); } catch (e) { res.status(503).json({ erro: "Oráculos temporariamente indisponíveis." }); }
});

app.get('/api/public/presales', async (req, res) => { try { res.json(await db.all("SELECT * FROM presale_tokens WHERE is_active = 1 ORDER BY id DESC")); } catch (e) { res.status(500).json({ erro: e.message }); } });

app.post('/api/public/auth', async (req, res) => {
    try {
        const { wallet, pin } = req.body;
        if (!wallet || !pin || pin.length < 4) return res.status(400).json({ erro: 'Dados inválidos.' });
        const hashedPin = hashPin(pin);
        let user = await db.get("SELECT * FROM users WHERE wallet = ?", [wallet]);
        if (!user) { await db.run("INSERT INTO users (wallet, pin_hash) VALUES (?, ?)", [wallet, hashedPin]); }
        else if (user.pin_hash !== hashedPin) { return res.status(401).json({ erro: 'PIN incorreto.' }); }
        res.json({ sucesso: true, token: jwt.sign({ wallet: wallet, role: 'investor' }, process.env.JWT_SECRET, { expiresIn: '7d' }), wallet: wallet });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/public/checkout', verifyInvestor, async (req, res) => {
    try {
        const { presale_id, amount_usd, payment_method } = req.body;
        const wallet = req.user.wallet;

        const presale = await db.get("SELECT * FROM presale_tokens WHERE id = ? AND is_active = 1", [presale_id]);
        if (!presale) return res.status(404).json({ erro: 'Campanha inativa.' });

        if (payment_method === 'pix') {
            if (amount_usd < presale.min_purchase_usd || amount_usd > presale.max_purchase_usd) return res.status(400).json({ erro: 'Valor fora dos limites da campanha.' });

            let COTACAO_USD_BRL;
            try { COTACAO_USD_BRL = await getCotacaoDolar(); } catch (err) { return res.status(503).json({ erro: "Cotação indisponível. Tente novamente." }); }

            const settings = await db.all("SELECT * FROM platform_settings");
            const config = {}; settings.forEach(s => config[s.key] = s.value);
            const feePercent = parseFloat(config.taxa_pix || 0);

            const netUsd = amount_usd - (amount_usd * (feePercent / 100));
            const tokensBase = netUsd / presale.price_usd;
            const totalTokens = Math.floor(tokensBase + ((tokensBase * presale.bonus_percent) / 100));
            const amountBrl = amount_usd * COTACAO_USD_BRL;
            const txId = uuidv4();

            await db.run(`INSERT INTO transactions (id, presale_id, amount_brl, amount_tokens, payment_method, wallet, status) VALUES (?, ?, ?, ?, ?, ?, ?)`, [txId, presale_id, amountBrl, totalTokens, payment_method, wallet, 'pendente']);

            if(!process.env.MP_ACCESS_TOKEN) return res.status(500).json({ erro: "Chave MP não configurada." });
            const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
            const payment = new Payment(client);

            const pixData = await payment.create({
                body: {
                    transaction_amount: Number(amountBrl.toFixed(2)),
                    description: `Pré-Venda ${presale.symbol} (${totalTokens.toFixed(0)} tokens)`,
                    payment_method_id: 'pix', payer: { email: "suporte@multitoken.top" },
                    external_reference: txId, notification_url: "https://privatesale.multitoken.top/api/webhook/mercadopago"
                }
            });

            return res.json({ sucesso: true, is_pix: true, qr_code: pixData.point_of_interaction.transaction_data.qr_code, qr_code_base64: pixData.point_of_interaction.transaction_data.qr_code_base64, tx_id: txId, cotacao_aplicada: COTACAO_USD_BRL });
        }

        if (payment_method === 'solana') {
            if(!presale.dev_wallet) return res.status(400).json({ erro: "Carteira do DEV não configurada nesta campanha." });
            let solPriceUsd;
            try { solPriceUsd = await getCotacaoSolana(); } catch (e) { return res.status(503).json({ erro: "Oráculo Solana offline." }); }

            const amountSolEstimado = amount_usd / solPriceUsd;
            return res.json({ sucesso: true, is_crypto: true, dev_wallet: presale.dev_wallet, amount_sol: amountSolEstimado.toFixed(4), cotacao_sol: solPriceUsd });
        }

    } catch (e) { console.error("Erro Checkout:", e); res.status(500).json({ erro: "Falha ao processar." }); }
});

// MOTOR DE AUDITORIA E SWAP DINÂMICO P2P
app.post('/api/public/validate-solana', verifyInvestor, async (req, res) => {
    try {
        const { txid, presale_id } = req.body;
        const wallet = req.user.wallet;

        if (!txid || txid.length < 60) return res.status(400).json({ erro: 'Hash (TXID) inválida.' });

        const presale = await db.get("SELECT * FROM presale_tokens WHERE id = ? AND is_active = 1", [presale_id]);
        if (!presale || !presale.dev_wallet) return res.status(404).json({ erro: 'Campanha inativa ou sem carteira DEV.' });

        // TRAVA DE CONCORRÊNCIA EM MEMÓRIA (CONTRA RACE CONDITIONS)
        if (!global.validationLocks) global.validationLocks = new Set();
        if (global.validationLocks.has(txid)) {
            return res.status(400).json({ erro: 'Esta transação já está sendo processada no momento. Aguarde.' });
        }
        global.validationLocks.add(txid);

        try {
            const txExistente = await db.get("SELECT id FROM transactions WHERE txid_proof = ?", [txid]);
            if (txExistente) {
                return res.status(400).json({ erro: 'Esta transação já foi processada na plataforma.' });
            }

            const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('mainnet-beta'), 'confirmed');
            const txInfo = await connection.getTransaction(txid, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

            if (!txInfo) return res.status(404).json({ erro: 'Transação não encontrada na rede Solana. Aguarde 1 minuto e tente novamente.' });

            const accountKeys = txInfo.transaction.message.accountKeys.map(k => k.toString());
            const devWalletIndex = accountKeys.indexOf(presale.dev_wallet);

            if (devWalletIndex === -1) return res.status(400).json({ erro: 'Os fundos não foram enviados para a carteira oficial desta campanha.' });

            const preBalance = txInfo.meta.preBalances[devWalletIndex];
            const postBalance = txInfo.meta.postBalances[devWalletIndex];
            const amountLamports = postBalance - preBalance;

            if (amountLamports <= 0) return res.status(400).json({ erro: 'Nenhum saldo foi depositado na carteira do desenvolvedor nesta transação.' });

            const amountSolRecebido = amountLamports / solanaWeb3.LAMPORTS_PER_SOL;

            const solPriceUsd = await getCotacaoSolana();
            const amountUsdRecebido = amountSolRecebido * solPriceUsd;

            const tokensBase = amountUsdRecebido / presale.price_usd;
            const totalTokens = Math.floor(tokensBase + ((tokensBase * presale.bonus_percent) / 100));

            const newId = uuidv4();
            await db.run(`INSERT INTO transactions (id, presale_id, amount_brl, amount_tokens, payment_method, wallet, status, txid_proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [newId, presale_id, amountUsdRecebido, totalTokens, 'solana', wallet, 'concluida', txid]
            );

            await db.run("UPDATE presale_tokens SET tokens_sold = tokens_sold + ? WHERE id = ?", [totalTokens, presale_id]);

            const solanaRes = await enviarTokensSolana(wallet, presale.mint_address, totalTokens);

            if (solanaRes.sucesso) {
                await db.run("UPDATE transactions SET tx_hash = ? WHERE id = ?", [solanaRes.signature, newId]);

                // Disparo no TG (Validação Automática)
                dispararBotTelegram(presale, wallet, `$ ${amountUsdRecebido.toFixed(2)} USD`, totalTokens, solanaRes.signature);

                return res.json({ sucesso: true, mensagem: `Transação auditada! Você enviou ${amountSolRecebido.toFixed(4)} SOL (~$${amountUsdRecebido.toFixed(2)} USD). Foram disparados ${totalTokens} tokens para sua carteira.`, tx_hash: solanaRes.signature });
            } else {
                await db.run("UPDATE transactions SET status = 'pendente' WHERE id = ?", [newId]);
                return res.status(500).json({ erro: 'O pagamento foi confirmado, mas houve um erro na hora de enviar seus tokens. Acione o suporte informando sua Hash.' });
            }
        } finally {
            if (txid) global.validationLocks.delete(txid);
        }
    } catch (e) {
        console.error("Erro na Validação Solana:", e);
        res.status(500).json({ erro: 'Falha ao auditar transação. Tente novamente.' });
    }
});

app.get('/api/public/my-purchases', verifyInvestor, async (req, res) => {
    try {
        const wallet = req.user.wallet;
        const query = `
            SELECT t.id, t.amount_tokens, t.amount_brl, t.payment_method, t.status, t.created_at, t.tx_hash,
                   p.symbol, p.logo_url, p.name
            FROM transactions t
            JOIN presale_tokens p ON t.presale_id = p.id
            WHERE t.wallet = ?
            ORDER BY t.created_at DESC
        `;
        res.json(await db.all(query, [wallet]));
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================================
// 6. WEBHOOKS E SENSOR DE STATUS
// ============================================================================
app.get('/api/public/transactions/:id/status', async (req, res) => {
    try {
        const tx = await db.get("SELECT status FROM transactions WHERE id = ?", [req.params.id]);
        if (tx) res.json({ status: tx.status }); else res.status(404).json({ erro: 'Transação não encontrada' });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/webhook/mercadopago', async (req, res) => {
    const paymentId = req.query['data.id'] || req.body?.data?.id;
    const type = req.query.type || req.body?.type;
    res.sendStatus(200);

    if (type === 'payment' && paymentId) {
        try {
            const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
            const payData = await new Payment(client).get({ id: paymentId });

            if (payData.status === 'approved') {
                const txId = payData.external_reference;
                if (txId) {
                    const tx = await db.get("SELECT id, presale_id, amount_brl, amount_tokens, status, wallet FROM transactions WHERE id = ?", [txId]);
                    if (tx && tx.status !== 'concluida') {
                        await db.run("UPDATE transactions SET status = 'concluida' WHERE id = ?", [txId]);
                        await db.run("UPDATE presale_tokens SET tokens_sold = tokens_sold + ? WHERE id = ?", [tx.amount_tokens, tx.presale_id]);
                        const presale = await db.get("SELECT * FROM presale_tokens WHERE id = ?", [tx.presale_id]);

                        if (presale && presale.mint_address) {
                            const solanaRes = await enviarTokensSolana(tx.wallet, presale.mint_address, tx.amount_tokens);
                            if (solanaRes.sucesso) {
                                await db.run("UPDATE transactions SET tx_hash = ? WHERE id = ?", [solanaRes.signature, txId]);

                                // Disparo no TG (Webhook PIX)
                                dispararBotTelegram(presale, tx.wallet, `R$ ${tx.amount_brl.toFixed(2)} (PIX)`, tx.amount_tokens, solanaRes.signature);
                            }
                        }
                    }
                }
            }
        } catch (err) { console.error('Erro Webhook MP:', err); }
    }
});
