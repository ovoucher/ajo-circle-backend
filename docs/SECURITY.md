# Backend security

**Unaudited, Testnet only.**

| Threat | Mitigation |
|---|---|
| Forged transaction claims | `/api/transactions/verify` re-fetches the hash from RPC; only RPC-attributed contract events are stored; duplicate calls are no-ops |
| Stale or spoofed state | circle state is a fresh contract simulation, not the database |
| Metadata forgery or replay | ed25519 signature by the on-chain organizer over a message that binds contract, circle id, timestamp, name and description; 300 s window; strictly newer timestamp required (409 otherwise) |
| Malformed input | zod schemas on params, query and body; 4 KB body limit |
| Abuse | `@fastify/rate-limit` (default 120/min/IP), CORS allow-list |
| Secret leakage | no keys or signing code; config holds only public ids/URLs; logs redact auth headers; 5xx responses hide details |
| Mainnet misuse | config schema accepts only `testnet` |
| Dependencies | lockfile committed, `npm audit --omit=dev` in CI (0 vulnerabilities at last run) |

## Known limitations
- Public RPC is a trust and availability dependency; a malicious RPC could lie. Use your own RPC for anything beyond Testnet.
- Rate limiting is per process and per IP (behind a proxy, configure trust settings).
- No authentication on read endpoints (all data is public on-chain).
- The signature scheme is a raw ed25519 signature over a custom message, not SEP-53 wallet message signing, so browser wallets cannot produce it yet.
- SQLite file is a single point of failure; it is rebuildable only within RPC retention.
