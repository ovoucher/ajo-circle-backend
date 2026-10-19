import { loadConfig } from "./config.js";
import { RpcChain } from "./chain.js";
import { Store } from "./db.js";
import { buildApp } from "./app.js";
import { startIndexer } from "./indexer.js";

const config = loadConfig();
const chain = new RpcChain(config.STELLAR_RPC_URL, config.NETWORK_PASSPHRASE, config.AJO_CONTRACT_ID);
const store = new Store(config.DATABASE_PATH);
const app = buildApp({ config, chain, store });
const stop = startIndexer(chain, store, config.INDEX_INTERVAL_MS, (m, e) => app.log.error({ err: e }, m));

const shutdown = async () => {
  stop();
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
