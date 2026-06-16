# Cosponsor Protocol Scripts

This directory contains the main operational scripts for the cosponsor protocol.

## Core Scripts

### Setup Scripts (Run Once)
- **`configure.ts`** - Creates the protocol boot transaction
- **`deploy.ts`** - Deploys smart contracts to the blockchain  
- **`mint-state-nft.ts`** - Mints the state NFT required for withdrawals

### Operational Scripts (Regular Use)
- **`deposit.ts`** - Submit deposit transactions to cosponsor proposals

> Withdrawals are not a standalone script. Use the SDK's exported
> `withdraw({ blaze, deposits })` (from `@sundaeswap/cosponsor-sdk`), which
> handles single, same-proposal bulk, and multi-proposal bulk withdrawals in
> one call. (The old `withdrawal.ts` scaffolding referenced builders that no
> longer exist and was removed — see audit C2.)

## Usage

1. **Initial Setup:**
   ```bash
   bun run configure    # Create protocol boot transaction
   bun run deploy       # Deploy contracts
   bun run mint-state-nft   # Mint state NFT
   ```

2. **Regular Operations:**
   ```bash
   bun run deposit <amount>     # Deposit ADA to a proposal
   # Withdraw: call the SDK's withdraw({ blaze, deposits }) from your own code
   ```

## Helper Scripts

Helper and debugging scripts are located in `../helpers/`:
- **`inspect-deposit.ts`** - Debug tool to inspect deposit transactions
- **`checkEnvVars.ts`** - Validate environment configuration

Run helpers with:
```bash
bun run inspect-deposit <tx_hash>
bun run check-env
```