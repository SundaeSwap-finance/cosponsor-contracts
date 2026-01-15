# @sundaeswap/cosponsor

Cosponsor SDK for Cardano smart contract interactions - handles deposits and withdrawals for governance proposal cosponsoring.

## Installation

```bash
npm install @sundaeswap/cosponsor
```

## Usage

The SDK supports both Blockfrost and Ogmios+Kupo backends with optional debug logging.

### Provider Configuration

```typescript
import { CardanoProvider, deposit, withdraw } from "@sundaeswap/cosponsor";

// Option 1: Blockfrost Configuration
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

// Option 2: Ogmios + Kupo Configuration
const provider = new CardanoProvider({
  type: "kupmios",
  ogmiosUrl: "ws://localhost:1337",
  kupoUrl: "http://localhost:1442",
  debugMode: false, // silent mode
  wallet: {
    seedPhrase: "your seed phrase",
  },
});

await provider.initialize();
const blaze = provider.getBlaze();
```

### Making Deposits

```typescript
const depositTx = await deposit({
  blaze,
  cosponsoredProposal: {
    action: { kind: "treasury", withdrawals: [...] },
    anchor: { url: "https://...", hash: "..." }
  },
  depositAmount: 100_000_000n, // 100 ADA
  debugMode: true // optional logging
});

const signedTx = await depositTx.sign();
const txId = await signedTx.submit();
```

### Making Withdrawals

```typescript
// Single or multiple deposit withdrawal
const withdrawalTx = await withdraw({
  blaze,
  deposits: [
    {
      depositTxHash: "abc123...",
      depositOutputIndex: 0,
      depositAmount: 100_000_000n,
      cosponsoredProposal: {
        /* same proposal as used in deposit */
      },
    },
    // Can add more deposits from same or different proposals
  ],
  debugMode: true, // optional logging
});

const signedTx = await withdrawalTx.sign();
const txId = await signedTx.submit();
```

## Development

### Setup

```bash
bun install
```

### Building

```bash
npm run build        # Build once
npm run build:watch  # Build and watch for changes
npm run clean        # Clean build artifacts
```

### Local Development with cosponsor-ui

For local development, you can copy the built SDK directly to the UI project:

```bash
npm run copy-to-ui
```

This will:

1. Build the SDK (`npm run build`)
2. Copy the compiled files to `C:\Users\Mark\Documents\GitHub\cosponsor-ui\src\lib\cosponsor-sdk\`

Then in the UI project, you can import directly:

```typescript
// In cosponsor-ui project
import { CardanoProvider, deposit, withdraw } from "../lib/cosponsor-sdk";
```

### Debug Mode

All console logging is controlled by the `debugMode` parameter:

- `debugMode: false` (default): Silent operation
- `debugMode: true`: Detailed logging of initialization, transaction building, and progress
- Environment variable: `DEBUG_MODE=true` or `DEBUG_MODE=1`

### Scripts

- `npm run configure` - Configure environment
- `npm run deploy` - Deploy contracts
- `npm run deposit` - Run deposit script
- `npm run withdrawal` - Run withdrawal script

## API Reference

### Types

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
