# Cosponsor Protocol Scripts

This directory contains the main operational scripts for the cosponsor protocol.

## Core Scripts

### Setup Scripts (Run Once)

- **`configure.ts`** - Creates the protocol boot transaction (5-ADA boot UTxO)
- **`deploy.ts`** - Deploys the 3 reference scripts to the blockchain
- **`register-reward-account.ts`** - Registers the cosponsor script's reward
  (stake) account. **Required for WPropose:** a proposal submission does a
  0-lovelace withdrawal from the cosponsor script's reward account, and Cardano
  rejects any withdrawal whose stake credential isn't registered. Locks a ~2 ADA
  refundable stake-key deposit; needs no script witness (only the later
  withdrawal runs the validator).
- **`mint-state-nft.ts`** - Mints the state NFT required for withdrawals
- **`redeploy.ts`** - **Orchestrator.** Runs the full fresh-deployment sequence
  hands-free (configure → deploy → register → mint), threading every output so
  no hash or tx id is hand-copied. Also patches `browser/BrowserConfig.ts` in
  place and writes `redeploy-output.json` + `deployed-contracts.json`.

### Operational Scripts (Regular Use)

- **`deposit.ts`** - Submit deposit transactions to cosponsor proposals

> Withdrawals are not a standalone script. Use the SDK's exported
> `withdraw({ blaze, deposits })` (from `@sundaeswap/cosponsor-sdk`), which
> handles single, same-proposal bulk, and multi-proposal bulk withdrawals in
> one call. (The old `withdrawal.ts` scaffolding referenced builders that no
> longer exist and was removed — see audit C2.)

## Usage

1. **Initial Setup / Redeploy (recommended — one command):**

   ```bash
   bun run redeploy
   ```

   This runs the full sequence in order and threads outputs automatically:
   1. **configure** — create a fresh boot UTxO (its tx id becomes the new
      `PROTOCOL_BOOT_TRANSACTION_ID`). A fresh boot UTxO is required because
      minting the state NFT _spends_ it, so a re-mint needs a new one.
   2. **recompute** — derive the parameterized `CosponsorState` + `Cosponsor`
      hashes and cosponsor CBOR from the NEW boot id (never from Config
      defaults).
   3. **deploy** — deploy the 3 reference scripts to `SCRIPT_REFERENCE_ADDRESS`.
   4. **register** — register the cosponsor reward account (see above).
   5. **mint** — mint the state NFT against the new boot UTxO.
   6. **write artifacts** — patch `browser/BrowserConfig.ts` (statePolicyId, all
      three script hashes, cosponsor CBOR, and the two `scriptReferenceUtxos`
      tx hashes) and emit `redeploy-output.json` (new boot id, all hashes, all
      deploy tx ids, and the exact `.env` values to set).

   **Resuming after a failure:** each completed step's outputs (including the new
   boot id) are cached in `redeploy-state.json`. Resume at any step with:

   ```bash
   bun run redeploy --from=configure   # (default)
   bun run redeploy --from=deploy
   bun run redeploy --from=register
   bun run redeploy --from=mint
   ```

   **After redeploy:** set the printed `PROTOCOL_BOOT_TRANSACTION_ID` in your
   `.env` (or update `Config.ts` defaults) so standalone scripts and the SDK
   agree with the new deployment.

   **Manual step-by-step (equivalent):**

   ```bash
   bun run configure               # Create protocol boot transaction
   # -> set PROTOCOL_BOOT_TRANSACTION_ID in .env to the printed tx id
   bun run deploy                  # Deploy contracts
   bun run register-reward-account # Register cosponsor reward account
   bun run mint-state-nft          # Mint state NFT
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
