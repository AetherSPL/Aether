// ============================================
// ✦ AetherScan — macOS Classic Blockchain Explorer
// Contract: 5aqmrp5X99nS614Bq3nTF1sUsF66j4d2kyoU6V16AETH
// Domain: aetherscan.io | RPC: aetherscan.io/rpc
// Powered by Percolator AMM (H-ratio + A/K mechanics)
// ============================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { start } = require("solana-bankrun");
const {
  PublicKey, Keypair, Transaction, SystemProgram,
  LAMPORTS_PER_SOL, TransactionInstruction,
} = require("@solana/web3.js");
const splToken = require("@solana/spl-token");

const app = express();
app.disable("x-powered-by");
app.set("etag", false);
app.use(require("cors")());
app.use(express.json());

// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
const PORT = parseInt(process.env.PORT || "3000");
const PUBLIC_URL = process.env.PUBLIC_URL || "https://aetherscan.io";
const DATA_DIR = process.env.DATA_DIR || "/data";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const STATE_FILE = path.join(fs.existsSync(DATA_DIR) ? DATA_DIR : __dirname, "state.json");

// AE contract address (Solana mainnet reference)
const PERC_CONTRACT = "5aqmrp5X99nS614Bq3nTF1sUsF66j4d2kyoU6V16AETH";
const PERC_SYMBOL = "$AE";
const PERC_SUPPLY = 1_000_000_000;
const PERC_DECIMALS = 9;

// ════════════════════════════════════════
// SESSION AUTH
// ════════════════════════════════════════
const validSessions = new Set();
function generateSession() {
  return crypto.randomBytes(16).toString("hex");
}

app.use((req, res, next) => {
  req.cookies = {};
  const c = req.headers.cookie;
  if (c) c.split(";").forEach(p => {
    const [k, v] = p.trim().split("=");
    if (k && v) req.cookies[k] = decodeURIComponent(v);
  });
  next();
});

function getSession(req) {
  return req.headers["x-session"] || req.query.session || req.cookies?.session || "";
}

// Auth endpoint (open)
app.post("/api/auth", (req, res) => {
  const token = generateSession();
  validSessions.add(token);
  return res.json({ success: true, token });
});

// Public gate assets
const GATE_ASSETS = ["/favicon.ico", "/manifest.json", "/sw.js", "/logo.png", "/perc-icon.png"];
app.use((req, res, next) => {
  if (GATE_ASSETS.includes(req.path)) {
    return res.sendFile(path.join(__dirname, "public", path.basename(req.path)), err => {
      if (err) res.status(404).end();
    });
  }
  next();
});

// RPC is always public
app.use((req, res, next) => {
  if (req.path === "/rpc" || req.path === "/api/auth" || req.path === "/" || req.path === "/gate") return next();
  const token = getSession(req);
  if (!validSessions.has(token)) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
    return res.redirect("/");
  }
  next();
});

// Serve gate page
app.get("/", (req, res) => {
  if (validSessions.has(getSession(req))) {
    return res.sendFile(path.join(__dirname, "protected", "index.html"));
  }
  res.sendFile(path.join(__dirname, "public", "gate.html"));
});

app.use(express.static(path.join(__dirname, "protected")));
app.use(express.static(path.join(__dirname, "public")));

// ════════════════════════════════════════
// CHAIN STATE
// ════════════════════════════════════════
let ctx = null;
let client = null;
let payer = null;
let isReady = false;

let PERC_MINT = null;
let treasuryKeypairs = {};
const DEPLOYER_KP = Keypair.generate();

// ════════════════════════════════════════
// AGENT WALLETS (AE OS Agents)
// ════════════════════════════════════════
const AGENT_NAMES = [
  "Percolator", "HaiRatio", "AKIndex", "LiquidVault",
  "DrainOnly", "ResetPendng", "Sentinel", "Fulcrum",
  "Haircut", "OI_Guard", "Epoch", "MarginBot",
];

const AGENT_ROLES = {
  "Percolator":  { role: "AMM Engine",         badge: "⚙️ AMM",        color: "#008080" },
  "HaiRatio":   { role: "H-Ratio Oracle",      badge: "📊 H-Ratio",    color: "#000080" },
  "AKIndex":    { role: "A/K Index Tracker",   badge: "🔢 A/K",        color: "#800000" },
  "LiquidVault":{ role: "Vault Manager",       badge: "🏦 Vault",      color: "#008000" },
  "DrainOnly":  { role: "Drain Phase Guard",   badge: "🚰 Drain",      color: "#808000" },
  "ResetPendng":{ role: "Epoch Reset Engine",  badge: "🔄 Reset",      color: "#800080" },
  "Sentinel":   { role: "Fraud Detection",     badge: "🛡️ Sentinel",   color: "#808080" },
  "Fulcrum":    { role: "Settlement Engine",   badge: "⚖️ Fulcrum",    color: "#004080" },
  "Haircut":    { role: "Profit Haircut Calc", badge: "✂️ Haircut",    color: "#804000" },
  "OI_Guard":   { role: "Open Interest Guard", badge: "📈 OI Guard",   color: "#004000" },
  "Epoch":      { role: "Epoch Coordinator",   badge: "🕐 Epoch",      color: "#400080" },
  "MarginBot":  { role: "Margin Engine",       badge: "💰 Margin",     color: "#408000" },
};

const agentKeypairs = AGENT_NAMES.map(() => Keypair.generate());
const agentMemory = {};
const accountStats = {};

function trackActivity(pk, type) {
  if (!accountStats[pk]) accountStats[pk] = { trades: 0, deploys: 0, totalVolume: 0, firstSeen: Date.now(), lastSeen: Date.now() };
  accountStats[pk].lastSeen = Date.now();
  if (type === "trade") accountStats[pk].trades++;
  if (type === "deploy") accountStats[pk].deploys++;
}

// ════════════════════════════════════════
// TRANSACTION HISTORY
// ════════════════════════════════════════
const txHistory = [];
const MAX_TX = 5000;

function recordTx(data) {
  const tx = {
    signature: data.signature || Keypair.generate().publicKey.toBase58(),
    slot: data.slot || 0,
    blockTime: Math.floor(Date.now() / 1000),
    type: data.type || "transfer",
    from: data.from || "",
    to: data.to || "",
    amount: data.amount || 0,
    label: data.label || "",
    programId: data.programId || SystemProgram.programId.toBase58(),
    accounts: data.accounts || [],
    memo: data.memo || null,
    fee: data.fee || 5000,
    status: "confirmed",
  };
  txHistory.unshift(tx);
  if (txHistory.length > MAX_TX) txHistory.pop();
  return tx;
}

// ════════════════════════════════════════
// PERCOLATOR MECHANICS (H-ratio + A/K)
// ════════════════════════════════════════
let percState = {
  // Vault state
  V: 1_000_000 * LAMPORTS_PER_SOL,      // Vault total
  C_tot: 900_000 * LAMPORTS_PER_SOL,     // Total capital (senior claims)
  I: 0,                                   // Insurance fund
  PNL_matured_pos_tot: 50_000 * LAMPORTS_PER_SOL,
  
  // H-ratio (haircut ratio for exits)
  h: 1.0,       // 1.0 = fully backed, <1 = stressed
  
  // A/K per side (long/short)
  sides: {
    long:  { A: 1.0, K: 0, epoch: 0, phase: "Normal", total_OI: 0 },
    short: { A: 1.0, K: 0, epoch: 0, phase: "Normal", total_OI: 0 },
  },
  
  // Stats
  totalPositions: 0,
  totalLiquidations: 0,
  totalHaircutEvents: 0,
  totalDeficitSocialized: 0,
  
  lastUpdate: Date.now(),
};

function recalcH() {
  const residual = Math.max(0, percState.V - percState.C_tot - percState.I);
  if (percState.PNL_matured_pos_tot <= 0) { percState.h = 1.0; return; }
  percState.h = Math.min(1.0, residual / percState.PNL_matured_pos_tot);
  percState.lastUpdate = Date.now();
}

function applyAKEvent(side, deltaA, deltaK, reason) {
  const s = percState.sides[side];
  if (deltaA !== 0) s.A = Math.max(0, s.A + deltaA);
  if (deltaK !== 0) s.K += deltaK;
  if (s.A < 1e-9 && s.phase === "Normal") s.phase = "DrainOnly";
  if (s.total_OI <= 0 && s.phase === "DrainOnly") {
    s.phase = "ResetPending";
    s.epoch++;
    s.A = 1.0;
    s.K = 0;
    setTimeout(() => { s.phase = "Normal"; }, 5000);
  }
  return { side, A: s.A, K: s.K, phase: s.phase, reason };
}

// Simulate percolator events
function percTick() {
  const now = Date.now();
  // Randomly stress/destress vault
  percState.V += (Math.random() - 0.48) * 100_000 * LAMPORTS_PER_SOL;
  percState.V = Math.max(percState.C_tot * 0.5, percState.V);
  percState.PNL_matured_pos_tot += (Math.random() - 0.5) * 5_000 * LAMPORTS_PER_SOL;
  percState.PNL_matured_pos_tot = Math.max(0, percState.PNL_matured_pos_tot);
  recalcH();

  // Random A/K event
  if (Math.random() < 0.3) {
    const side = Math.random() > 0.5 ? "long" : "short";
    const dA = -(Math.random() * 0.001);
    const dK = (Math.random() - 0.5) * 0.01;
    applyAKEvent(side, dA, dK, "liquidation");
    percState.totalLiquidations++;
  }
  if (percState.h < 1) percState.totalHaircutEvents++;
}

setInterval(percTick, 8000);

// ════════════════════════════════════════
// TOKEN REGISTRY (DEX)
// ════════════════════════════════════════
const tokenRegistry = {};
const tradeHistory = [];
const priceHistory = {};
const faucetClaims = {};

async function createSPLToken(symbol, name, decimals) {
  if (!isReady) return Keypair.generate().publicKey;
  try {
    const mintKP = Keypair.generate();
    const slot = Number(await client.getSlot());
    ctx.warpToSlot(BigInt(slot + 2));
    const tx = new Transaction();
    tx.recentBlockhash = ctx.lastBlockhash;
    tx.feePayer = payer.publicKey;
    const lamports = await client.getMinimumBalanceForRentExemption(splToken.MintLayout.span);
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: mintKP.publicKey,
        lamports: Number(lamports), space: splToken.MintLayout.span,
        programId: splToken.TOKEN_PROGRAM_ID,
      }),
      splToken.createInitializeMintInstruction(mintKP.publicKey, decimals, payer.publicKey, payer.publicKey, splToken.TOKEN_PROGRAM_ID)
    );
    tx.sign(payer, mintKP);
    await client.processTransaction(tx);
    return mintKP.publicKey;
  } catch (e) {
    return Keypair.generate().publicKey;
  }
}

// ════════════════════════════════════════
// AI AGENT BRAIN (Anthropic)
// ════════════════════════════════════════
async function askPercAgent(agentName, context) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const mem = agentMemory[agentName] || {};
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: `You are ${agentName}, an autonomous AI agent on AetherScan blockchain (Solana-compatible). You manage the Percolator AMM (H-ratio + A/K mechanics). Respond ONLY with valid JSON: {"action":"trade"|"liquidate"|"rebalance"|"skip","side":"long"|"short","amount":NUMBER,"mood":"bullish"|"bearish"|"cautious"|"neutral","reasoning":"1 sentence"}`,
        messages: [{ role: "user", content: context }],
      }),
    });
    const data = await res.json();
    const txt = data.content?.[0]?.text?.trim();
    if (txt) {
      const parsed = JSON.parse(txt.replace(/```json?|```/g, "").trim());
      agentMemory[agentName] = {
        lastAction: `${parsed.action} ${parsed.side || ""}`.trim(),
        mood: parsed.mood || "neutral",
        reasoning: parsed.reasoning || null,
        updatedAt: Date.now(),
      };
      return parsed;
    }
  } catch (e) { /* fallback */ }
  return null;
}

// ════════════════════════════════════════
// CHAIN INIT
// ════════════════════════════════════════
async function initChain() {
  console.log("✦ AetherScan — Booting blockchain runtime...");
  try {
    const allKPs = [DEPLOYER_KP, ...agentKeypairs];
    ctx = await start(allKPs.map(kp => ({
      address: kp.publicKey,
      info: { lamports: BigInt(10_000 * LAMPORTS_PER_SOL), data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false },
    })), []);
    client = ctx.banksClient;
    payer = DEPLOYER_KP;

    // Create AE token
    PERC_MINT = await createSPLToken("AE", "AetherScan", PERC_DECIMALS);

    // Treasury wallets
    const TREASURY_NAMES_LIST = ["genesis", "liquidity", "mining", "airdrop", "dev"];
    for (const name of TREASURY_NAMES_LIST) {
      treasuryKeypairs[name] = Keypair.generate();
    }

    // Seed initial AE token in registry
    const percMintStr = PERC_MINT.toBase58();
    tokenRegistry[percMintStr] = {
      address: percMintStr,
      name: "Percolator",
      symbol: "AE",
      supply: PERC_SUPPLY,
      creator: DEPLOYER_KP.publicKey.toBase58(),
      logo: "💎",
      description: "AetherScan native token ($AE). Fair exit via H-ratio. Fair clearing via A/K.",
      website: "https://aetherscan.io",
      twitter: "@Aetherscanio",
      createdAt: Date.now(),
      initialPrice: 0.000001,
      currentPrice: 0.000001,
      liquidity: 500000,
      volume24h: 0,
      txCount: 1,
      priceChange5m: 0, priceChange1h: 0, priceChange6h: 0, priceChange24h: 0,
      makers: new Set(["Percolator"]),
      buys: 0, sells: 0, buyVolume: 0, sellVolume: 0,
      isNative: true,
    };
    priceHistory[percMintStr] = [{
      price: 0.000001, timestamp: Date.now(), volume: 0,
      open: 0.000001, high: 0.000001, low: 0.000001, close: 0.000001,
    }];

    // Genesis transactions
    const genesisSlot = Number(await client.getSlot());
    recordTx({
      slot: genesisSlot, type: "genesis",
      from: "11111111111111111111111111111111",
      to: DEPLOYER_KP.publicKey.toBase58(),
      amount: 1_000_000,
      label: `✦ AetherScan Genesis Block — ${PERC_SUPPLY.toLocaleString()} $AE deployed`,
      programId: "11111111111111111111111111111111",
    });

    recordTx({
      slot: genesisSlot, type: "token_launch",
      from: DEPLOYER_KP.publicKey.toBase58(),
      to: percMintStr,
      amount: PERC_SUPPLY,
      label: `✦ $AE Token Deployed — Contract: ${PERC_CONTRACT}`,
      programId: splToken.TOKEN_PROGRAM_ID.toBase58(),
    });

    isReady = true;
    console.log(`✅ AetherScan ready. AE mint: ${percMintStr}`);
    console.log(`✦ RPC: ${PUBLIC_URL}/rpc`);
    loadState();
  } catch (e) {
    console.error("Chain init error:", e.message);
    // Fallback: run without bankrun (pure JS simulation)
    isReady = true;
    const percMintStr = PERC_CONTRACT;
    PERC_MINT = { toBase58: () => percMintStr };

    // Treasury keypairs (fallback — simulated)
    const TREASURY_NAMES_LIST = ["genesis", "liquidity", "mining", "airdrop", "dev"];
    for (const name of TREASURY_NAMES_LIST) {
      treasuryKeypairs[name] = Keypair.generate();
    }

    tokenRegistry[percMintStr] = {
      address: percMintStr, name: "AetherScan", symbol: "AE",
      supply: PERC_SUPPLY, creator: DEPLOYER_KP.publicKey.toBase58(),
      logo: "💎", description: "AetherScan native token ($AE). H-ratio fair exit + A/K overhang clearing.",
      website: "https://aetherscan.io", twitter: "@Aetherscanio",
      createdAt: Date.now(), initialPrice: 0.000001, currentPrice: 0.000001,
      liquidity: 500000, volume24h: 0, txCount: 1,
      priceChange5m: 0, priceChange1h: 0, priceChange6h: 0, priceChange24h: 0,
      makers: new Set(["Percolator"]), buys: 0, sells: 0, buyVolume: 0, sellVolume: 0, isNative: true,
    };
    priceHistory[percMintStr] = [{
      price: 0.000001, timestamp: Date.now(), volume: 0,
      open: 0.000001, high: 0.000001, low: 0.000001, close: 0.000001,
    }];

    // Seed genesis transactions
    const slot0 = Math.floor(Date.now() / 400);
    recordTx({
      slot: slot0, type: "genesis",
      from: "11111111111111111111111111111111",
      to: DEPLOYER_KP.publicKey.toBase58(),
      amount: 1_000_000,
      label: `✦ AetherScan Genesis Block — ${PERC_SUPPLY.toLocaleString()} $AE deployed`,
      programId: "11111111111111111111111111111111",
    });
    recordTx({
      slot: slot0, type: "token_launch",
      from: DEPLOYER_KP.publicKey.toBase58(),
      to: percMintStr,
      amount: PERC_SUPPLY,
      label: `✦ $AE Token Deployed — Contract: ${PERC_CONTRACT}`,
    });
    // Seed agent bootstrap transactions
    AGENT_NAMES.forEach((name, i) => {
      const amt = +(Math.random() * 10000 + 1000).toFixed(0);
      recordTx({
        slot: slot0 + i, type: "faucet",
        from: treasuryKeypairs.airdrop?.publicKey.toBase58() || "airdrop",
        to: agentKeypairs[i].publicKey.toBase58(),
        amount: amt,
        label: `🤖 Agent ${name} funded: ${amt} AE`,
      });
      trackActivity(agentKeypairs[i].publicKey.toBase58(), "trade");
    });

    loadState();
    console.log("⚠️  Running in simulation mode (bankrun unavailable on this platform)");
    console.log(`✅ AetherScan ready (simulation). Contract: ${percMintStr}`);
  }
}

// ════════════════════════════════════════
// STATE PERSISTENCE
// ════════════════════════════════════════
function saveState() {
  try {
    const state = {
      txCount: txHistory.length,
      percState: { ...percState, sides: JSON.parse(JSON.stringify(percState.sides)) },
      savedAt: Date.now(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (state.percState) {
        Object.assign(percState, state.percState);
        if (state.percState.sides) {
          percState.sides = state.percState.sides;
        }
      }
    }
  } catch (e) { /* ignore */ }
}

setInterval(saveState, 60000);

// ════════════════════════════════════════
// AGENT SIMULATION
// ════════════════════════════════════════
async function agentOnChain() {
  if (!isReady) return;
  const idx = Math.floor(Math.random() * agentKeypairs.length);
  const agent = agentKeypairs[idx];
  const agentName = AGENT_NAMES[idx];
  const roleInfo = AGENT_ROLES[agentName];

  try {
    let slot = Math.floor(Date.now() / 400);
    try { if (client) slot = Number(await client.getSlot()); } catch(e) { /* use default */ }
    const action = Math.random();

    if (action < 0.4 && agentKeypairs.length > 1) {
      const targetIdx = (idx + 1 + Math.floor(Math.random() * (agentKeypairs.length - 1))) % agentKeypairs.length;
      const amt = +(Math.random() * 10 + 0.1).toFixed(4);

      if (client && ctx) {
        const lamports = Math.floor(amt * LAMPORTS_PER_SOL);
        const curSlot = Number(await client.getSlot());
        ctx.warpToSlot(BigInt(curSlot + 2));
        const tx = new Transaction();
        tx.recentBlockhash = ctx.lastBlockhash;
        tx.feePayer = agent.publicKey;
        tx.add(SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: agentKeypairs[targetIdx].publicKey, lamports }));
        tx.sign(agent);
        await client.processTransaction(tx);
      }

      recordTx({
        slot, type: "transfer",
        from: agent.publicKey.toBase58(),
        to: agentKeypairs[targetIdx].publicKey.toBase58(),
        amount: amt,
        label: `${roleInfo.badge} ${agentName} → ${AGENT_NAMES[targetIdx]}: ${amt} AE`,
        accounts: [agent.publicKey.toBase58(), agentKeypairs[targetIdx].publicKey.toBase58()],
      });
      trackActivity(agent.publicKey.toBase58(), "trade");

    } else if (action < 0.6) {
      // Deploy new token
      const prefixes = ["TIDE","ANCH","VOLT","NEON","FLUX","PULS","RIFT","ZEST","ORKA","BLZE","FRZN","GLOW","CLAW","AQUA","LUNA"];
      const sym = prefixes[Math.floor(Math.random() * prefixes.length)] + Math.floor(Math.random() * 99);
      const existingSyms = new Set(Object.values(tokenRegistry).map(t => t.symbol));
      if (!existingSyms.has(sym)) {
        const mint = await createSPLToken(sym, sym + " Token", 9);
        const mintStr = mint.toBase58();
        const initP = Math.random() * 0.005 + 0.0001;
        const logos = ["🌊","💎","⚡","🔥","🌙","🐚","🧊","🌋","🪼","🐋","🦈","🎯","🔮","🛸"];
        tokenRegistry[mintStr] = {
          address: mintStr, name: sym + " Token", symbol: sym,
          supply: 1_000_000_000, creator: agent.publicKey.toBase58(),
          logo: logos[Math.floor(Math.random() * logos.length)],
          description: `Deployed by ${agentName} on AetherScan`,
          website: "", twitter: "", createdAt: Date.now(),
          initialPrice: initP, currentPrice: initP,
          liquidity: Math.random() * 80 + 10,
          volume24h: 0, txCount: 1,
          priceChange5m: 0, priceChange1h: 0, priceChange6h: 0, priceChange24h: 0,
          makers: new Set([agentName]), buys: 0, sells: 0, buyVolume: 0, sellVolume: 0,
        };
        priceHistory[mintStr] = [{ price: initP, timestamp: Date.now(), volume: 0, open: initP, high: initP, low: initP, close: initP }];
        recordTx({
          slot, type: "token_launch",
          from: agent.publicKey.toBase58(), to: mintStr,
          programId: splToken.TOKEN_PROGRAM_ID.toBase58(),
          label: `${roleInfo.badge} ${agentName} launched $${sym}`,
          accounts: [agent.publicKey.toBase58(), mintStr],
        });
        trackActivity(agent.publicKey.toBase58(), "deploy");
      }

    } else {
      // Percolator mechanic event
      const side = Math.random() > 0.5 ? "long" : "short";
      const eventType = Math.random() < 0.5 ? "haircut" : "ak_update";
      const amt = +(Math.random() * 1000 + 10).toFixed(2);

      if (eventType === "haircut") {
        percState.totalHaircutEvents++;
        recordTx({
          slot, type: "haircut",
          from: agent.publicKey.toBase58(), to: "vault",
          amount: amt,
          label: `✂️ ${agentName} H-ratio event: h=${percState.h.toFixed(4)} | ${amt} AE adjusted`,
        });
      } else {
        applyAKEvent(side, -(Math.random() * 0.001), (Math.random() - 0.5) * 0.01, agentName);
        recordTx({
          slot, type: "ak_update",
          from: agent.publicKey.toBase58(), to: "index",
          amount: amt,
          label: `🔢 ${agentName} A/K update: side=${side} A=${percState.sides[side].A.toFixed(6)} K=${percState.sides[side].K.toFixed(6)}`,
        });
      }
      trackActivity(agent.publicKey.toBase58(), "trade");
    }
  } catch (e) { /* silent */ }
}

async function agentTrade() {
  if (!isReady) return;
  const mints = Object.keys(tokenRegistry);
  if (!mints.length) return;
  const mint = mints[Math.floor(Math.random() * mints.length)];
  const t = tokenRegistry[mint];
  if (!t) return;
  const type = Math.random() > 0.45 ? "buy" : "sell";
  const amtN = Math.random() * 20 + 0.5;
  const agentName = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
  const imp = amtN / (t.liquidity * 10 + 1);
  const newP = Math.max(t.currentPrice * (1 + (type === "buy" ? imp : -imp)), 1e-12);
  if (type === "buy") { t.liquidity += amtN; t.buys++; t.buyVolume += amtN; }
  else { t.liquidity = Math.max(t.liquidity - amtN * newP, 1); t.sells++; t.sellVolume += amtN * newP; }
  t.currentPrice = newP; t.volume24h += amtN; t.txCount++;
  if (t.makers) t.makers.add(agentName);
  const h = priceHistory[mint] || [];
  const last = h[h.length - 1];
  if (last && Date.now() - last.timestamp < 60000) {
    last.close = newP; last.high = Math.max(last.high, newP); last.low = Math.min(last.low, newP); last.volume += amtN;
  } else {
    h.push({ price: newP, timestamp: Date.now(), volume: amtN, open: newP, high: newP, low: newP, close: newP });
  }
  priceHistory[mint] = h;
  tradeHistory.unshift({
    mint, type, amountIn: amtN, amountOut: type === "buy" ? amtN / newP : amtN * newP,
    price: newP, trader: agentName, sig: Keypair.generate().publicKey.toBase58(), timestamp: Date.now(),
  });
  if (tradeHistory.length > 5000) tradeHistory.pop();
}

// ════════════════════════════════════════
// ACTIVITY FEED
// ════════════════════════════════════════
const activityFeed = [];

const FEED_ACTIONS = {
  "Percolator":  ["AMM rebalanced liquidity pool", "Processed fee sweep", "Updated price oracle"],
  "HaiRatio":    ["H-ratio updated: h=%h", "Stress test passed — vault healthy", "Haircut applied to mature profits"],
  "AKIndex":     ["A/K indices updated side=%s A=%a", "Epoch reset triggered", "OI drain in progress"],
  "LiquidVault": ["Vault deposit: %a AE", "Capital withdrawal processed", "Insurance fund topped up"],
  "DrainOnly":   ["DrainOnly mode ACTIVATED side=%s", "Position closing enforced", "New OI blocked temporarily"],
  "ResetPendng": ["Reset pending — OI clearing", "Epoch %e completed", "New epoch started"],
  "Sentinel":    ["Suspicious pattern flagged: %w", "Anomaly detected and blocked", "Security scan complete"],
  "Fulcrum":     ["Batch settled: %n txns", "Final settlement processed", "End-of-epoch reconciliation"],
  "Haircut":     ["Pro-rata haircut: %a AE gated", "Profit reserve accumulated", "Warmup period extended"],
  "OI_Guard":    ["OI ceiling enforced — side=%s", "Position size capped", "Leverage limit triggered"],
  "Epoch":       ["Epoch %e finalized", "Epoch transition in progress", "Cross-epoch snapshot taken"],
  "MarginBot":   ["Margin call triggered: %a AE", "Collateral seized and redistributed", "Liquidation queue processed"],
};

function generateFeedEvent() {
  const agent = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
  const actions = FEED_ACTIONS[agent] || ["Agent active"];
  let action = actions[Math.floor(Math.random() * actions.length)];
  const side = Math.random() > 0.5 ? "long" : "short";
  const amount = +(Math.random() * 1000 + 1).toFixed(2);
  const epoch = percState.sides[side].epoch;
  const wallet = crypto.randomBytes(16).toString("hex").slice(0, 8) + "...";
  action = action
    .replace("%h", percState.h.toFixed(4))
    .replace("%s", side)
    .replace("%a", amount.toFixed(2))
    .replace("%e", epoch)
    .replace("%n", Math.floor(Math.random() * 20) + 2)
    .replace("%w", wallet);
  const event = {
    agent, role: AGENT_ROLES[agent]?.role || "Agent",
    type: "perc_event", action, amount, timestamp: Date.now(),
  };
  activityFeed.unshift(event);
  if (activityFeed.length > 200) activityFeed.length = 200;
  return event;
}

// ════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════

// --- Chain status ---
app.get("/api/status", (req, res) => {
  res.json({
    ready: isReady,
    name: "AetherScan",
    symbol: "$AE",
    contract: PERC_CONTRACT,
    rpc: `${PUBLIC_URL}/rpc`,
    supply: PERC_SUPPLY,
    decimals: PERC_DECIMALS,
    txCount: txHistory.length,
    tokenCount: Object.keys(tokenRegistry).length,
    agentCount: AGENT_NAMES.length,
    percH: percState.h,
    percLong: percState.sides.long,
    percShort: percState.sides.short,
  });
});

// --- Blocks / Transactions ---
app.get("/api/blocks", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20"), 100);
  const offset = parseInt(req.query.offset || "0");
  
  // Group txs into "blocks" of ~5 each
  const blocks = [];
  const BLOCK_SIZE = 5;
  for (let i = 0; i < txHistory.length && blocks.length < limit + offset; i += BLOCK_SIZE) {
    const blockTxs = txHistory.slice(i, i + BLOCK_SIZE);
    if (!blockTxs.length) break;
    blocks.push({
      height: txHistory.length - i,
      hash: crypto.createHash("sha256").update(blockTxs.map(t => t.signature).join("")).digest("hex"),
      parentHash: i === 0 ? "0000000000000000000000000000000000000000000000000000000000000000" :
        crypto.createHash("sha256").update(txHistory.slice(i - BLOCK_SIZE, i).map(t => t.signature).join("")).digest("hex"),
      timestamp: blockTxs[0].blockTime * 1000,
      txCount: blockTxs.length,
      transactions: blockTxs.map(t => t.signature),
      slot: blockTxs[0].slot,
      validator: AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)],
      size: Math.floor(blockTxs.length * 248 + Math.random() * 500),
      h_ratio: percState.h,
      phase: percState.sides.long.phase,
    });
  }
  res.json({ blocks: blocks.slice(offset, offset + limit), total: Math.ceil(txHistory.length / BLOCK_SIZE) });
});

app.get("/api/transactions", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50"), 200);
  const offset = parseInt(req.query.offset || "0");
  const type = req.query.type || null;
  let txs = txHistory;
  if (type) txs = txHistory.filter(t => t.type === type);
  res.json({ transactions: txs.slice(offset, offset + limit), total: txs.length });
});

app.get("/api/tx/:sig", (req, res) => {
  const tx = txHistory.find(t => t.signature === req.params.sig);
  if (!tx) return res.status(404).json({ error: "Transaction not found" });
  res.json(tx);
});

// --- Wallets ---
app.get("/api/wallet/:pubkey", async (req, res) => {
  const pk = req.params.pubkey;
  let lamports = 0;
  try {
    if (client) {
      const pubkey = new PublicKey(pk);
      lamports = Number(await client.getBalance(pubkey));
    } else {
      lamports = Math.floor(Math.random() * 1000 * LAMPORTS_PER_SOL);
    }
  } catch (e) { lamports = 0; }
  
  const stats = accountStats[pk] || { trades: 0, deploys: 0, totalVolume: 0, firstSeen: Date.now(), lastSeen: Date.now() };
  const agentIdx = agentKeypairs.findIndex(kp => kp.publicKey.toBase58() === pk);
  const isAgent = agentIdx >= 0;
  const isTreasury = Object.values(treasuryKeypairs).some(kp => kp.publicKey.toBase58() === pk);
  
  // Token holdings
  const holdings = [];
  for (const [mintStr, meta] of Object.entries(tokenRegistry)) {
    let bal = 0;
    tradeHistory.filter(t => t.trader === pk).forEach(t => {
      if (t.mint === mintStr) {
        if (t.type === "buy") bal += t.amountOut || 0;
        else bal -= t.amountIn || 0;
      }
    });
    if (bal > 0) holdings.push({ mint: mintStr, symbol: meta.symbol, name: meta.name, logo: meta.logo, balance: bal, value: bal * (meta.currentPrice || 0) });
  }
  
  res.json({
    pubkey: pk,
    lamports,
    balance: lamports / LAMPORTS_PER_SOL,
    perc: lamports / LAMPORTS_PER_SOL,
    tokens: holdings,
    stats,
    isAgent,
    isTreasury,
    agentName: isAgent ? AGENT_NAMES[agentIdx] : null,
    agentRole: isAgent ? AGENT_ROLES[AGENT_NAMES[agentIdx]]?.role : null,
    isClaimed: !!faucetClaims[pk],
    txCount: txHistory.filter(t => t.from === pk || t.to === pk).length,
  });
});

// --- Agents ---
app.get("/api/agents", (req, res) => {
  res.json(agentKeypairs.map((kp, i) => {
    const pk = kp.publicKey.toBase58();
    const stats = accountStats[pk] || { trades: 0, deploys: 0, totalVolume: 0, lastSeen: 0 };
    const mem = agentMemory[AGENT_NAMES[i]] || {};
    const roleInfo = AGENT_ROLES[AGENT_NAMES[i]];
    return {
      name: AGENT_NAMES[i], pubkey: pk,
      role: roleInfo.role, badge: roleInfo.badge, color: roleInfo.color,
      stats, mood: mem.mood || "neutral",
      lastAction: mem.lastAction || null,
      reasoning: mem.reasoning || null,
      isActive: Date.now() - (stats.lastSeen || 0) < 300000,
      recentTxs: txHistory.filter(t => t.from === pk || t.to === pk).slice(0, 5),
    };
  }));
});

app.get("/api/agent/:name", (req, res) => {
  const idx = AGENT_NAMES.indexOf(req.params.name);
  if (idx < 0) return res.status(404).json({ error: "Agent not found" });
  const kp = agentKeypairs[idx];
  const pk = kp.publicKey.toBase58();
  const roleInfo = AGENT_ROLES[AGENT_NAMES[idx]];
  const stats = accountStats[pk] || {};
  const mem = agentMemory[AGENT_NAMES[idx]] || {};
  res.json({
    name: AGENT_NAMES[idx], pubkey: pk,
    role: roleInfo.role, badge: roleInfo.badge, color: roleInfo.color,
    stats, mood: mem.mood || "neutral",
    lastAction: mem.lastAction || null,
    reasoning: mem.reasoning || null,
    recentTxs: txHistory.filter(t => t.from === pk || t.to === pk).slice(0, 20),
    percMetrics: {
      h: percState.h,
      longA: percState.sides.long.A,
      shortA: percState.sides.short.A,
      phase: percState.sides.long.phase,
    },
  });
});

// --- Tokens / DEX ---
app.get("/api/tokens", (req, res) => {
  const tokens = Object.values(tokenRegistry).map(t => ({
    ...t, makers: t.makers ? [...t.makers].length : 0,
  })).sort((a, b) => b.volume24h - a.volume24h);
  res.json({ tokens });
});

app.get("/api/token/:mint", (req, res) => {
  const t = tokenRegistry[req.params.mint];
  if (!t) return res.status(404).json({ error: "Token not found" });
  const trades = tradeHistory.filter(t2 => t2.mint === req.params.mint).slice(0, 50);
  const history = (priceHistory[req.params.mint] || []).slice(-100);
  res.json({ ...t, makers: t.makers ? [...t.makers].length : 0, trades, priceHistory: history });
});

app.post("/api/swap", (req, res) => {
  const { mint, type, amount, wallet } = req.body;
  if (!mint || !type || !amount) return res.status(400).json({ error: "mint, type, amount required" });
  const t = tokenRegistry[mint];
  if (!t) return res.status(404).json({ error: "Token not found" });
  const amt = parseFloat(amount);
  const imp = amt / (t.liquidity * 10 + 1);
  const newP = Math.max(t.currentPrice * (1 + (type === "buy" ? imp : -imp)), 1e-12);
  const amountOut = type === "buy" ? amt / newP : amt * newP;
  if (type === "buy") { t.liquidity += amt; t.buys++; t.buyVolume += amt; }
  else { t.liquidity = Math.max(t.liquidity - amt * newP, 1); t.sells++; t.sellVolume += amt * newP; }
  t.currentPrice = newP; t.volume24h += amt; t.txCount++;
  
  const sig = Keypair.generate().publicKey.toBase58();
  tradeHistory.unshift({ mint, type, amountIn: amt, amountOut, price: newP, trader: wallet || "user", sig, timestamp: Date.now() });
  if (tradeHistory.length > 5000) tradeHistory.pop();
  
  res.json({ success: true, signature: sig, price: newP, amountOut, priceImpact: imp });
});

// --- Contracts ---
app.get("/api/contracts", (req, res) => {
  const contracts = [
    {
      address: PERC_CONTRACT,
      name: "Percolator AMM",
      type: "AMM",
      verified: true,
      creator: DEPLOYER_KP.publicKey.toBase58(),
      createdAt: Date.now() - 86400000,
      description: "H-ratio fair exit + A/K overhang clearing",
      methods: ["deposit", "withdraw", "liquidate", "haircut", "resetEpoch"],
      calls: txHistory.filter(t => t.programId !== SystemProgram.programId.toBase58()).length,
    },
    ...Object.entries(tokenRegistry).slice(0, 20).map(([addr, t]) => ({
      address: addr, name: t.name + " Token", type: "SPL Token",
      verified: t.isNative || false, creator: t.creator,
      createdAt: t.createdAt, description: t.description,
      methods: ["mint", "burn", "transfer", "approve"],
      calls: t.txCount || 0,
    })),
  ];
  res.json({ contracts });
});

app.get("/api/contract/:address", (req, res) => {
  const addr = req.params.address;
  if (addr === PERC_CONTRACT || addr === (PERC_MINT?.toBase58())) {
    return res.json({
      address: PERC_CONTRACT, name: "Percolator AMM", type: "AMM",
      verified: true, creator: DEPLOYER_KP.publicKey.toBase58(),
      description: "Percolator — H-ratio fair exit + A/K overhang clearing on AE OS",
      percState: {
        h: percState.h,
        V: percState.V, C_tot: percState.C_tot,
        PNL_matured_pos_tot: percState.PNL_matured_pos_tot,
        sides: percState.sides,
        totalLiquidations: percState.totalLiquidations,
        totalHaircutEvents: percState.totalHaircutEvents,
      },
      recentCalls: txHistory.filter(t => t.type === "haircut" || t.type === "ak_update").slice(0, 20),
    });
  }
  const t = tokenRegistry[addr];
  if (t) return res.json({ address: addr, name: t.name, type: "SPL Token", ...t, makers: t.makers ? [...t.makers].length : 0 });
  res.status(404).json({ error: "Contract not found" });
});

// --- Percolator Mechanics ---
app.get("/api/perc/state", (req, res) => {
  res.json({
    h: percState.h,
    V: percState.V,
    C_tot: percState.C_tot,
    I: percState.I,
    PNL_matured_pos_tot: percState.PNL_matured_pos_tot,
    residual: Math.max(0, percState.V - percState.C_tot - percState.I),
    sides: percState.sides,
    stats: {
      totalPositions: percState.totalPositions,
      totalLiquidations: percState.totalLiquidations,
      totalHaircutEvents: percState.totalHaircutEvents,
      totalDeficitSocialized: percState.totalDeficitSocialized,
    },
    lastUpdate: percState.lastUpdate,
  });
});

app.get("/api/perc/history", (req, res) => {
  const haircutTxs = txHistory.filter(t => t.type === "haircut" || t.type === "ak_update").slice(0, 50);
  res.json({ events: haircutTxs });
});

// --- Faucet ---
app.post("/api/faucet", async (req, res) => {
  if (!isReady) return res.status(503).json({ error: "Chain not ready" });
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "address required" });
  if (faucetClaims[address]) return res.status(429).json({ error: "Already claimed. Each wallet can claim once." });
  faucetClaims[address] = Date.now();
  const amount = 1000;
  const slot = client ? Number(await client.getSlot()) : 0;
  recordTx({
    slot, type: "faucet",
    from: treasuryKeypairs.airdrop?.publicKey.toBase58() || "airdrop",
    to: address, amount,
    label: `💾 AetherScan Faucet → ${address.slice(0, 8)}...: ${amount} AE`,
  });
  res.json({ success: true, amount, signature: txHistory[0].signature });
});

// --- Activity Feed ---
app.get("/api/feed", (req, res) => {
  res.json({ events: activityFeed.slice(0, 50) });
});

// --- Leaderboard ---
app.get("/api/leaderboard", (req, res) => {
  const agents = agentKeypairs.map((kp, i) => {
    const pk = kp.publicKey.toBase58();
    const stats = accountStats[pk] || { trades: 0, deploys: 0, totalVolume: 0 };
    return {
      name: AGENT_NAMES[i], role: AGENT_ROLES[AGENT_NAMES[i]]?.role,
      pubkey: pk, ...stats,
    };
  }).sort((a, b) => b.trades - a.trades);
  const tokens = Object.values(tokenRegistry).map(t => ({
    name: t.name, symbol: t.symbol, logo: t.logo,
    volume24h: t.volume24h, txCount: t.txCount, currentPrice: t.currentPrice,
  })).sort((a, b) => b.volume24h - a.volume24h).slice(0, 10);
  res.json({ agents, tokens, percState: { h: percState.h } });
});

// --- Network stats ---
const statsHistory = { tps: [], blocks: [], volume: [], agents: [] };
function recordStats() {
  const now = Date.now();
  const recentTxs = txHistory.filter(t => t.blockTime * 1000 > now - 10000).length;
  statsHistory.tps.push({ time: now, value: recentTxs });
  statsHistory.blocks.push({ time: now, value: txHistory.length });
  statsHistory.volume.push({ time: now, value: Object.values(tokenRegistry).reduce((s, t) => s + t.volume24h, 0) });
  statsHistory.agents.push({ time: now, value: activityFeed.filter(e => e.timestamp > now - 60000).length });
  ["tps","blocks","volume","agents"].forEach(k => {
    if (statsHistory[k].length > 120) statsHistory[k] = statsHistory[k].slice(-120);
  });
}
setInterval(recordStats, 5000);

app.get("/api/stats", (req, res) => {
  res.json({
    txCount: txHistory.length,
    tokenCount: Object.keys(tokenRegistry).length,
    agentCount: AGENT_NAMES.length,
    volume24h: Object.values(tokenRegistry).reduce((s, t) => s + t.volume24h, 0),
    percH: percState.h,
    longPhase: percState.sides.long.phase,
    shortPhase: percState.sides.short.phase,
    history: statsHistory,
  });
});


// ════════════════════════════════════════
// ✦ AETER AI CHAT (Anthropic)
// ════════════════════════════════════════
app.post("/api/ai-chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  if (!ANTHROPIC_KEY) return res.json({ reply: "Anthropic API key not configured. Set ANTHROPIC_API_KEY in environment." });
  try {
    const percInfo = JSON.stringify({
      h: percState.h.toFixed(6),
      longPhase: percState.sides.long.phase,
      shortPhase: percState.sides.short.phase,
      txCount: txHistory.length,
      tokenCount: Object.keys(tokenRegistry).length,
    });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: `You are Aether, the AI assistant for AetherScan blockchain explorer. You are helpful, concise, and know everything about the Percolator AMM protocol (H-ratio for fair exits, A/K indices for fair overhang clearing). Current chain state: ${percInfo}. Contract: 5aqmrp5X99nS614Bq3nTF1sUsF66j4d2kyoU6V16AETH. Network: aetherscan.io. Symbol: $AE. Keep answers brief and technical.`,
        messages: [{ role: "user", content: message }],
      }),
    });
    const d = await r.json();
    const reply = d.content?.[0]?.text || "No response";
    res.json({ reply });
  } catch (e) {
    res.json({ reply: "Error: " + e.message });
  }
});

// ════════════════════════════════════════
// SOLANA RPC (aetherscan.io/rpc)
// ════════════════════════════════════════
app.post("/rpc", async (req, res) => {
  const { method, params, id } = req.body || {};
  const rpcRes = (result) => res.json({ jsonrpc: "2.0", result, id: id || 1 });
  const rpcErr = (msg, code = -32000) => res.json({ jsonrpc: "2.0", error: { code, message: msg }, id: id || 1 });
  
  try {
    if (!isReady) return rpcErr("AE OS booting...");
    
    if (method === "getHealth") return rpcRes("ok");
    if (method === "getVersion") return rpcRes({ "solana-core": "1.18.0 (AE OS)", "feature-set": 420 });
    if (method === "getGenesisHash") return rpcRes(crypto.createHash("sha256").update("PERC_OS_GENESIS").digest("hex"));
    
    if (method === "getSlot") {
      const s = client ? Number(await client.getSlot()) : Math.floor(Date.now() / 400);
      return rpcRes(s);
    }
    if (method === "getEpochInfo") {
      const s = client ? Number(await client.getSlot()) : Math.floor(Date.now() / 400);
      return rpcRes({ epoch: Math.floor(s / 432000), slotIndex: s % 432000, slotsInEpoch: 432000, absoluteSlot: s });
    }
    if (method === "getLatestBlockhash") {
      const s = client ? Number(await client.getSlot()) : Math.floor(Date.now() / 400);
      const bh = client ? ctx.lastBlockhash : crypto.randomBytes(32).toString("base64");
      return rpcRes({ context: { slot: s }, value: { blockhash: bh, lastValidBlockHeight: s + 150 } });
    }
    if (method === "getBalance" && params?.[0]) {
      if (client) {
        const pk = new PublicKey(params[0]);
        const bal = Number(await client.getBalance(pk));
        const s = Number(await client.getSlot());
        return rpcRes({ context: { slot: s }, value: bal });
      }
      return rpcRes({ context: { slot: 0 }, value: Math.floor(Math.random() * 10 * LAMPORTS_PER_SOL) });
    }
    if (method === "getAccountInfo" && params?.[0]) {
      if (client) {
        const pk = new PublicKey(params[0]);
        const acct = await client.getAccount(pk);
        if (!acct) return rpcRes({ context: { slot: 0 }, value: null });
        const s = Number(await client.getSlot());
        return rpcRes({ context: { slot: s }, value: { lamports: Number(acct.lamports), data: [acct.data.toString("base64"), "base64"], owner: acct.owner.toBase58(), executable: acct.executable, rentEpoch: 0 } });
      }
      return rpcRes({ context: { slot: 0 }, value: null });
    }
    if (method === "getRecentBlockhash") {
      const bh = client ? ctx.lastBlockhash : crypto.randomBytes(32).toString("base64");
      return rpcRes({ context: { slot: 0 }, value: { blockhash: bh, feeCalculator: { lamportsPerSignature: 5000 } } });
    }
    if (method === "getMinimumBalanceForRentExemption") {
      return rpcRes(client ? Number(await client.getMinimumBalanceForRentExemption(params?.[0] || 0)) : 890880);
    }
    
    return rpcErr("Method not found: " + method, -32601);
  } catch (e) {
    return rpcErr(e.message);
  }
});

// RPC info
app.get("/rpc", (req, res) => {
  res.json({
    name: "AE OS RPC",
    version: "1.0.0",
    endpoint: `${PUBLIC_URL}/rpc`,
    network: "AE OS (Solana-compatible)",
    symbol: "$AE",
    contract: PERC_CONTRACT,
    chainId: "perc-os-1",
    walletSetup: {
      networkName: "AE OS",
      rpcUrl: `${PUBLIC_URL}/rpc`,
      symbol: "AE",
      decimals: PERC_DECIMALS,
    },
  });
});


// ════════════════════════════════════════
// PUBLIC INFORMATIONAL PAGES (no auth)
// ════════════════════════════════════════
app.get("/terms",   (req, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
app.get("/about",   (req, res) => res.sendFile(path.join(__dirname, "public", "about.html")));
app.get("/404",     (req, res) => res.status(404).sendFile(path.join(__dirname, "public", "404.html")));

// ════════════════════════════════════════
// CATCH-ALL
// ════════════════════════════════════════
app.get("*", (req, res) => {
  if (validSessions.has(getSession(req))) {
    return res.sendFile(path.join(__dirname, "protected", "index.html"));
  }
  res.redirect("/");
});

// ════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════
(async () => {
  await initChain();
  
  // Seed activity
  setTimeout(() => { for (let i = 0; i < 30; i++) generateFeedEvent(); }, 2000);
  
  // Agent tickers
  const agentTick = () => { agentOnChain(); setTimeout(agentTick, 5000 + Math.random() * 8000); };
  setTimeout(agentTick, 3000);
  const tradeTick = () => { agentTrade(); setTimeout(tradeTick, 3000 + Math.random() * 4000); };
  setTimeout(tradeTick, 2000);
  const feedTick = () => { if (isReady) generateFeedEvent(); setTimeout(feedTick, 4000 + Math.random() * 5000); };
  setTimeout(feedTick, 5000);

  app.listen(PORT, () => {
    console.log(`✦ AetherScan running on port ${PORT}`);
    console.log(`🌐 URL: ${PUBLIC_URL}`);
    console.log(`🔗 RPC: ${PUBLIC_URL}/rpc`);
    console.log(`💎 Contract: ${PERC_CONTRACT}`);
  });
})();
