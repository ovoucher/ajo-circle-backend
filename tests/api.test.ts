import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { buildApp, metaMessage } from "../src/app.js";
import { Store } from "../src/db.js";
import { indexOnce } from "../src/indexer.js";
import { loadConfig } from "../src/config.js";
import type { Chain, ChainEvent, CircleView } from "../src/chain.js";

process.env.NODE_ENV = "test";
const CONTRACT = "C" + "A".repeat(55);
const organizer = Keypair.random();
const NOW = 1_800_000_000;

const circle = (over: Partial<CircleView> = {}): CircleView => ({
  organizer: organizer.publicKey(), token: CONTRACT, members: [organizer.publicKey()], contribution: "100",
  period: 60, grace: 0, state: "Forming", joined: 0, startTime: 0, round: 0, paid: 0, ...over,
});
const ev = (id: string, ledger: number, type = "joined", circleId = 0, data = {}): ChainEvent => ({ id, ledger, txHash: "ab".repeat(32), type, circleId, data });

class FakeChain implements Chain {
  circles: CircleView[] = [circle()];
  events: ChainEvent[] = [];
  tx: Record<string, { status: "SUCCESS" | "FAILED" | "NOT_FOUND"; events: ChainEvent[] }> = {};
  async latestLedger() { return 100; }
  async circleCount() { return this.circles.length; }
  async getCircle(id: number) { return this.circles[id] ?? null; }
  async getEvents(from: { startLedger: number } | { cursor: string }) {
    const start = "cursor" in from ? Number(from.cursor) : from.startLedger;
    // Fake cursor = next ledger to read, encoded like a TOID so the indexer can read its ledger.
    return { events: this.events.filter((e) => e.ledger >= start), cursor: String(BigInt(101) << 32n) + "-0", latestLedger: 100 };
  }
  async getTransactionEvents(h: string) {
    const t = this.tx[h] ?? { status: "NOT_FOUND" as const, events: [] };
    return { result: { status: t.status, ledger: 50, contractIds: t.events.length ? [CONTRACT] : [] }, events: t.events };
  }
}

let chain: FakeChain, store: Store, app: ReturnType<typeof buildApp>;
beforeEach(() => {
  chain = new FakeChain();
  store = new Store(":memory:");
  app = buildApp({ config: loadConfig({ AJO_CONTRACT_ID: CONTRACT }), chain, store, now: () => NOW });
});

const signedMeta = (kp: Keypair, name: string, description = "", ts = NOW) => ({
  name, description, timestamp: ts,
  signature: Buffer.from(kp.sign(Buffer.from(metaMessage(CONTRACT, 0, name, description, ts)))).toString("hex"),
});

describe("config", () => {
  it("rejects a missing or malformed contract id", () => {
    expect(() => loadConfig({})).toThrow(/AJO_CONTRACT_ID/);
    expect(() => loadConfig({ AJO_CONTRACT_ID: "nope" })).toThrow();
  });
  it("rejects non-testnet networks", () => {
    expect(() => loadConfig({ AJO_CONTRACT_ID: CONTRACT, STELLAR_NETWORK: "mainnet" })).toThrow();
  });
});

describe("read endpoints", () => {
  it("serves everything a client needs to talk to the contract", async () => {
    const r = (await app.inject("/api/config")).json();
    expect(r).toMatchObject({ network: "testnet", contractId: CONTRACT, tokenSymbol: "XLM" });
    expect(r.tokenContractId).toMatch(/^C[A-Z2-7]{55}$/);
    expect(r.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(r.rpcUrl).toMatch(/^https:/);
  });
  it("health", async () => {
    const r = await app.inject("/health");
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });
  it("lists circles with on-chain and off-chain parts separated", async () => {
    const r = await app.inject("/api/circles");
    expect(r.json().count).toBe(1);
    expect(r.json().circles[0].onChain.state).toBe("Forming");
    expect(r.json().circles[0].offChain).toBeNull();
  });
  it("404 for unknown circle, 400 for bad id", async () => {
    expect((await app.inject("/api/circles/9")).statusCode).toBe(404);
    expect((await app.inject("/api/circles/abc")).statusCode).toBe(400);
  });
  it("validates member address", async () => {
    expect((await app.inject("/api/members/nope/circles")).statusCode).toBe(400);
    expect((await app.inject(`/api/members/${organizer.publicKey()}/circles`)).json().circleIds).toEqual([]);
  });
});

describe("meta authorization", () => {
  const put = async (payload: unknown) => {
    const r = await app.inject({ method: "PUT", url: "/api/circles/0/meta", payload: payload as object });
    return r;
  };
  it("accepts the organizer's signature", async () => {
    expect((await put(signedMeta(organizer, "Market women"))).statusCode).toBe(200);
    const c = (await app.inject("/api/circles/0")).json();
    expect(c.offChain.name).toBe("Market women");
  });
  it("rejects a signature from someone else", async () => {
    expect((await put(signedMeta(Keypair.random(), "x"))).statusCode).toBe(403);
  });
  it("rejects tampered content", async () => {
    const body = signedMeta(organizer, "Real");
    expect((await put({ ...body, name: "Fake" })).statusCode).toBe(403);
  });
  it("rejects stale timestamps and replays of older updates", async () => {
    expect((await put(signedMeta(organizer, "old", "", NOW - 1000))).statusCode).toBe(400);
    expect((await put(signedMeta(organizer, "new", "", NOW))).statusCode).toBe(200);
    expect((await put(signedMeta(organizer, "older", "", NOW - 10))).statusCode).toBe(409);
  });
  it("validates body and unknown circle", async () => {
    expect((await put({ name: "", timestamp: NOW, signature: "00" })).statusCode).toBe(400);
    const r = await app.inject({ method: "PUT", url: "/api/circles/5/meta", payload: signedMeta(organizer, "x") });
    expect(r.statusCode).toBe(404);
  });
});

describe("transaction verification", () => {
  const hash = "ab".repeat(32);
  const verify = (h: string) => app.inject({ method: "POST", url: "/api/transactions/verify", payload: { hash: h } });
  it("rejects malformed hashes", async () => {
    expect((await verify("zz")).statusCode).toBe(400);
  });
  it("404 when chain does not know the tx", async () => {
    expect((await verify(hash)).statusCode).toBe(404);
  });
  it("reports FAILED and records nothing", async () => {
    chain.tx[hash] = { status: "FAILED", events: [] };
    const r = (await verify(hash)).json();
    expect(r.status).toBe("FAILED");
    expect(store.eventsForCircle(0)).toHaveLength(0);
  });
  it("records events once, even when called repeatedly", async () => {
    chain.tx[hash] = { status: "SUCCESS", events: [ev("e1", 50, "joined", 0, { member: organizer.publicKey() })] };
    expect((await verify(hash)).json().recorded).toBe(1);
    expect((await verify(hash)).json().recorded).toBe(0);
    expect(store.eventsForCircle(0)).toHaveLength(1);
    const m = (await app.inject(`/api/members/${organizer.publicKey()}/circles`)).json();
    expect(m.circleIds).toEqual([0]);
  });
});

describe("indexer", () => {
  it("ingests idempotently and advances the cursor", async () => {
    chain.events = [ev("a", 10), ev("b", 11, "started")];
    expect(await indexOnce(chain, store)).toBe(2);
    expect(await indexOnce(chain, store)).toBe(0);
    expect(store.getKv("cursor")).not.toBeNull();
    expect(store.eventsForCircle(0).map((e) => e.id)).toEqual(["a", "b"]);
  });
});
