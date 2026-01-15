// TODO: Make these values environment variables
// Using the configuration transaction as bootstrap ID
export const PROTOCOL_BOOT_TRANSACTION_ID =
  "98e0aa234d0803e83cf9c402795389cb17300715806e3281564ca7e2bc2a6987";
export const PROTOCOL_BOOT_TRANSACTION_INDEX = 0n;
export const PROPOSAL_LIFETIME = 1000n * 60n * 60n * 24n * 5n; // 5 days in milliseconds

// Script reference address (where reference scripts are stored)
export const SCRIPT_REFERENCE_ADDRESS =
  "addr_test1qp69u6ka06zrxm0akqsfku6w862klmxx5gv8s2n5sv75nfxenku8xvgssv0852hyj36cpkzfs5p0pqpspt6qapm2rapqkayyvf";

// Minimum balance requirements (in lovelace)
export const MIN_WALLET_BALANCE = 10_000_000n; // 10 ADA - for configure.ts, mint-state-nft.ts
export const MIN_PROVIDER_BALANCE = 5_000_000n; // 5 ADA - for provider.ts checks
