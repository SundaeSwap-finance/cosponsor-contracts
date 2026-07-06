import dotenv from "dotenv";
import { CardanoProvider } from "@utils/provider.js";
import { Core } from "@blaze-cardano/sdk";
import { Cosponsor } from "@validators/Cosponsor.js";
import { CosponsorState } from "@validators/CosponsorState.js";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
  MIN_WALLET_BALANCE,
} from "@/Config.js";

dotenv.config();

/**
 * Register the Cosponsor script's reward (stake) account.
 *
 * WHY THIS EXISTS
 * ---------------
 * The WPropose flow performs a 0-lovelace withdrawal from the COSPONSOR SCRIPT's
 * reward account (the withdraw-purpose redeemer is what actually runs the
 * cosponsor validator during a proposal submission). On Cardano, a reward/stake
 * credential MUST be registered on-chain (via a stake-registration certificate)
 * before ANY withdrawal that references it is valid. Without this one-time
 * registration, every propose transaction is rejected by the node before the
 * script even runs.
 *
 * WHAT IT DOES
 * ------------
 * Submits a plain stake-registration certificate for the cosponsor script's
 * script-hash stake credential. Stake registration itself needs NO script
 * witness — only the later *withdrawal* triggers the validator. A plain
 * registration cert (which the wallet signs, paying the key-deposit) therefore
 * suffices; the cosponsor withdraw validator does not run here.
 *
 * DEPOSIT COST
 * ------------
 * Registration locks the protocol `stakeKeyDeposit` (2 ADA on Preview/mainnet)
 * plus the tx fee. The 2 ADA deposit is refundable if the account is ever
 * deregistered.
 *
 * BLAZE API
 * ---------
 * Uses `TxBuilder.addRegisterStake(credential)` from @blaze-cardano/tx. Verified
 * present and implemented in the installed version (dist/index.mjs builds a
 * `StakeRegistration` cert via `Certificate.newStakeRegistration`). The stale
 * "Method not implemented" JSDoc on this method is inaccurate — the body is real.
 */

/**
 * Derive the cosponsor script's script-hash stake credential from the Config
 * defaults (used when no explicit hash is supplied, e.g. running standalone).
 */
const cosponsorHashFromConfig = (): string => {
  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );
  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
  });
  return cosponsor.script().hash();
};

/**
 * Build the bech32 reward (stake) address for a script-hash stake credential so
 * we can query its on-chain registration status via Blockfrost.
 */
const rewardAddressBech32 = (
  network: Core.NetworkId,
  scriptHash: string,
): string => {
  // RewardAddress.fromCredentials takes the plain Cardano.Credential shape.
  return Core.RewardAddress.fromCredentials(network, {
    type: Core.CredentialType.ScriptHash,
    hash: Core.Hash28ByteBase16(scriptHash),
  })
    .toAddress()
    .toBech32();
};

/**
 * Best-effort idempotency check: ask Blockfrost whether the reward account is
 * already registered/active. Returns `true` if definitely registered, `false`
 * if definitely not, and `null` if we could not determine (no Blockfrost key,
 * or a network error) — in which case the caller should just attempt the
 * registration and let the node reject a double-registration with a clear error.
 */
const isRewardAccountRegistered = async (
  stakeAddress: string,
): Promise<boolean | null> => {
  const apiKey = process.env.BLOCKFROST_API_KEY;
  if (!apiKey) {
    // Kupmios path: no simple REST account query — fall back to try/catch.
    return null;
  }
  try {
    const res = await fetch(
      `https://cardano-preview.blockfrost.io/api/v0/accounts/${stakeAddress}`,
      { headers: { project_id: apiKey } },
    );
    if (res.status === 404) {
      // Blockfrost returns 404 for a stake address it has never seen.
      return false;
    }
    if (!res.ok) {
      return null;
    }
    const account = (await res.json()) as { active?: boolean };
    return account.active === true;
  } catch {
    return null;
  }
};

/**
 * Register the cosponsor script's reward account.
 *
 * @param cardanoProvider initialised provider/wallet.
 * @param cosponsorScriptHash optional explicit cosponsor script hash. When
 *   omitted, it is derived from the Config bootstrap defaults. The redeploy
 *   orchestrator passes the freshly-computed hash so registration targets the
 *   NEW deployment rather than Config's baked-in defaults.
 * @returns the submitted transaction id, or `null` if the account was already
 *   registered (idempotent no-op).
 */
export const registerRewardAccount = async (
  cardanoProvider: CardanoProvider,
  cosponsorScriptHash?: string,
): Promise<string | null> => {
  console.log("=== Registering Cosponsor Reward Account ===");

  const blaze = cardanoProvider.getBlaze();
  const scriptHash = cosponsorScriptHash ?? cosponsorHashFromConfig();
  const network = blaze.provider.network;

  const stakeAddress = rewardAddressBech32(network, scriptHash);

  console.log(`Cosponsor script hash: ${scriptHash}`);
  console.log(`Reward (stake) address: ${stakeAddress}`);

  // Idempotency: skip if already registered.
  const registered = await isRewardAccountRegistered(stakeAddress);
  if (registered === true) {
    console.log("✓ Reward account is already registered — nothing to do.");
    return null;
  }
  if (registered === null) {
    console.log(
      "Could not determine registration status; attempting registration " +
        "(a double-registration would be rejected by the node).",
    );
  }

  // The tx builder calls `.toCore()` on the credential, so it needs the
  // Serialization Credential built via `fromCore` (its constructor is private).
  const scriptCredential = Core.Credential.fromCore({
    type: Core.CredentialType.ScriptHash,
    hash: Core.Hash28ByteBase16(scriptHash),
  });

  const tx = blaze.newTransaction();
  // Plain stake registration — no script witness required (only the later
  // withdrawal runs the validator). Locks the ~2 ADA stake-key deposit.
  tx.addRegisterStake(scriptCredential);
  tx.setChangeAddress(await blaze.wallet.getChangeAddress());

  console.log("Building reward-account registration transaction...");
  const completed = await tx.complete();
  console.log(
    `✓ Built (fee: ${completed.body().fee()} lovelace, deposit: ~2 ADA)`,
  );

  const signed = await blaze.signTransaction(completed);
  console.log("✓ Registration transaction signed");

  try {
    const txId = await blaze.provider.postTransactionToChain(signed);
    console.log(`✓ Reward-account registration submitted!`);
    console.log(`Transaction ID: ${txId}`);
    return txId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A node rejection due to the account already existing is benign here.
    if (/already registered|StakeKeyRegistered|already exists/i.test(message)) {
      console.log(
        "Reward account appears to be already registered (node rejected " +
          "the duplicate registration). Treating as success.",
      );
      return null;
    }
    throw error;
  }
};

const main = async () => {
  console.log("Registering Cosponsor Reward Account");
  console.log("====================================");

  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    if (balance.balance < MIN_WALLET_BALANCE) {
      throw new Error(
        `Insufficient balance. Need at least ${MIN_WALLET_BALANCE / 1_000_000n} ADA (2 ADA deposit + fee), have ${balance.balance / 1_000_000n} ADA`,
      );
    }

    const txId = await registerRewardAccount(cardanoProvider);

    console.log(`\n${"=".repeat(60)}`);
    console.log("SUCCESS!");
    if (txId) {
      console.log(`Reward account registered in transaction: ${txId}`);
      console.log("The cosponsor script can now be used for WPropose.");
    } else {
      console.log("Reward account was already registered — no action needed.");
    }
    console.log("=".repeat(60));
  } catch (error) {
    console.error("Reward-account registration failed:", error);
    process.exit(1);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

// Run main if this script is executed directly
if (
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"))
) {
  main().catch(console.error);
}

export default registerRewardAccount;
