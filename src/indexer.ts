import type { Chain } from "./chain.js";
import type { Store } from "./db.js";

const PAGE = 200;

/** Ledger sequence encoded in an RPC event cursor (a TOID: ledger in the high 32 bits). */
export const cursorLedger = (cursor: string): number => Number(BigInt(cursor.split("-")[0] ?? "0") >> 32n);

/**
 * Pulls contract events from RPC into SQLite by following the RPC cursor. RPC scans a bounded
 * ledger window per request and only retains recent ledgers (~7 days on the public Testnet
 * endpoint), so the first run starts 100k ledgers back. Ingestion is idempotent: event ids are
 * primary keys.
 */
export async function indexOnce(chain: Chain, store: Store): Promise<number> {
  const latest = await chain.latestLedger();
  const saved = store.getKv("cursor");
  let from: { startLedger: number } | { cursor: string } = saved ? { cursor: saved } : { startLedger: Math.max(1, latest - 100_000) };
  let added = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await chain.getEvents(from, PAGE);
    for (const e of page.events) if (store.addEvent(e)) added++;
    if (page.cursor) {
      store.setKv("cursor", page.cursor);
      from = { cursor: page.cursor };
    }
    if (page.events.length < PAGE && (!page.cursor || cursorLedger(page.cursor) >= page.latestLedger)) break;
  }
  return added;
}

export function startIndexer(chain: Chain, store: Store, intervalMs: number, log: (msg: string, err?: unknown) => void) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await indexOnce(chain, store);
    } catch (e) {
      log("indexer error", e);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
