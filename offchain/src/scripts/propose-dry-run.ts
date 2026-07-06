/**
 * Propose dry run (acceptance check for the Phase-2 builder).
 *
 * Builds the Propose transaction for a proposal on preview and asks the
 * provider to evaluate the FINAL spliced transaction — the one whose body
 * carries `proposal_procedures` (field 20) and whose id is the blake2b-256
 * of that body — WITHOUT submitting anything. If the evaluation succeeds,
 * the on-chain WPropose reconstruction accepted the built body.
 *
 * Usage:
 *   bun run src/scripts/propose-dry-run.ts [depositLovelace]
 *
 * Environment: same as the other scripts (BLOCKFROST_API_KEY or
 * KUPO_URL+OGMIOS_URL, WALLET_SEED_PHRASE/WALLET_PRIVATE_KEY). Optional:
 *   PROPOSAL_ANCHOR_URL   plain-text anchor URL   (default: the deposit.ts mock)
 *   PROPOSAL_ANCHOR_HASH  32-byte hex anchor hash (default: the deposit.ts mock)
 */

import dotenv from "dotenv";
import { CardanoProvider } from "@utils/provider";
import { propose } from "@transactions/index";
import { ICosponsoredProposal } from "@validators/index";
import { TGovernanceAction } from "@validators/Types/GovernanceAction";
import { selectTestProposal } from "./test-proposals";
import { assertAncestorCurrent } from "@utils/ancestors";

dotenv.config();

// === CONFIGURATION ===
// Must match a proposal that has pooled deposits on-chain — defaults mirror
// the mock proposal in src/scripts/deposit.ts.
const DEFAULT_DEPOSIT = 150_000_000n;

const anchorUrl =
  process.env.PROPOSAL_ANCHOR_URL ??
  "https://governance.cardano.org/test-proposal-2.json";
const anchorHash =
  process.env.PROPOSAL_ANCHOR_HASH ??
  "0000000000000000000000000000000000000000000000000000000000000002";

const main = async () => {
  console.log("Starting Propose Dry Run");
  console.log("========================");

  const depositAmount = process.argv[2]
    ? BigInt(process.argv[2])
    : DEFAULT_DEPOSIT;

  // TEST_PROPOSAL=<name> selects a named fixture (e.g. TEST_WITHDRAWAL_1) shared
  // with deposit.ts, so the pooled deposits and this propose target hash to the
  // same gADA token. Otherwise fall back to the NicePoll mock.
  const cosponsoredProposal: ICosponsoredProposal = selectTestProposal() ?? {
    deposit: depositAmount,
    anchor: {
      url: Buffer.from(anchorUrl).toString("hex"),
      hash: anchorHash,
    },
    action: { kind: "NicePoll" } as TGovernanceAction,
  };

  console.log("\nProposal Details:");
  console.log(`  Deposit: ${cosponsoredProposal.deposit} lovelace`);
  console.log(`  Action Kind: ${cosponsoredProposal.action.kind}`);
  console.log(`  Anchor Hash: ${cosponsoredProposal.anchor.hash}`);

  let cardanoProvider: CardanoProvider | null = null;
  try {
    console.log("\nInitializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    const blaze = cardanoProvider.getBlaze();

    console.log("Building propose transaction (two-pass fixed point)...");
    const transaction = await propose({
      blaze,
      cosponsoredProposal,
      debugMode: true,
    });

    const bodyHex = transaction.body().toCbor();
    const txCbor = transaction.toCbor();
    console.log("\n✓ Transaction built and spliced");
    console.log(`  Transaction id: ${transaction.getId()}`);
    console.log(`  Body: ${bodyHex.length / 2} bytes`);
    console.log(`  Full CBOR: ${txCbor.length / 2} bytes`);
    console.log(`  Fee: ${transaction.body().fee()} lovelace`);
    console.log(`  TTL slot: ${transaction.body().ttl()}`);

    console.log(
      "\nEvaluating the FINAL spliced transaction via the provider " +
        "(NOT submitting)...",
    );
    try {
      const redeemers = await blaze.provider.evaluateTransaction(
        transaction,
        [],
      );
      console.log("\n✓ EVALUATION SUCCEEDED — the on-chain validator accepts");
      console.log("  Actual execution units per redeemer:");
      for (const redeemer of redeemers.values()) {
        console.log(
          `    tag ${redeemer.tag()} index ${redeemer.index()}: ` +
            `mem ${redeemer.exUnits().mem()}, steps ${redeemer.exUnits().steps()}`,
        );
      }
      console.log(
        "\nNOTE: the built transaction keeps its padded stub exUnits on " +
          "purpose — rebuilding with the real units would change the " +
          "redeemers, the script_data_hash, and the transaction id.",
      );

      // Opt-in real submission. The built tx keeps padded stub exUnits >= the
      // evaluated actuals, so it stays ledger-valid (over-declaring exUnits just
      // costs a little extra fee). We only add the wallet vkey witness — the body
      // (and thus the tx id / field-20 splice) is untouched.
      if (process.env.PROPOSE_SUBMIT === "1") {
        // Submit guard: the fixture ancestor was pinned at deposit time, but
        // the ledger checks it against LIVE governance state — a mismatch
        // burns the whole gov deposit (learned the hard way: 454d1c79…).
        const action = cosponsoredProposal.action as {
          kind: string;
          ancestor?: import("@validators/Types/GovernanceAction").IGovernanceActionId | null;
        };
        await assertAncestorCurrent(action.kind, action.ancestor);
        console.log(
          "\nPROPOSE_SUBMIT=1 → signing and submitting the governance action...",
        );
        const signed = await blaze.signTransaction(transaction);
        const txId = await blaze.provider.postTransactionToChain(signed);
        console.log(`\n✓ PROPOSE SUBMITTED — governance action tx: ${txId}`);
      }
    } catch (evaluationError) {
      console.error("\n✗ EVALUATION FAILED:");
      console.error(evaluationError);
      console.error("\nDry-run transaction CBOR (for inspection):\n" + txCbor);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Propose dry run failed:", error);
    process.exitCode = 1;
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

main().catch(console.error);
