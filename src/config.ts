import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("127.0.0.1"),
  STELLAR_NETWORK: z.literal("testnet").default("testnet"),
  STELLAR_RPC_URL: z.url().default("https://soroban-testnet.stellar.org"),
  NETWORK_PASSPHRASE: z.string().default("Test SDF Network ; September 2015"),
  AJO_CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/, "must be a Stellar contract id"),
  /** Token the circles use. Defaults to the native XLM contract on Testnet. */
  TOKEN_CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/).default("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"),
  TOKEN_SYMBOL: z.string().min(1).max(12).default("XLM"),
  DATABASE_PATH: z.string().default("./data/ajo.sqlite"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  INDEX_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(120),
});

export type Config = z.infer<typeof schema>;

/** Mainnet is refused on purpose: this build is Testnet-only (see docs/SECURITY.md). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
