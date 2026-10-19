# Backend architecture

```
Web app --HTTP--> Fastify (src/app.ts) --Chain interface--> RpcChain (src/chain.ts) --> Stellar RPC --> Ajo contract
                       |                                         ^
                       +--> Store (src/db.ts, SQLite) <-- Indexer (src/indexer.ts)
```

- `config.ts` validates env with zod; refuses non-Testnet.
- `chain.ts` defines the `Chain` interface (latest ledger, circle count, circle by id, event page, tx events). `RpcChain` implements it with `@stellar/stellar-sdk`. Tests inject a fake, so no network is needed.
- Reads simulate contract calls with a throwaway source account; nothing is submitted.
- `indexer.ts` follows the RPC `cursor`. RPC scans a bounded ledger window per call, so stopping at an empty page loses events; the loop continues until the cursor's ledger (TOID >> 32) reaches the latest ledger. First run starts 100k ledgers back. Event ids are primary keys, so re-ingesting is a no-op.
- `app.ts` has routes, validation (zod), error mapping (internal details never reach clients), rate limiting, CORS.
- `db.ts` tables: `events`, `circle_meta`, `kv`. Migrations are idempotent `CREATE ... IF NOT EXISTS` statements in the `MIGRATIONS` array; add new entries at the end, never edit old ones.

## On-chain vs off-chain
Responses keep `onChain` (read from the contract) separate from `offChain` (names stored here, signed by the organizer). The event history is an index of on-chain events, not state; state always comes from the contract.

## Why a backend
RPC retains ~7 days of events and cannot list a member's circles. Core actions (join, pay, settle, claim) do not need this service; listing and history do.

## Limits
Single process, single SQLite file (no horizontal scaling). History is complete only from when the indexer first ran.
