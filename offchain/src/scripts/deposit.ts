import dotenv                 from 'dotenv'
import { CardanoProvider }    from '../utils/provider'
import { deposit }            from '../transactions/Deposit'
import {
  ICosponsoredProposal
}                             from '../validators/Cosponsor'
import { TGovernanceAction }  from '../validators/Types/GovernanceAction'

dotenv.config()

const mockProposal: ICosponsoredProposal = {
  deposit: 100_000_000n,
  anchor: {
    url: "https://example.com/proposal.json",
    hash: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  action: {
    type: "TreasuryWithdrawal",
    withdrawals: new Map([
      ["stake1u9r76vqdhvezwc7ypeheaantm3pd7v5s9jx7tgn68w78c6qnlqc3e", 1_000_000_000n],
    ]),
    guardrailsPolicy: null,
  } as TGovernanceAction,
}

export const submitDepositTransaction = async (
  cardanoProvider: CardanoProvider,
  depositAmount: bigint = 10_000_000n,
  proposal?: ICosponsoredProposal
): Promise<string> => {
  console.log("=== Submitting Deposit Transaction ===")
  console.log(`Deposit Amount: ${depositAmount} lovelace`)
  
  const cosponsoredProposal = proposal || mockProposal
  
  console.log("\nProposal Details:");
  console.log(`  Deposit: ${cosponsoredProposal.deposit} lovelace`)
  console.log(`  Anchor URL: ${cosponsoredProposal.anchor.url}`)
  console.log(`  Anchor Hash: ${cosponsoredProposal.anchor.hash}`)
  console.log(`  Action Type: ${cosponsoredProposal.action.type}`)
  
  try {
    const blaze = cardanoProvider.getBlaze();
    
    const tx = await deposit({
      blaze,
      cosponsoredProposal,
      depositAmount,
    });
    
    console.log("\nBuilding transaction...")
    
    const completed = await tx.complete();
    console.log("✓ Transaction built successfully")
    
    const signed = await blaze.signTransaction(completed)
    console.log("✓ Transaction signed")
    
    const txId = await blaze.provider.postTransactionToChain(signed)
    console.log(`✓ Transaction submitted: ${txId}`)
    
    return txId
  } catch (error) {
    console.error("✗ Failed to submit deposit transaction:", error)
    throw error
  }
}

const main = async () => {
  console.log("Starting Deposit Script");
  console.log("=====================");
  
  let cardanoProvider: CardanoProvider | null = null;
  
  try {
    // Initialize provider from environment
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");
    
    const depositAmount = process.env.DEPOSIT_AMOUNT 
      ? BigInt(process.env.DEPOSIT_AMOUNT) 
      : 10_000_000n;

    console.log(`Deposit amount: ${depositAmount} lovelace`);
    
    // Check balance
    const balance = await cardanoProvider.getWalletBalance();
    if (balance.balance < depositAmount + 5_000_000n) {
      throw new Error(`Insufficient balance. Need at least ${depositAmount + 5_000_000n} lovelace, have ${balance.balance}`);
    }
    
    // Submit deposit transaction
    await submitDepositTransaction(cardanoProvider, depositAmount);
    
  } catch (error) {
    console.error("Deposit script failed:", error);
    process.exit(1);
  } finally {
    // Cleanup
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
}

// Run main if this script is executed directly
main().catch(console.error)

export default submitDepositTransaction;
