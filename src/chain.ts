import { Account, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

export interface CircleView {
  organizer: string;
  token: string;
  members: string[];
  contribution: string;
  period: number;
  grace: number;
  state: "Forming" | "Active" | "Completed" | "Cancelled";
  joined: number;
  startTime: number;
  round: number;
  paid: number;
}

export interface ChainEvent {
  id: string;
  ledger: number;
  txHash: string;
  type: string;
  circleId: number | null;
  data: Record<string, unknown>;
}

export interface TxResult {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  ledger?: number;
  /** Contract ids the transaction invoked, taken from the RPC result, not from the caller. */
  contractIds: string[];
}

/** Everything the backend needs from Stellar. Tests inject a fake; production uses RpcChain. */
export interface Chain {
  latestLedger(): Promise<number>;
  circleCount(): Promise<number>;
  getCircle(id: number): Promise<CircleView | null>;
  /** One page of events. RPC scans a bounded ledger window per call, so callers must follow `cursor`. */
  getEvents(from: { startLedger: number } | { cursor: string }, limit?: number): Promise<{ events: ChainEvent[]; cursor: string; latestLedger: number }>;
  getTransactionEvents(txHash: string): Promise<{ result: TxResult; events: ChainEvent[] }>;
}

const jsonSafe = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString()
  : Array.isArray(v) ? v.map(jsonSafe)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]))
  : v;

export function toCircleView(raw: Record<string, unknown>): CircleView {
  const state = Array.isArray(raw.state) ? String(raw.state[0]) : String(raw.state);
  return {
    organizer: String(raw.organizer),
    token: String(raw.token),
    members: (raw.members as unknown[]).map(String),
    contribution: String(raw.contribution),
    period: Number(raw.period),
    grace: Number(raw.grace),
    state: state as CircleView["state"],
    joined: Number(raw.joined),
    startTime: Number(raw.start_time),
    round: Number(raw.round),
    paid: Number(raw.paid),
  };
}

export function parseEvent(
  ev: { id: string; ledger: number; txHash: string; topic: xdr.ScVal[]; value: xdr.ScVal },
): ChainEvent | null {
  try {
    const topics = ev.topic.map((t) => scValToNative(t));
    const type = String(topics[0]);
    const value = scValToNative(ev.value);
    const circleId = typeof topics[1] === "number" ? topics[1] : null;
    const data = jsonSafe({ ...(value && typeof value === "object" ? value : {}), ...(topics[2] !== undefined ? { round: topics[2] } : {}) }) as Record<string, unknown>;
    return { id: ev.id, ledger: ev.ledger, txHash: ev.txHash, type, circleId, data };
  } catch {
    return null;
  }
}

export class RpcChain implements Chain {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  // Simulation of read-only calls needs a source account object but never submits.
  private readonly reader = new Account(Keypair.random().publicKey(), "0");

  constructor(rpcUrl: string, private readonly passphrase: string, private readonly contractId: string) {
    this.server = new rpc.Server(rpcUrl);
    this.contract = new Contract(contractId);
  }

  async latestLedger() {
    return (await this.server.getLatestLedger()).sequence;
  }

  private async read(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(this.reader, { fee: "100", networkPassphrase: this.passphrase })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return retval ? scValToNative(retval) : null;
  }

  async circleCount() {
    return Number(await this.read("circle_count"));
  }

  async getCircle(id: number) {
    try {
      return toCircleView((await this.read("get_circle", nativeToScVal(id, { type: "u32" }))) as Record<string, unknown>);
    } catch (e) {
      if (/Error\(Contract, #1\)/.test(String(e))) return null;
      throw e;
    }
  }

  async getEvents(from: { startLedger: number } | { cursor: string }, limit = 200) {
    const res = await this.server.getEvents({
      ...from,
      filters: [{ type: "contract", contractIds: [this.contractId] }],
      limit,
    });
    const events = res.events
      .map((e) => parseEvent({ id: e.id, ledger: e.ledger, txHash: e.txHash, topic: e.topic, value: e.value }))
      .filter((e): e is ChainEvent => e !== null);
    return { events, cursor: res.cursor, latestLedger: res.latestLedger };
  }

  async getTransactionEvents(txHash: string) {
    const tx = await this.server.getTransaction(txHash);
    if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return { result: { status: "NOT_FOUND" as const, contractIds: [] }, events: [] };
    }
    const ledger = tx.ledger;
    if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      return { result: { status: "FAILED" as const, ledger, contractIds: [] }, events: [] };
    }
    // Pull the ledger's events for our contract and keep the ones from this transaction.
    const { events } = await this.getEvents({ startLedger: ledger }, 200);
    const mine = events.filter((e) => e.txHash === txHash && e.ledger === ledger);
    return {
      result: { status: "SUCCESS" as const, ledger, contractIds: mine.length ? [this.contractId] : [] },
      events: mine,
    };
  }
}
