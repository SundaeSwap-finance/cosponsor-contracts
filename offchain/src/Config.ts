// Protocol bootstrap configuration.
// Values can be overridden via environment variables; defaults are the
// currently-deployed Preview testnet values. Browser bundles do not have
// process.env, so the env lookups are guarded.

const env =
  typeof process !== "undefined" && process.env ? process.env : ({} as Record<string, string | undefined>);

export const PROTOCOL_BOOT_TRANSACTION_ID =
  env.PROTOCOL_BOOT_TRANSACTION_ID ??
  "98e0aa234d0803e83cf9c402795389cb17300715806e3281564ca7e2bc2a6987";

export const PROTOCOL_BOOT_TRANSACTION_INDEX =
  env.PROTOCOL_BOOT_TRANSACTION_INDEX !== undefined
    ? BigInt(env.PROTOCOL_BOOT_TRANSACTION_INDEX)
    : 0n;

export const PROPOSAL_LIFETIME =
  env.PROPOSAL_LIFETIME_MS !== undefined
    ? BigInt(env.PROPOSAL_LIFETIME_MS)
    : 1000n * 60n * 60n * 24n * 5n; // 5 days in milliseconds

// Script reference address (where reference scripts are stored)
export const SCRIPT_REFERENCE_ADDRESS =
  "addr_test1qp69u6ka06zrxm0akqsfku6w862klmxx5gv8s2n5sv75nfxenku8xvgssv0852hyj36cpkzfs5p0pqpspt6qapm2rapqkayyvf";

// Minimum balance requirements (in lovelace)
export const MIN_WALLET_BALANCE = 10_000_000n; // 10 ADA - for configure.ts, mint-state-nft.ts
export const MIN_PROVIDER_BALANCE = 5_000_000n; // 5 ADA - for provider.ts checks
