import dotenv from "dotenv";
import { CardanoProvider } from "@utils/provider";
import { deposit } from "@transactions/index";
import { ICosponsoredProposal } from "@validators/index";
import { TGovernanceAction } from "@validators/Types/GovernanceAction";
import { MIN_PROVIDER_BALANCE } from "@/Config";
import { selectTestProposal } from "./test-proposals";

dotenv.config();

// === CONFIGURATION ===
// Deposit amount for both ADA and gAda tokens (1:1 ratio)
// 1 ADA (1,000,000 lovelace) = 1,000,000 gAda tokens
const DEPOSIT_AMOUNT = 150_000_000n; // 10 ADA - Change this to adjust deposit amount

const mockProposal: ICosponsoredProposal = {
  deposit: DEPOSIT_AMOUNT, // Use same amount for 1:1 ratio validation (ADA = gAda tokens)
  anchor: {
    url: Buffer.from(
      "https://governance.cardano.org/test-proposal-2.json",
    ).toString("hex"),
    hash: "0000000000000000000000000000000000000000000000000000000000000002",
  },
  action: {
    kind: "NicePoll",
  } as TGovernanceAction,
};

export const submitDepositTransaction = async (
  cardanoProvider: CardanoProvider,
  depositAmount: bigint = DEPOSIT_AMOUNT,
  proposal?: ICosponsoredProposal,
): Promise<string> => {
  console.log("=== Submitting Deposit Transaction ===");
  console.log(`Deposit Amount: ${depositAmount} lovelace`);

  const cosponsoredProposal = proposal || {
    ...mockProposal,
    deposit: depositAmount, // Use the actual deposit amount passed in
  };

  console.log("\nProposal Details:");
  console.log(`  Deposit: ${cosponsoredProposal.deposit} lovelace`);
  console.log(`  Anchor URL: ${cosponsoredProposal.anchor.url}`);
  console.log(`  Anchor Hash: ${cosponsoredProposal.anchor.hash}`);
  console.log(`  Action Kind: ${cosponsoredProposal.action.kind}`);

  try {
    const blaze = cardanoProvider.getBlaze();

    const tx = await deposit({
      blaze,
      cosponsoredProposal,
      depositAmount,
    });

    console.log("\nBuilding transaction...");

    const completed = await tx.complete();
    console.log("✓ Transaction built successfully");

    const signed = await blaze.signTransaction(completed);
    console.log("✓ Transaction signed");

    const txId = await blaze.provider.postTransactionToChain(signed);
    console.log(`✓ Transaction submitted: ${txId}`);

    return txId;
  } catch (error) {
    console.error("✗ Failed to submit deposit transaction:", error);
    throw error;
  }
};

const main = async () => {
  console.log("Starting Deposit Script");
  console.log("=====================");

  let cardanoProvider: CardanoProvider | null = null;

  try {
    // Initialize provider from environment
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    // TEST_PROPOSAL=<name> pools toward a named fixture (e.g. TEST_WITHDRAWAL_1)
    // shared with propose-dry-run.ts, using its own `deposit` as the amount so
    // the pooled Before UTxO hashes to the same gADA token the propose expects.
    const testProposal = selectTestProposal();
    const depositAmount = testProposal ? testProposal.deposit : BigInt(DEPOSIT_AMOUNT);

    console.log(`Deposit amount: ${depositAmount} lovelace`);
    if (testProposal) {
      console.log(`Using TEST_PROPOSAL: ${process.env.TEST_PROPOSAL}`);
    }

    // Check balance
    const balance = await cardanoProvider.getWalletBalance();
    if (balance.balance < depositAmount + MIN_PROVIDER_BALANCE) {
      throw new Error(
        `Insufficient balance. Need at least ${depositAmount + MIN_PROVIDER_BALANCE} lovelace, have ${balance.balance}`,
      );
    }

    // Submit deposit transaction
    await submitDepositTransaction(cardanoProvider, depositAmount, testProposal);
  } catch (error) {
    console.error("Deposit script failed:", error);
    process.exit(1);
  } finally {
    // Cleanup
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

// Run main if this script is executed directly
main().catch(console.error);

export default submitDepositTransaction;
