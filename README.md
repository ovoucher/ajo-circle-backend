# Ajo Circle: API

TypeScript (Fastify) service that reads and indexes the **Ajo Circle** Soroban contract on Stellar Testnet. Testnet only. Unaudited.

This repo is self-contained. It talks to the deployed contract only through Stellar RPC, and it serves the Ajo Circle web app over HTTP. It holds **no keys and never signs or submits transactions**: users sign in their own wallet.

## What it does

- **Authoritative reads:** circle state is read live from the contract via RPC simulation (`onChain`).
- **Event index:** follows the RPC event cursor and stores contract events in SQLite, so the UI can show history and a member's circles (RPC only keeps ~7 days).
- **Transaction verification:** `POST /api/transactions/verify` re-fetches a hash from RPC and records only events RPC attributes to the contract. Idempotent; client input is never trusted.
- **Off-chain circle names:** only the on-chain organizer can set them, proven by an ed25519 signature (timestamp window + monotonic updates to stop replays).
- **Client config:** `GET /api/config` gives clients the contract id, token id, RPC URL and network passphrase, so clients need only this API's URL.

## Requirements

Node >= 22.5 (uses built-in `node:sqlite`), a deployed Ajo Circle contract id on Testnet, and network access to a Soroban RPC.

## Run

```bash
npm ci
cp .env.example .env        # set AJO_CONTRACT_ID
npm run start:env           # http://127.0.0.1:8787
curl localhost:8787/api/config
curl localhost:8787/api/circles
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `AJO_CONTRACT_ID` | required | `C...` contract id (validated) |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | |
| `TOKEN_CONTRACT_ID` / `TOKEN_SYMBOL` | native XLM contract / `XLM` | token circles use; passed to clients |
| `DATABASE_PATH` | `./data/ajo.sqlite` | safe to delete; re-indexes within RPC retention |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated allowed origins |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | |
| `INDEX_INTERVAL_MS` | `10000` | |
| `RATE_LIMIT_PER_MINUTE` | `120` | per IP |

`STELLAR_NETWORK` only accepts `testnet`; mainnet is refused on purpose. No secrets are needed or read.

## Develop and test

```bash
npm run typecheck && npm run lint && npm test   # 17 tests, chain mocked with a fake
```
Last run: 17 passed, tsc and eslint clean, `npm audit --omit=dev`: 0 vulnerabilities. Also smoke-tested against live Testnet: the indexer ingested all 11 events of the demo circle. Coverage not measured.

## Docs

[API reference](docs/API.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md)

## Contract dependency

Relies on contract ABI v0.1: methods `get_circle` and `circle_count`, and event names/topics (`circle_created, joined, started, contributed, slashed, round_settled, completed, cancelled, claimed`; topic 1 = circle id, topic 2 = round where relevant). Pair with the contract repo version that publishes that ABI.

## Contributing / License

Small, tested PRs welcome. MIT, see [LICENSE](LICENSE).
