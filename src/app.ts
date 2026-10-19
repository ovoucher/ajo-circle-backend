import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import type { Store } from "./db.js";

const META_WINDOW_SECONDS = 300;

export const metaMessage = (contractId: string, circleId: number, name: string, description: string, ts: number) =>
  `ajo-circle:meta:v1\n${contractId}\n${circleId}\n${ts}\n${name}\n${description}`;

const idParam = z.object({ id: z.coerce.number().int().min(0).max(2 ** 32 - 1) });
const metaBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  timestamp: z.number().int(),
  signature: z.string().regex(/^[0-9a-f]{128}$/i, "hex ed25519 signature"),
});
const verifyBody = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/i, "64 hex chars") });

export function buildApp(deps: { config: Config; chain: Chain; store: Store; now?: () => number }): FastifyInstance {
  const { config, chain, store } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { redact: ["req.headers.authorization"] }, bodyLimit: 4096 });

  void app.register(cors, { origin: config.CORS_ORIGIN.split(",") });
  void app.register(rateLimit, { max: config.RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal_error" : err.message });
  });

  const present = async (id: number) => {
    const circle = await chain.getCircle(id);
    if (!circle) return null;
    const meta = store.getMeta(id);
    return {
      id,
      // Read directly from the contract via RPC simulation: authoritative.
      onChain: circle,
      // Stored by this backend; signed by the organizer but not on-chain.
      offChain: meta ? { name: meta.name, description: meta.description, signer: meta.signer, updatedAt: meta.updatedAt } : null,
    };
  };

  app.get("/health", async () => ({ ok: true, network: config.STELLAR_NETWORK, contractId: config.AJO_CONTRACT_ID }));

  app.get("/api/config", async () => ({
    network: config.STELLAR_NETWORK,
    rpcUrl: config.STELLAR_RPC_URL,
    networkPassphrase: config.NETWORK_PASSPHRASE,
    contractId: config.AJO_CONTRACT_ID,
    tokenContractId: config.TOKEN_CONTRACT_ID,
    tokenSymbol: config.TOKEN_SYMBOL,
  }));

  app.get("/api/circles", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const count = await chain.circleCount();
    const ids: number[] = [];
    for (let i = count - 1; i >= 0 && ids.length < limit; i--) ids.push(i);
    const circles = (await Promise.all(ids.map(present))).filter((c) => c !== null);
    return { count, circles };
  });

  app.get("/api/circles/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const c = await present(id);
    return c ?? reply.code(404).send({ error: "circle_not_found" });
  });

  app.get("/api/circles/:id/events", async (req) => {
    const { id } = idParam.parse(req.params);
    return { circleId: id, source: "indexed from contract events", events: store.eventsForCircle(id) };
  });

  app.get("/api/members/:address/circles", async (req, reply) => {
    const { address } = z.object({ address: z.string() }).parse(req.params);
    if (!StrKey.isValidEd25519PublicKey(address)) return reply.code(400).send({ error: "invalid_address" });
    return { address, circleIds: store.circlesJoinedBy(address) };
  });

  // Off-chain name/description. Only the circle's on-chain organizer may set it; proven by an ed25519 signature.
  app.put("/api/circles/:id/meta", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = metaBody.parse(req.body);
    if (Math.abs(now() - body.timestamp) > META_WINDOW_SECONDS) return reply.code(400).send({ error: "timestamp_out_of_window" });
    const circle = await chain.getCircle(id);
    if (!circle) return reply.code(404).send({ error: "circle_not_found" });
    const message = metaMessage(config.AJO_CONTRACT_ID, id, body.name, body.description, body.timestamp);
    const ok = Keypair.fromPublicKey(circle.organizer).verify(Buffer.from(message), Buffer.from(body.signature, "hex"));
    if (!ok) return reply.code(403).send({ error: "bad_signature" });
    const stored = store.setMeta({ circleId: id, name: body.name, description: body.description, signer: circle.organizer, updatedAt: body.timestamp });
    if (!stored) return reply.code(409).send({ error: "stale_update" });
    return { ok: true };
  });

  // Never trusts the caller: the hash is looked up on RPC, and only events RPC attributes to our contract are stored.
  app.post("/api/transactions/verify", async (req, reply) => {
    const { hash } = verifyBody.parse(req.body);
    const { result, events } = await chain.getTransactionEvents(hash.toLowerCase());
    if (result.status === "NOT_FOUND") return reply.code(404).send({ status: "NOT_FOUND" });
    if (result.status === "FAILED") return reply.code(200).send({ status: "FAILED", ledger: result.ledger, recorded: 0 });
    let recorded = 0;
    for (const e of events) if (store.addEvent(e)) recorded++;
    return { status: "SUCCESS", ledger: result.ledger, touchesContract: result.contractIds.includes(config.AJO_CONTRACT_ID), events: events.length, recorded };
  });

  return app;
}
