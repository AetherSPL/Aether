<div align="center">

<img src=".github/banner.svg" alt="AetherScan" width="100%"/>

<br/><br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-c9a84c.svg?style=for-the-badge&labelColor=0a0a08)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-c9a84c?style=for-the-badge&labelColor=0a0a08&logo=node.js&logoColor=c9a84c)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Compatible-c9a84c?style=for-the-badge&labelColor=0a0a08&logo=solana&logoColor=c9a84c)](https://solana.com)
[![Deploy](https://img.shields.io/badge/Deploy-Render-c9a84c?style=for-the-badge&labelColor=0a0a08)](https://render.com)
[![Explorer](https://img.shields.io/badge/Explorer-aetherscan.io-c9a84c?style=for-the-badge&labelColor=0a0a08)](https://aetherscan.io)

<br/>

```
AETHERSCAN — Blockchain Explorer
$AE · ubpAAKjMUpgnRXrSo1AXcaDXB58BndgqwCgSfSgJCAE · aetherscan.io
```

**[aetherscan.io](https://aetherscan.io)** · **[aetherscan.io/rpc](https://aetherscan.io/rpc)** · **[$AE on Solscan](https://solscan.io/token/ubpAAKjMUpgnRXrSo1AXcaDXB58BndgqwCgSfSgJCAE)**

</div>

---

## Overview

AetherScan is a Solana-compatible blockchain explorer and autonomous trading network built on the **Percolator AMM** — a protocol that permanently resolves the two fundamental fairness problems in every perpetuals exchange.

The interface is a dark, minimalist explorer — typography-first design using Cormorant Garamond for display, Outfit for UI, and JetBrains Mono for data. Clean. Fast. Precise.

---

## The Protocol

### Problem 1 — Exit Fairness

> *When the vault is stressed, who gets paid and how much?*

```
Residual  = max(0, V - C_tot - I)

              min(Residual, PNL_matured)
    h     =  ─────────────────────────
                    PNL_matured
```

| h | State | Effect |
|---|---|---|
| `1.000` | Fully backed | 100% withdrawable |
| `0.750` | Mild stress | 25% haircut — equally distributed |
| `0.400` | High stress | 60% haircut — equally distributed |
| Rising | Self-healing | Automatic as residual recovers |

Capital is always senior. H only gates profit.

### Problem 2 — Overhang Clearing

> *How does the market absorb a bankrupt position?*

Two global coefficients per side replace the entire liquidation queue:

```
effective_pos(i) = floor(basis_i × A / a_basis_i)
pnl_delta(i)     = floor(|basis_i| × (K − k_snap_i) / (a_basis_i × POS_SCALE))
```

**Result: O(1) settlement per account. Fully order-independent.**

```
Normal ──[A drops]──► DrainOnly ──[OI=0]──► ResetPending ──[settled]──► Normal
                                                    A→1, K→0, Epoch++
```

---

## Network

| | |
|---|---|
| **Token** | `$AE` |
| **Contract** | `ubpAAKjMUpgnRXrSo1AXcaDXB58BndgqwCgSfSgJCAE` |
| **Supply** | 1,000,000,000 AE |
| **Explorer** | [aetherscan.io](https://aetherscan.io) |
| **RPC** | `https://aetherscan.io/rpc` |

### Wallet Setup

```
Network:  AetherScan
RPC URL:  https://aetherscan.io/rpc
Symbol:   AE
Decimals: 9
```

### RPC

```bash
curl -X POST https://aetherscan.io/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

curl -X POST https://aetherscan.io/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["ADDRESS"]}'
```

---

## Architecture

```
aetherscan.io
│
├── Explorer UI
│   ├── Dashboard — live stats, latest transactions, feed
│   ├── Blocks — paginated, clickable to detail
│   ├── Transactions — filterable, full detail with tx flow diagram
│   ├── Accounts — wallet search + wallet profiles
│   ├── Tokens — DEX, buy/sell pressure, trade history
│   └── Agents — 12 autonomous AI agents
│
├── Percolator AMM
│   ├── H-ratio — fair exit mechanism
│   ├── A/K index — O(1) overhang clearing
│   └── Normal / DrainOnly / ResetPending state machine
│
├── Tools
│   ├── Terminal — Solana JSON-RPC console
│   ├── Faucet — 1,000 $AE per address
│   └── Aether AI — Claude-powered chain assistant
│
└── API — 30+ REST endpoints + /rpc
```

---

## The 12 Agents

| Agent | Role |
|---|---|
| Percolator | AMM Engine |
| HaiRatio | H-Ratio Oracle |
| AKIndex | A/K Index Tracker |
| LiquidVault | Vault Manager |
| DrainOnly | Drain Phase Guard |
| ResetPendng | Epoch Reset Engine |
| Sentinel | Fraud Detection |
| Fulcrum | Settlement Engine |
| Haircut | Profit Haircut Calculator |
| OI_Guard | Open Interest Guard |
| Epoch | Epoch Coordinator |
| MarginBot | Margin Engine |

---

## API

```bash
TOKEN=$(curl -s -X POST https://aetherscan.io/api/auth | jq -r .token)

curl https://aetherscan.io/api/status         -H "x-session: $TOKEN"
curl "https://aetherscan.io/api/blocks?limit=20" -H "x-session: $TOKEN"
curl "https://aetherscan.io/api/transactions"  -H "x-session: $TOKEN"
curl https://aetherscan.io/api/perc/state      -H "x-session: $TOKEN"
curl https://aetherscan.io/api/agents          -H "x-session: $TOKEN"
curl https://aetherscan.io/api/tokens          -H "x-session: $TOKEN"
curl https://aetherscan.io/api/wallet/ADDR     -H "x-session: $TOKEN"

curl -X POST https://aetherscan.io/api/faucet \
  -H "x-session: $TOKEN" -H "Content-Type: application/json" \
  -d '{"address":"YOUR_ADDR"}'

curl -X POST https://aetherscan.io/api/ai-chat \
  -H "x-session: $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"What is the current H-ratio?"}'
```

---

## Quick Start

```bash
git clone https://github.com/aetherscan/aetherscan.git
cd aetherscan
npm install
node server.js
```

Open `http://localhost:3000`

### Environment

```env
PORT=3000
PUBLIC_URL=https://aetherscan.io
DATA_DIR=/data
ANTHROPIC_API_KEY=sk-ant-...
```

### Deploy to Render

`render.yaml` included — push to GitHub, connect on render.com, add `ANTHROPIC_API_KEY` as secret, set custom domain `aetherscan.io`.

---

## Stack

| | |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Blockchain | `solana-bankrun` |
| AI Agents | Anthropic Claude |
| Fonts | Cormorant Garamond · Outfit · JetBrains Mono |
| Deploy | Render.com |

---

## License

[MIT](LICENSE) — AetherScan 2025

---

<div align="center">

**AETHERSCAN · $AE · [aetherscan.io](https://aetherscan.io)**

`ubpAAKjMUpgnRXrSo1AXcaDXB58BndgqwCgSfSgJCAE`

</div>
