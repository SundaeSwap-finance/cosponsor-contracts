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

## Known limitations (audited 2026-07-07, v0.0.7)

Every open shortcut in the SDK, by mainnet relevance. Each has an in-code comment at the named
location; none blocks a preview release.

1. **`resolveAncestor` queries Koios and defaults to the PREVIEW base URL** (`utils/ancestors.ts`).
   A mainnet caller who omits `koiosBaseUrl` reads preview governance state — wire it to the
   provider network before mainnet. _Why Koios at all:_ the ancestor is the last **enacted** action
   per purpose, which is historical governance state. Ogmios v6 ledger-state queries only expose
   proposals still **in flight** (enacted ones leave the set) and there is no `prevGovActionIds`
   query (that is a node-to-client `cardano-cli query gov-state` capability our providers don't
   have). Blockfrost CAN answer it, but its `/governance/proposals` list carries no enactment
   status — you must page every proposal and hit the per-proposal detail endpoint (N+1 rate-limited
   calls) to find the newest enacted one. Koios' `/proposal_list` returns all proposals **with**
   `enacted_epoch` in one keyless filtered query. `IResolveAncestorOptions.fetchFn`/`koiosBaseUrl`
   keep the source injectable if this ever needs to move to Blockfrost.
2. **MPF state reconstruction is Blockfrost-only by default** (`utils/mpfReconstruct.ts`,
   `Propose.ts::defaultStateChainQueries`): `NetworkId` cannot distinguish preview from preprod, so
   testnet defaults to preview (`BLOCKFROST_NETWORK` overrides). Browser/Kupmios callers must pass
   `stateChainQueries` explicitly.
3. **No mainnet guardrails reference UTxO is baked in** (`utils/guardrails.ts`): mainnet
   TreasuryWithdrawal/ParameterChange proposes fail closed until `GUARDRAILS_REF_UTXO=txHash#index`
   is set. Deliberate — the preview UTxO (`f3f61635…#0`) is verified; a mainnet one must be too.
4. **Each SDK release is bound to ONE deployment** (`Config.ts`, `browser/BrowserConfig.ts`):
   boot transaction, script hashes and reference UTxOs for preview Deployment #2 are baked in.
   Mainnet requires regenerating these via the configure/redeploy scripts and cutting a release.
5. **Propose redeemers carry padded stub exUnits** (`Propose.ts`, `STUB_TOTAL_*`,
   `GUARDRAILS_EX_UNITS`): they are never corrected with a real evaluation (that would change the
   script_data_hash and tx id), so every propose slightly overpays fees. By design.
6. **ProtocolParameters updates support only integer and rational values**
   (`Types/GovernanceAction.ts::TProtocolParamValue`): cost models, ex-unit prices and
   voting-threshold vectors are not representable and throw with a clear message.
7. **NewConstitution's `constitutionAnchor` is not committed by the datum/gADA**
   (`Types/GovernanceAction.ts::INewConstitution`): the V3 script context drops the constitution
   anchor, so the proposer chooses the submitted document. Mitigated by convention (the CIP-108
   metadata's `references` declare it); cryptographic commitment is deferred to the per-campaign
   redesign.
8. **The WPropose redeemer still carries three unused collateral ByteArrays**
   (`Propose.ts::buildPass`): dead weight since the on-chain redesign, kept so the redeemer shape
   is stable; prune together with the next type-breaking redeploy.
9. **`scripts/soak-deposits.ts` has pre-existing `tsc` errors** (Ogmios `shutdown` typing):
   script-only, not part of the built package.
10. **Redeem / withdraw / reclaim paths do not exist in the SDK.** The on-chain redeem design is
    the subject of a pending redesign (`AUDIT-PROPOSE-PATH.md` Finding B,
    `DESIGN-per-campaign-instantiation.md`); ~9150 tADA of preview deposits wait on it
    (`PREVIEW-DEPOSITS-TO-RECLAIM.md`). Mainnet blocker.

## License

MIT
