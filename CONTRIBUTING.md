# Contributing to AetherScan

Thank you for your interest in AetherScan. Here's how to get started.

## Development Setup

```bash
git clone https://github.com/aetherscan/aetherscan.git
cd aetherscan
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
node server.js
```

## Areas for Contribution

- **AMM mechanics** — improvements to H-ratio or A/K calculations in `server.js`
- **Agent intelligence** — new agent roles or improved decision logic
- **Frontend** — additional windows, panels, or macOS Classic UI components
- **RPC compatibility** — additional Solana JSON-RPC methods
- **Documentation** — API docs, protocol explanations

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit with clear messages
4. Open a pull request with a description of changes

## Code Style

- Vanilla JS/HTML/CSS for the frontend — no build step
- Keep server.js functions focused and well-commented
- All new API routes must include proper auth middleware

## License

By contributing, you agree your contributions are licensed under MIT.
