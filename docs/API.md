# Backend API

Base `http://localhost:8787`. JSON. Rate limit 120 req/min/IP by default. CORS limited to `CORS_ORIGIN`. Fields under `onChain` come from contract simulation via RPC; `offChain` is backend-stored and organizer-signed.

| Endpoint | Description |
|---|---|
| `GET /health` | liveness, network, contract id |
| `GET /api/config` | `{network, rpcUrl, networkPassphrase, contractId, tokenContractId, tokenSymbol}`: everything a client (e.g. the web app) needs to build and send contract transactions |
| `GET /api/circles?limit=20` | newest circles `{count, circles:[{id,onChain,offChain}]}` |
| `GET /api/circles/:id` | one circle, 404 `circle_not_found` |
| `GET /api/circles/:id/events` | indexed contract events (history; not authoritative state) |
| `GET /api/members/:address/circles` | circle ids the address joined (from indexed events) |
| `PUT /api/circles/:id/meta` | `{name<=80, description<=500, timestamp, signature}`; signature = hex ed25519 by the circle's organizer over `ajo-circle:meta:v1\n<contract>\n<id>\n<ts>\n<name>\n<description>`; timestamp within 300 s and strictly newer than stored (replay protection) |
| `POST /api/transactions/verify` | `{hash}`; looks the hash up on RPC, records only events RPC attributes to this contract; idempotent. Returns `SUCCESS` / `FAILED` / 404 `NOT_FOUND` |

Errors: `{error: "validation_error", issues:[...]}` (400), `bad_signature` (403), `stale_update` (409), `internal_error` (500, details only in logs).

Persistence: SQLite (`node:sqlite`), tables `events`, `circle_meta`, `kv` created idempotently at startup (`CREATE ... IF NOT EXISTS`). Schema changes must be additive migrations appended to `MIGRATIONS` in `src/db.ts`. The database holds no chain truth and can be deleted and re-indexed (within RPC retention).
