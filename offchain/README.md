# @sundaeswap/cosponsor-sdk

Cosponsor SDK for Cardano smart contract interactions — handles deposits and withdrawals for governance-proposal cosponsoring, in both Node and browser environments.

## Installation

```bash
npm install @sundaeswap/cosponsor-sdk
```

## Node vs Browser API parity

The SDK ships two entry points with parallel functionality:

|          | Node (`@sundaeswap/cosponsor-sdk`)                       | Browser (`@sundaeswap/cosponsor-sdk/browser`)                   |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Deposit  | `deposit({ blaze, cosponsoredProposal, depositAmount })` | `browserDeposit({ blaze, cosponsoredProposal, depositAmount })` |
| Withdraw | `withdraw({ blaze, deposits })`                          | `browserWithdraw({ blaze, withdrawalPlan, withdrawAmount })`    |
| Provider | `CardanoProvider` (Blockfrost / Kupmios, reads env)      | bring your own `Blaze` instance + injected wallet               |

- The **Node** path is provider-driven (`CardanoProvider` reads Blockfrost/Kupmios config from env) and `withdraw` takes an explicit list of deposits.
- The **Browser** path works against a `Blaze` instance you construct from a wallet (e.g. via a dApp connector); `browserWithdraw` takes a `withdrawalPlan` (from `fetchWithdrawalPlan`) plus an amount.
- Both produce a transaction you complete with the standard Blaze flow: `tx.complete()` → `blaze.signTransaction()` → `blaze.provider.postTransactionToChain()`.

## Node usage

### Provider Configuration

```typescript
import { CardanoProvider, deposit, withdraw } from "@sundaeswap/cosponsor-sdk";

// Option 1: Blockfrost
const provider = new CardanoProvider({
  type: "blockfrost",
  blockfrostKey: "your-api-key",
  network: "cardano-preview", // optional, defaults to preview
  debugMode: true, // optional, enables logging
  wallet: {
    seedPhrase: "your seed phrase",
    // OR privateKey: 'your private key',
    expectedAddress: "addr...", // optional validation
    expectedBalance: 5_000_000n, // optional validation (5 ADA)
  },
});

// Option 2: Ogmios + Kupo
const provider = new CardanoProvider({
  type: "kupmios",
  ogmiosUrl: "ws://localhost:1337",
  kupoUrl: "http://localhost:1442",
  wallet: { seedPhrase: "your seed phrase" },
});

await provider.initialize();
const blaze = provider.getBlaze();
```

### Making Deposits

```typescript
const depositTx = await deposit({
  blaze,
  cosponsoredProposal: {
    deposit: 100_000_000n,
    anchor: { url: "https://example.com/proposal.json", hash: "<32-byte hex>" },
    // `action` is a discriminated union by `kind`:
    //   "NicePoll" | "TreasuryWithdrawal" | "ConstitutionalCommittee"
    //   | "NewConstitution" | "ProtocolParameters" | "HardFork" | "NoConfidence"
    action: { kind: "NicePoll" },
  },
  depositAmount: 100_000_000n, // 100 ADA
});

const completed = await depositTx.complete();
const signed = await blaze.signTransaction(completed);
const txId = await blaze.provider.postTransactionToChain(signed);
```

### Making Withdrawals

```typescript
// withdraw() handles single, same-proposal bulk, and multi-proposal bulk
// withdrawals in one call (it groups the deposits internally).
const withdrawalTx = await withdraw({
  blaze,
  deposits: [
    {
      depositTxHash: "abc123...",
      depositOutputIndex: 0,
      depositAmount: 100_000_000n,
      cosponsoredProposal: {
        /* same proposal used in the matching deposit */
      },
    },
    // ...more deposits, from the same or different proposals
  ],
});

const completed = await withdrawalTx.complete();
const signed = await blaze.signTransaction(completed);
const txId = await blaze.provider.postTransactionToChain(signed);
```

## Browser usage

```typescript
import {
  browserDeposit,
  browserWithdraw,
  fetchWithdrawalPlan,
} from "@sundaeswap/cosponsor-sdk/browser";

// `blaze` is a Blaze instance built from the connected wallet (e.g. via your
// dApp wallet connector). BROWSER_CONFIG carries the pre-deployed script
// hashes/CBOR so no runtime parameter application is needed.

// Deposit
const depositTx = await browserDeposit({
  blaze,
  cosponsoredProposal: {
    deposit: 100_000_000n,
    anchor: { url: "https://example.com/proposal.json", hash: "<32-byte hex>" },
    action: { kind: "NicePoll" },
  },
  depositAmount: 100_000_000n,
});
const txId = await blaze.provider.postTransactionToChain(
  await blaze.signTransaction(await depositTx.complete()),
);

// Withdraw
const plan = await fetchWithdrawalPlan(blaze);
const withdrawalTx = await browserWithdraw({
  blaze,
  withdrawalPlan: plan,
  withdrawAmount: 100_000_000n,
});
```

> **Reference scripts:** the browser path resolves the cosponsor reference script
> via Kupo+Ogmios when available, falling back to the pre-computed CBOR in
> `BROWSER_CONFIG`. If you use Blockfrost, import the `Blockfrost` class from this
> SDK (`@sundaeswap/cosponsor-sdk/browser`) so any prototype patches apply to the
> instance the SDK actually constructs.

## Subpath exports

```typescript
import { logger, setLoggerEnabled } from "@sundaeswap/cosponsor-sdk/logger";
import { PROTOCOL_BOOT_TRANSACTION_ID } from "@sundaeswap/cosponsor-sdk/Config";
```

## Logging

The SDK's internal logger is silent by default. Enable it with either:

- `setLoggerEnabled(true)` at runtime, or
- the `COSPONSOR_SDK_DEBUG=1` environment variable.

The Node `deposit`/`withdraw` functions also accept a per-call `debugMode?: boolean`.

## Development

```bash
bun install
npm run build        # Build once
npm run build:watch  # Build and watch for changes
npm run clean        # Clean build artifacts
npm test             # Run the test suite (bun test)
```

### Local development with cosponsor-ui

```bash
npm run copy-to-ui   # builds the SDK and copies it into the UI project
```

### Dev scripts

- `npm run configure` — Create the protocol boot transaction
- `npm run deploy` — Deploy contracts
- `npm run mint-state-nft` — Mint the state NFT
- `npm run deposit` — Run the deposit script

> Withdrawals are not a standalone script — call the SDK's `withdraw()` from your
> own code (see Node usage above).

## API Reference

```typescript
// Provider configuration
interface BlockfrostConfig {
  type: "blockfrost";
  blockfrostKey: string;
  network?: "cardano-preview" | "cardano-preprod" | "cardano-mainnet";
  debugMode?: boolean;
  wallet: WalletConfig;
}

interface KupmiosConfig {
  type: "kupmios";
  ogmiosUrl: string;
  kupoUrl: string;
  debugMode?: boolean;
  wallet: WalletConfig;
}

// Deposit arguments
interface IDepositArgs<P, W> {
  blaze: Blaze<P, W>;
  cosponsoredProposal: ICosponsoredProposal;
  depositAmount: bigint;
  debugMode?: boolean;
}

// Withdrawal arguments
interface IWithdrawalArgs<P, W> {
  blaze: Blaze<P, W>;
  deposits: IDepositWithdrawal[];
  debugMode?: boolean;
}
```

## License

MIT
