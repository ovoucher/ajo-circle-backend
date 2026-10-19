import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChainEvent } from "./chain.js";

export interface MetaRow {
  circleId: number;
  name: string;
  description: string;
  signer: string;
  updatedAt: number;
}

/** Schema is created idempotently; see docs/ARCHITECTURE.md for the migration policy. */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY, ledger INTEGER NOT NULL, tx_hash TEXT NOT NULL,
     type TEXT NOT NULL, circle_id INTEGER, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_circle ON events (circle_id, ledger)`,
  `CREATE TABLE IF NOT EXISTS circle_meta (
     circle_id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
     signer TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    for (const m of MIGRATIONS) this.db.exec(m);
  }

  /** Returns true when the event was new. Event ids are unique on-chain, so re-ingesting is a no-op. */
  addEvent(e: ChainEvent): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO events (id, ledger, tx_hash, type, circle_id, data) VALUES (?,?,?,?,?,?)")
      .run(e.id, e.ledger, e.txHash, e.type, e.circleId, JSON.stringify(e.data));
    return Number(r.changes) === 1;
  }

  eventsForCircle(circleId: number, limit = 200): ChainEvent[] {
    return (this.db
      .prepare("SELECT id, ledger, tx_hash, type, circle_id, data FROM events WHERE circle_id = ? ORDER BY ledger, id LIMIT ?")
      .all(circleId, limit) as Record<string, unknown>[]).map(rowToEvent);
  }

  circlesJoinedBy(address: string): number[] {
    const rows = this.db
      .prepare("SELECT DISTINCT circle_id FROM events WHERE type = 'joined' AND json_extract(data, '$.member') = ? ORDER BY circle_id")
      .all(address) as { circle_id: number }[];
    return rows.map((r) => r.circle_id);
  }

  getKv(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setKv(key: string, value: string) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getMeta(circleId: number): MetaRow | null {
    const r = this.db.prepare("SELECT * FROM circle_meta WHERE circle_id = ?").get(circleId) as Record<string, unknown> | undefined;
    return r ? { circleId, name: String(r.name), description: String(r.description), signer: String(r.signer), updatedAt: Number(r.updated_at) } : null;
  }

  /** Only accepts a strictly newer timestamp so an old signed request cannot be replayed over a newer one. */
  setMeta(m: MetaRow): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO circle_meta (circle_id, name, description, signer, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(circle_id) DO UPDATE SET name=excluded.name, description=excluded.description,
           signer=excluded.signer, updated_at=excluded.updated_at WHERE excluded.updated_at > circle_meta.updated_at`,
      )
      .run(m.circleId, m.name, m.description, m.signer, m.updatedAt);
    return Number(r.changes) === 1;
  }

  close() {
    this.db.close();
  }
}

function rowToEvent(r: Record<string, unknown>): ChainEvent {
  return {
    id: String(r.id), ledger: Number(r.ledger), txHash: String(r.tx_hash), type: String(r.type),
    circleId: r.circle_id === null ? null : Number(r.circle_id), data: JSON.parse(String(r.data)),
  };
}
