import dotenv from "dotenv";
import { CardanoProvider } from "@utils/provider";
import { Cosponsor, ICosponsoredProposal } from "@validators/Cosponsor";
import { CosponsorState } from "@validators/CosponsorState";
import { serialize } from "@blaze-cardano/data";
import { Core } from "@blaze-cardano/sdk";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "@/Config";
import * as fs from "fs";
import { parseCosponsorDatum } from "@helpers/parseCosponsorDatum";

// Define a complete token specification for withdrawal
interface TokenSpecification {
  tokenAssetName: string;
  requiredAmount: bigint; // Total amount of this token to burn
  availableAmount: bigint; // Available in wallet
  deposits: Array<{
    depositTxHash: string;
    depositOutputIndex: number;
    depositAmount: bigint;
  }>;
}

interface WithdrawalSpecification {
  tokens: TokenSpecification[];
  totalRecoveredAda: bigint;
  totalDeposits: number;
}

dotenv.config();

// === CONFIGURATION ===
// IMPORTANT: This must match DEPOSIT_AMOUNT in deposit.ts for proper validation
// 1 ADA (1,000,000 lovelace) = 1,000,000 gAda tokens (1:1 ratio)
const DEPOSIT_AMOUNT = 10_000_000n; // 10 ADA

const mockProposal: ICosponsoredProposal = {
  deposit: DEPOSIT_AMOUNT, // Use same amount as actual deposit for 1:1 validation (ADA = gAda tokens)
  anchor: {
    url: Buffer.from("https://example.com/proposal.json").toString("hex"),
    hash: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  action: {
    kind: "NicePoll",
  } as TGovernanceAction,
};

export const submitWithdrawalTransaction = async (
  cardanoProvider: CardanoProvider,
  depositTxHash: string,
  depositOutputIndex: number = 1, // Usually output index 1 for script UTxOs
  proposal?: ICosponsoredProposal,
): Promise<string> => {
  console.log("=== Submitting Withdrawal Transaction ===");
  console.log(`Deposit Transaction: ${depositTxHash}`);
  console.log(`Output Index: ${depositOutputIndex}`);

  const blaze = cardanoProvider.getBlaze();

  // First, get the actual deposit amount from the UTxO
  const depositRef = new Core.TransactionInput(
    Core.TransactionId(depositTxHash),
    BigInt(depositOutputIndex),
  );

  const depositResult = await blaze.provider.resolveUnspentOutputs([
    depositRef,
  ]);
  if (depositResult.length === 0) {
    throw new Error(
      `Deposit UTxO not found: ${depositTxHash}:${depositOutputIndex}`,
    );
  }

  const actualDepositAmount = depositResult[0].output().amount().coin();
  console.log(
    `Actual deposit amount from UTxO: ${actualDepositAmount} lovelace (${actualDepositAmount / 1_000_000n} ADA)`,
  );

  // Try to extract the actual proposal from the deposit UTxO's datum
  let cosponsoredProposal = proposal;

  if (!cosponsoredProposal) {
    try {
      console.log("\nExtracting actual proposal from deposit UTxO datum...");
      const depositUtxo = depositResult[0];
      const datum = depositUtxo.output().datum();

      if (datum && datum.kind() === 1) {
        const datumData = datum.asInlineData();
        console.log("Found inline datum, attempting to parse...");

        // Import the parsing function
        const { parse } = await import("@blaze-cardano/data");
        const { CosponsorTypes } = await import(
          "../validators/GeneratedTypes/index.js"
        );

        try {
          const parsedDatum = parse(CosponsorTypes.CosponsorDatum, datumData);

          if (
            parsedDatum &&
            typeof parsedDatum === "object" &&
            "Before" in parsedDatum &&
            parsedDatum.Before &&
            "cosponsored" in parsedDatum.Before
          ) {
            const originalProposal = parsedDatum.Before.cosponsored;

            cosponsoredProposal = {
              deposit: actualDepositAmount, // Use actual amount from UTxO
              anchor: {
                url: originalProposal.anchor.url,
                hash: originalProposal.anchor.hash,
              },
              action: originalProposal.procedure?.governanceAction || {
                kind: "Unknown",
              },
            };

            console.log(
              "✓ Successfully extracted original proposal from deposit",
            );
          } else {
            console.log(
              "⚠️ Datum doesn't contain expected proposal structure, using mock",
            );
            cosponsoredProposal = {
              ...mockProposal,
              deposit: actualDepositAmount,
            };
          }
        } catch (parseError) {
          console.log(
            `⚠️ Failed to parse datum: ${parseError.message}, using mock`,
          );
          cosponsoredProposal = {
            ...mockProposal,
            deposit: actualDepositAmount,
          };
        }
      } else {
        console.log("⚠️ No inline datum found, using mock proposal");
        cosponsoredProposal = { ...mockProposal, deposit: actualDepositAmount };
      }
    } catch (error) {
      console.log(`⚠️ Error extracting proposal: ${error.message}, using mock`);
      cosponsoredProposal = { ...mockProposal, deposit: actualDepositAmount };
    }
  }

  console.log("\nProposal Details (must match original deposit):");
  console.log(`  Deposit: ${cosponsoredProposal.deposit} lovelace`);
  console.log(`  Anchor URL: ${cosponsoredProposal.anchor.url}`);
  console.log(`  Anchor Hash: ${cosponsoredProposal.anchor.hash}`);
  console.log(`  Action Kind: ${cosponsoredProposal.action.kind}`);

  try {
    const tx = await withdraw({
      blaze,
      cosponsoredProposal,
      depositTxHash,
      depositOutputIndex,
    });

    console.log("\nBuilding withdrawal transaction...");

    const completed = await tx.complete();
    console.log("✓ Transaction built successfully");

    const signed = await blaze.signTransaction(completed);
    console.log("✓ Transaction signed");

    const txId = await blaze.provider.postTransactionToChain(signed);
    console.log(`✓ Withdrawal transaction submitted: ${txId}`);

    return txId;
  } catch (error) {
    console.error("✗ Failed to submit withdrawal transaction:", error);
    throw error;
  }
};

// Single token bulk withdrawal function
export const submitSingleTokenBulkWithdrawal = async (
  cardanoProvider: CardanoProvider,
  targetToken: string,
): Promise<string> => {
  console.log("=== Single Token Bulk Withdrawal ===");
  console.log(`🎯 Target token: ${targetToken}`);

  const blaze = cardanoProvider.getBlaze();

  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  const mockProposal = {
    deposit: 1_000_000n,
    anchor: {
      url: Buffer.from("test").toString("hex"),
      hash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    action: { kind: "NicePoll" },
  };

  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
    cosponsoredProposal: mockProposal,
  });

  // Step 1: Find all wallet gAda tokens for this specific token
  console.log("\n🪙 Step 1: Finding target gAda tokens in wallet...");
  const walletUtxos = await blaze.wallet.getUnspentOutputs();
  const gAdaPolicyId = cosponsor.script().hash();
  const expectedTokenKey = gAdaPolicyId + targetToken;

  let totalGAdaAmount = 0n;
  let tokenCount = 0;

  for (let i = 0; i < walletUtxos.length; i++) {
    const utxo = walletUtxos[i];
    const multiasset = utxo.output().amount().multiasset();

    if (multiasset) {
      for (const [key, value] of multiasset.entries()) {
        if (key === expectedTokenKey) {
          const tokenAmount = typeof value === "bigint" ? value : BigInt(value);
          totalGAdaAmount += tokenAmount;
          tokenCount++;
          console.log(
            `   ✅ Found ${tokenAmount / 1_000_000n} gAda in UTxO ${i}`,
          );
        }
      }
    }
  }

  if (totalGAdaAmount === 0n) {
    throw new Error(`No tokens found for ${targetToken}`);
  }

  console.log(
    `💰 Total available: ${totalGAdaAmount / 1_000_000n} gAda (${tokenCount} UTxOs)`,
  );

  // Step 2: Find all matching deposits at script address
  console.log("\n🏗️  Step 2: Finding matching deposits at script address...");
  const scriptAddress = cosponsor.address(blaze.provider.network);
  console.log(`📍 Script address: ${scriptAddress.toBech32()}`);

  const scriptUtxos = await blaze.provider.getUnspentOutputs(scriptAddress);
  console.log(`📊 Found ${scriptUtxos.length} unspent UTxOs at script address`);

  const matchingDeposits: Array<{
    depositTxHash: string;
    depositOutputIndex: number;
    depositAmount: bigint;
    proposal: ICosponsoredProposal;
  }> = [];

  for (let i = 0; i < scriptUtxos.length; i++) {
    const scriptUtxo = scriptUtxos[i];
    const depositTxId = scriptUtxo.input().transactionId();
    const depositOutputIndex = Number(scriptUtxo.input().index());
    const depositAmount = scriptUtxo.output().amount().coin();
    const datum = scriptUtxo.output().datum();

    if (datum && datum.kind() === 1) {
      const inlineDatum = datum.asInlineData();
      if (inlineDatum) {
        const parsedResult = parseCosponsorDatum(inlineDatum);
        if (parsedResult) {
          // Calculate the expected token for this deposit
          const expectedTokenAssetName = serialize(
            CosponsorTypes.CosponsoredProposalProcedure,
            parsedResult.rawCosponsoredProposal,
          ).hash();

          if (expectedTokenAssetName === targetToken) {
            console.log(
              `   ✅ Match found: ${depositTxId.slice(0, 16)}:${depositOutputIndex} (${depositAmount / 1_000_000n} ADA)`,
            );
            matchingDeposits.push({
              depositTxHash: depositTxId,
              depositOutputIndex,
              depositAmount,
              proposal: parsedResult.proposal,
            });
          }
        }
      }
    }
  }

  if (matchingDeposits.length === 0) {
    throw new Error(`No matching deposits found for token ${targetToken}`);
  }

  const totalDepositAmount = matchingDeposits.reduce(
    (sum, d) => sum + d.depositAmount,
    0n,
  );
  console.log(`🎯 Found ${matchingDeposits.length} matching deposits`);
  console.log(`💰 Total deposit value: ${totalDepositAmount / 1_000_000n} ADA`);

  // Verify we have enough tokens
  if (totalGAdaAmount < totalDepositAmount) {
    throw new Error(
      `Insufficient gAda tokens: have ${totalGAdaAmount / 1_000_000n}, need ${totalDepositAmount / 1_000_000n}`,
    );
  }

  // Step 3: Execute batch withdrawal
  console.log("\n🔄 Step 3: Executing batch withdrawal...");
  console.log(
    `   📋 Withdrawing ${matchingDeposits.length} deposits in a single transaction`,
  );

  const tx = await bulkWithdraw({
    blaze,
    cosponsoredProposal: matchingDeposits[0].proposal, // Use first proposal (they should all be the same)
    expectedTokenAssetName: targetToken,
    deposits: matchingDeposits.map((d) => ({
      depositTxHash: d.depositTxHash,
      depositOutputIndex: d.depositOutputIndex,
      depositAmount: d.depositAmount,
    })),
  });

  console.log(`   📝 Bulk withdrawal transaction built successfully`);

  const completed = await tx.complete();
  console.log(`   ✅ Transaction completed`);

  const signed = await blaze.signTransaction(completed);
  console.log(`   🔏 Transaction signed`);

  const txId = await blaze.provider.postTransactionToChain(signed);
  console.log(`   🎉 SUCCESS: ${txId}`);
  console.log(
    `   💰 Recovered ${totalDepositAmount / 1_000_000n} ADA from ${matchingDeposits.length} deposits!`,
  );

  // Save transaction details
  const txDetails = {
    timestamp: new Date().toISOString(),
    txId,
    targetToken,
    depositsWithdrawn: matchingDeposits.length,
    totalRecovered: totalDepositAmount.toString(),
    recoveredAda: (totalDepositAmount / 1_000_000n).toString(),
    deposits: matchingDeposits.map((d) => ({
      txHash: d.depositTxHash,
      outputIndex: d.depositOutputIndex,
      amount: d.depositAmount.toString(),
    })),
  };

  fs.writeFileSync(
    "./single-token-withdrawal.json",
    JSON.stringify(txDetails, null, 2),
  );
  console.log(`💾 Transaction details saved to ./single-token-withdrawal.json`);

  return txId;
};

// Create a complete withdrawal specification from available tokens and deposits
export const createWithdrawalSpecification = async (
  cardanoProvider: CardanoProvider,
): Promise<WithdrawalSpecification> => {
  console.log("=== Creating Complete Withdrawal Specification ===");

  const blaze = cardanoProvider.getBlaze();

  // Step 1: Get all gAda tokens in wallet
  console.log("\n🪙 Step 1: Analyzing all gAda tokens in wallet...");
  const walletUtxos = await blaze.wallet.getUnspentOutputs();
  const gAdaPolicyId =
    "87264e48adc75c4472c4e52e80acd36051ca153f42ee339fb04f5a28";

  const walletTokens = new Map<string, bigint>(); // tokenAssetName -> totalAmount

  for (const utxo of walletUtxos) {
    const multiasset = utxo.output().amount().multiasset();
    if (multiasset) {
      for (const [assetId, amount] of multiasset.entries()) {
        if (assetId.startsWith(gAdaPolicyId)) {
          const tokenAssetName = assetId.substring(56); // Remove policy prefix
          const tokenAmount =
            typeof amount === "bigint" ? amount : BigInt(amount);
          walletTokens.set(
            tokenAssetName,
            (walletTokens.get(tokenAssetName) || 0n) + tokenAmount,
          );
        }
      }
    }
  }

  console.log(`📊 Found ${walletTokens.size} different gAda token types:`);
  for (const [tokenName, amount] of walletTokens.entries()) {
    console.log(
      `   💰 ${tokenName.slice(0, 20)}... = ${amount / 1_000_000n} gAda`,
    );
  }

  // Step 2: Read current deposit index
  console.log("\n🏗️  Step 2: Reading current deposit index...");
  let depositIndex: any;
  try {
    const indexData = fs.readFileSync("./deposit-index.json", "utf8");
    depositIndex = JSON.parse(indexData);
    console.log(`📋 Found ${depositIndex.totalDeposits} deposits in index`);
  } catch (error) {
    throw new Error(`Could not read deposit index: ${error.message}`);
  }

  // Step 3: Group deposits by token type and match with wallet tokens
  console.log("\n🎯 Step 3: Matching wallet tokens to deposits...");
  const tokenSpecs = new Map<string, TokenSpecification>();

  for (const deposit of depositIndex.deposits) {
    if (deposit.spentStatus === "available") {
      const tokenName = deposit.tokenAssetName;
      const depositAmount = BigInt(deposit.depositAmount);

      if (!tokenSpecs.has(tokenName)) {
        tokenSpecs.set(tokenName, {
          tokenAssetName: tokenName,
          requiredAmount: 0n,
          availableAmount: walletTokens.get(tokenName) || 0n,
          deposits: [],
        });
      }

      const spec = tokenSpecs.get(tokenName)!;
      spec.requiredAmount += depositAmount;
      spec.deposits.push({
        depositTxHash: deposit.depositTxId,
        depositOutputIndex: deposit.depositOutputIndex,
        depositAmount: depositAmount,
      });
    }
  }

  // Step 4: Filter to only tokens we can fully withdraw
  console.log("\n✅ Step 4: Filtering to withdrawable tokens...");
  const withdrawableTokens: TokenSpecification[] = [];
  let totalRecoveredAda = 0n;
  let totalDeposits = 0;

  for (const [tokenName, spec] of tokenSpecs.entries()) {
    if (spec.availableAmount >= spec.requiredAmount) {
      console.log(
        `   ✅ ${tokenName.slice(0, 20)}... - Can withdraw ${spec.requiredAmount / 1_000_000n} gAda from ${spec.deposits.length} deposits`,
      );
      withdrawableTokens.push(spec);
      totalRecoveredAda += spec.requiredAmount;
      totalDeposits += spec.deposits.length;
    } else {
      console.log(
        `   ❌ ${tokenName.slice(0, 20)}... - Need ${spec.requiredAmount / 1_000_000n}, have ${spec.availableAmount / 1_000_000n}`,
      );
    }
  }

  const specification: WithdrawalSpecification = {
    tokens: withdrawableTokens,
    totalRecoveredAda,
    totalDeposits,
  };

  console.log(`\n📊 COMPLETE WITHDRAWAL SPECIFICATION:`);
  console.log(`   🎯 ${withdrawableTokens.length} token types`);
  console.log(`   💰 ${totalRecoveredAda / 1_000_000n} ADA to recover`);
  console.log(`   📋 ${totalDeposits} deposits total`);

  return specification;
};

// Execute withdrawal based on complete specification
export const executeSpecifiedWithdrawal = async (
  cardanoProvider: CardanoProvider,
  spec: WithdrawalSpecification,
): Promise<string> => {
  console.log("=== Executing Specified Multi-Token Withdrawal ===");
  console.log(
    `🎯 Withdrawing ${spec.tokens.length} token types in ONE transaction`,
  );

  const blaze = cardanoProvider.getBlaze();

  // Create the token groups for multiTokenBulkWithdraw
  const tokenGroups = spec.tokens.map((tokenSpec) => {
    // Create a mock proposal (they should all be the same)
    const mockProposal: ICosponsoredProposal = {
      deposit: tokenSpec.requiredAmount,
      anchor: {
        url: "https://example.com/proposal.json",
        hash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
      action: { NicePoll: null } as TGovernanceAction,
    };

    return {
      expectedTokenAssetName: tokenSpec.tokenAssetName,
      cosponsoredProposal: mockProposal,
      deposits: tokenSpec.deposits,
    };
  });

  console.log(
    `🚀 Building transaction for ${spec.totalDeposits} deposits across ${spec.tokens.length} token types...`,
  );

  const tx = await multiTokenBulkWithdraw({
    blaze,
    tokenGroups,
  });

  console.log(`📝 Multi-token withdrawal transaction built successfully`);

  const completed = await tx.complete();
  console.log(`✅ Transaction completed`);

  const signed = await blaze.signTransaction(completed);
  console.log(`🔏 Transaction signed`);

  const txId = await blaze.provider.postTransactionToChain(signed);
  console.log(`🎉 SUCCESS: ${txId}`);
  console.log(
    `💰 Recovered ${spec.totalRecoveredAda / 1_000_000n} ADA from ${spec.totalDeposits} deposits in ONE transaction!`,
  );

  // Save transaction details
  const txDetails = {
    timestamp: new Date().toISOString(),
    txId,
    tokenTypes: spec.tokens.length,
    depositsWithdrawn: spec.totalDeposits,
    totalRecovered: spec.totalRecoveredAda.toString(),
    recoveredAda: (spec.totalRecoveredAda / 1_000_000n).toString(),
    tokens: spec.tokens.map((t) => ({
      assetName: t.tokenAssetName,
      requiredAmount: t.requiredAmount.toString(),
      deposits: t.deposits.length,
    })),
  };

  fs.writeFileSync(
    "./specified-multi-token-withdrawal.json",
    JSON.stringify(txDetails, null, 2),
  );
  console.log(
    `💾 Transaction details saved to ./specified-multi-token-withdrawal.json`,
  );

  return txId;
};

// Index-based multi-token withdrawal function
export const submitIndexedMultiTokenWithdrawal = async (
  cardanoProvider: CardanoProvider,
  maxPositions: number = 10,
): Promise<string> => {
  console.log("=== Index-based Multi-Token Withdrawal ===");
  console.log(`🎯 Target positions: ${maxPositions}`);

  // Step 1: Read deposit index
  console.log("\n📋 Step 1: Reading deposit index...");
  let depositIndex: any;
  try {
    const indexData = fs.readFileSync("./deposit-index.json", "utf8");
    depositIndex = JSON.parse(indexData);
    console.log(`✅ Found ${depositIndex.totalDeposits} deposits in index`);
  } catch (error) {
    throw new Error(`Could not read deposit index: ${error.message}`);
  }

  // Step 2: Select first 10 available deposits with different token types
  console.log("\n🎯 Step 2: Selecting unique token positions...");
  const seenTokens = new Set<string>();
  let selectedDeposits: any[] = [];

  for (const deposit of depositIndex.deposits) {
    if (
      deposit.spentStatus === "available" &&
      !seenTokens.has(deposit.tokenAssetName)
    ) {
      selectedDeposits.push(deposit);
      seenTokens.add(deposit.tokenAssetName);
      console.log(
        `   📌 Selected: ${deposit.tokenAssetName.slice(0, 20)}... (${BigInt(deposit.depositAmount) / 1_000_000n} ADA)`,
      );

      if (selectedDeposits.length >= maxPositions) break;
    }
  }

  if (selectedDeposits.length === 0) {
    throw new Error("No available deposits found in index");
  }

  console.log(`🎯 Selected ${selectedDeposits.length} unique token positions`);
  const totalAmount = selectedDeposits.reduce(
    (sum, d) => sum + BigInt(d.depositAmount),
    0n,
  );
  console.log(`💰 Total value: ${totalAmount / 1_000_000n} ADA`);

  // Step 3: Verify wallet has required gAda tokens
  console.log("\n🔍 Step 3: Verifying wallet has required gAda tokens...");
  const blaze = cardanoProvider.getBlaze();
  const walletUtxos = await blaze.wallet.getUnspentOutputs();

  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  const mockProposal = {
    deposit: 1_000_000n,
    anchor: {
      url: Buffer.from("test").toString("hex"),
      hash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    action: { kind: "NicePoll" },
  };

  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
    cosponsoredProposal: mockProposal,
  });

  const gAdaPolicyId = cosponsor.script().hash();
  const requiredTokens = new Set(selectedDeposits.map((d) => d.tokenAssetName));

  // Check if wallet has all required gAda tokens
  const walletGAdaTokens = new Map<string, bigint>();

  for (const utxo of walletUtxos) {
    const multiasset = utxo.output().amount().multiasset();
    if (multiasset) {
      for (const [assetId, amount] of multiasset.entries()) {
        if (assetId.startsWith(gAdaPolicyId)) {
          const assetName = assetId.substring(56);
          if (requiredTokens.has(assetName)) {
            const tokenAmount =
              typeof amount === "bigint" ? amount : BigInt(amount);
            const current = walletGAdaTokens.get(assetName) || 0n;
            walletGAdaTokens.set(assetName, current + tokenAmount);
          }
        }
      }
    }
  }

  // Verify we have all required tokens
  let missingTokens = 0;
  for (const deposit of selectedDeposits) {
    const walletAmount = walletGAdaTokens.get(deposit.tokenAssetName) || 0n;
    const requiredAmount = BigInt(deposit.depositAmount);
    if (walletAmount < requiredAmount) {
      console.log(
        `❌ Missing gAda for ${deposit.tokenAssetName.slice(0, 20)}: have ${walletAmount / 1_000_000n}, need ${requiredAmount / 1_000_000n}`,
      );
      missingTokens++;
    } else {
      console.log(
        `✅ Have enough gAda for ${deposit.tokenAssetName.slice(0, 20)}: ${walletAmount / 1_000_000n} gAda`,
      );
    }
  }

  if (missingTokens > 0) {
    console.log(
      `⚠️  ${missingTokens} positions don't have required tokens, proceeding with ${selectedDeposits.length - missingTokens} available positions`,
    );
    // Filter out deposits we don't have tokens for
    selectedDeposits = selectedDeposits.filter((deposit) => {
      const walletAmount = walletGAdaTokens.get(deposit.tokenAssetName) || 0n;
      const requiredAmount = BigInt(deposit.depositAmount);
      return walletAmount >= requiredAmount;
    });
  }

  if (selectedDeposits.length === 0) {
    throw new Error("No positions have sufficient gAda tokens");
  }

  // Recalculate total after filtering
  const finalTotalAmount = selectedDeposits.reduce(
    (sum, d) => sum + BigInt(d.depositAmount),
    0n,
  );
  console.log(`💰 Final total value: ${finalTotalAmount / 1_000_000n} ADA`);

  // Step 4: Execute multi-token bulk withdrawal
  console.log(
    `\n🚀 Step 4: Executing multi-token withdrawal for ${selectedDeposits.length} positions...`,
  );

  // Convert to format expected by multiTokenBulkWithdraw
  const tokenGroups: Array<{
    expectedTokenAssetName: string;
    cosponsoredProposal: ICosponsoredProposal;
    deposits: Array<{
      depositTxHash: string;
      depositOutputIndex: number;
      depositAmount: bigint;
    }>;
  }> = selectedDeposits.map((deposit) => ({
    expectedTokenAssetName: deposit.tokenAssetName,
    cosponsoredProposal: {
      deposit: BigInt(deposit.depositAmount),
      anchor: {
        url: deposit.proposalUrl
          ? Buffer.from(deposit.proposalUrl).toString("hex")
          : Buffer.from("test").toString("hex"),
        hash:
          deposit.proposalHash ||
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      action: { kind: "NicePoll" },
    },
    deposits: [
      {
        depositTxHash: deposit.depositTxId,
        depositOutputIndex: deposit.depositOutputIndex,
        depositAmount: BigInt(deposit.depositAmount),
      },
    ],
  }));

  const tx = await multiTokenBulkWithdraw({
    blaze,
    tokenGroups,
  });

  console.log(`📝 Multi-token bulk withdrawal transaction built successfully`);

  const completed = await tx.complete();
  console.log(`✅ Transaction completed`);

  const signed = await blaze.signTransaction(completed);
  console.log(`🔏 Transaction signed`);

  const txId = await blaze.provider.postTransactionToChain(signed);
  console.log(`🎉 SUCCESS: ${txId}`);
  console.log(
    `💰 Recovered ${finalTotalAmount / 1_000_000n} ADA from ${selectedDeposits.length} positions in ONE transaction!`,
  );

  // Save transaction details
  const txDetails = {
    timestamp: new Date().toISOString(),
    mode: "indexed-multi-token-withdrawal",
    txId,
    positionsWithdrawn: selectedDeposits.length,
    totalRecovered: finalTotalAmount.toString(),
    recoveredAda: (finalTotalAmount / 1_000_000n).toString(),
    positions: selectedDeposits.map((d) => ({
      tokenAssetName: d.tokenAssetName,
      txHash: d.depositTxId,
      outputIndex: d.depositOutputIndex,
      amount: d.depositAmount,
    })),
  };

  fs.writeFileSync(
    "./indexed-multi-token-withdrawal.json",
    JSON.stringify(txDetails, null, 2),
  );
  console.log(
    `💾 Transaction details saved to ./indexed-multi-token-withdrawal.json`,
  );

  return txId;
};

// Multi-token bulk withdrawal function (LEGACY - multiple transactions)
export const submitMultiTokenBulkWithdrawal = async (
  cardanoProvider: CardanoProvider,
  maxConcurrentTransactions: number = 5,
): Promise<string[]> => {
  console.log("=== Multi-Token Bulk Withdrawal ===");
  console.log(`🎯 Max concurrent transactions: ${maxConcurrentTransactions}`);

  const blaze = cardanoProvider.getBlaze();

  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  const mockProposal = {
    deposit: 1_000_000n,
    anchor: {
      url: Buffer.from("test").toString("hex"),
      hash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    action: { kind: "NicePoll" },
  };

  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
    cosponsoredProposal: mockProposal,
  });

  // Step 1: Find all gAda tokens in wallet
  console.log("\n🪙 Step 1: Finding all gAda tokens in wallet...");
  const walletUtxos = await blaze.wallet.getUnspentOutputs();
  const gAdaPolicyId = cosponsor.script().hash();
  console.log(`🔍 Looking for tokens with policy ID: ${gAdaPolicyId}`);

  const gAdaTokens: Array<{ assetName: string; amount: bigint }> = [];

  // Scan wallet for gAda tokens
  for (let i = 0; i < walletUtxos.length; i++) {
    const utxo = walletUtxos[i];
    const multiasset = utxo.output().amount().multiasset();

    if (multiasset) {
      for (const [assetId, amount] of multiasset.entries()) {
        if (assetId.startsWith(gAdaPolicyId)) {
          const assetName = assetId.substring(56);
          const tokenAmount =
            typeof amount === "bigint" ? amount : BigInt(amount);

          // Check if we already have this token (aggregate amounts from different UTxOs)
          const existing = gAdaTokens.find((t) => t.assetName === assetName);
          if (existing) {
            existing.amount += tokenAmount;
          } else {
            gAdaTokens.push({ assetName, amount: tokenAmount });
          }
        }
      }
    }
  }

  console.log(`✅ Found ${gAdaTokens.length} unique gAda token types`);
  console.log(
    `💰 Total gAda: ${gAdaTokens.reduce((sum, t) => sum + t.amount, 0n) / 1_000_000n} gAda`,
  );

  // Step 2: Find matching deposits for each token
  console.log("\n🏗️  Step 2: Finding matching deposits for each token...");
  const scriptAddress = cosponsor.address(blaze.provider.network);
  console.log(`📍 Script address: ${scriptAddress.toBech32()}`);

  const scriptUtxos = await blaze.provider.getUnspentOutputs(scriptAddress);
  console.log(`📊 Found ${scriptUtxos.length} unspent UTxOs at script address`);

  // Group deposits by token
  const tokenToDeposits = new Map<
    string,
    Array<{
      depositTxHash: string;
      depositOutputIndex: number;
      depositAmount: bigint;
      proposal: ICosponsoredProposal;
    }>
  >();

  for (const scriptUtxo of scriptUtxos) {
    const depositTxId = scriptUtxo.input().transactionId();
    const depositOutputIndex = Number(scriptUtxo.input().index());
    const depositAmount = scriptUtxo.output().amount().coin();
    const datum = scriptUtxo.output().datum();

    if (datum && datum.kind() === 1) {
      const inlineDatum = datum.asInlineData();
      if (inlineDatum) {
        const parsedResult = parseCosponsorDatum(inlineDatum);
        if (parsedResult) {
          const expectedTokenAssetName = serialize(
            CosponsorTypes.CosponsoredProposalProcedure,
            parsedResult.rawCosponsoredProposal,
          ).hash();

          // Check if we have this token in our wallet
          const walletToken = gAdaTokens.find(
            (t) => t.assetName === expectedTokenAssetName,
          );
          if (walletToken) {
            if (!tokenToDeposits.has(expectedTokenAssetName)) {
              tokenToDeposits.set(expectedTokenAssetName, []);
            }

            tokenToDeposits.get(expectedTokenAssetName)!.push({
              depositTxHash: depositTxId,
              depositOutputIndex,
              depositAmount,
              proposal: parsedResult.proposal,
            });
          }
        }
      }
    }
  }

  console.log(
    `🎯 Found deposits for ${tokenToDeposits.size} tokens that we own`,
  );

  // Step 3: Execute bulk withdrawals for each token group
  console.log("\n🔄 Step 3: Executing bulk withdrawals...");
  const completedTxIds: string[] = [];
  let processedCount = 0;

  for (const [tokenAssetName, deposits] of tokenToDeposits.entries()) {
    if (processedCount >= maxConcurrentTransactions) {
      console.log(
        `⏹️  Reached max concurrent transactions limit (${maxConcurrentTransactions})`,
      );
      break;
    }

    try {
      console.log(
        `\n🎯 Processing token ${processedCount + 1}/${Math.min(tokenToDeposits.size, maxConcurrentTransactions)}: ${tokenAssetName.slice(0, 20)}...`,
      );
      console.log(`   📋 Withdrawing ${deposits.length} deposits`);

      const totalDepositAmount = deposits.reduce(
        (sum, d) => sum + d.depositAmount,
        0n,
      );
      console.log(
        `   💰 Total deposit value: ${totalDepositAmount / 1_000_000n} ADA`,
      );

      const tx = await bulkWithdraw({
        blaze,
        cosponsoredProposal: deposits[0].proposal,
        expectedTokenAssetName: tokenAssetName,
        deposits: deposits.map((d) => ({
          depositTxHash: d.depositTxHash,
          depositOutputIndex: d.depositOutputIndex,
          depositAmount: d.depositAmount,
        })),
      });

      const completed = await tx.complete();
      const signed = await blaze.signTransaction(completed);
      const txId = await blaze.provider.postTransactionToChain(signed);

      console.log(`   🎉 SUCCESS: ${txId}`);
      console.log(
        `   💰 Recovered ${totalDepositAmount / 1_000_000n} ADA from ${deposits.length} deposits!`,
      );

      completedTxIds.push(txId);
      processedCount++;
    } catch (error) {
      console.log(
        `   ❌ FAILED for token ${tokenAssetName.slice(0, 20)}...: ${error.message}`,
      );
      // Continue with next token group
    }
  }

  // Save summary
  const summary = {
    timestamp: new Date().toISOString(),
    mode: "multi-token-bulk",
    totalTokensProcessed: processedCount,
    totalTokensAvailable: tokenToDeposits.size,
    successfulTransactions: completedTxIds.length,
    transactionIds: completedTxIds,
  };

  fs.writeFileSync(
    "./multi-token-withdrawal-summary.json",
    JSON.stringify(summary, null, 2),
  );
  console.log(`💾 Summary saved to ./multi-token-withdrawal-summary.json`);

  console.log(`\n📊 Final Summary:`);
  console.log(`   ✅ Successful withdrawals: ${completedTxIds.length}`);
  console.log(`   📊 Total transactions: ${completedTxIds.length}`);

  return completedTxIds;
};

// Simple wrapper functions for different withdrawal modes
export const runSingleWithdrawal = async (
  depositTxHash: string,
  depositOutputIndex: number = 1,
) => {
  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    return await submitWithdrawalTransaction(
      cardanoProvider,
      depositTxHash,
      depositOutputIndex,
    );
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

export const runSingleTokenBulkWithdrawal = async (targetToken: string) => {
  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    return await submitSingleTokenBulkWithdrawal(cardanoProvider, targetToken);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

export const runIndexedMultiTokenWithdrawal = async (
  maxPositions: number = 10,
) => {
  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    return await submitIndexedMultiTokenWithdrawal(
      cardanoProvider,
      maxPositions,
    );
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

export const runMultiTokenBulkWithdrawal = async (
  maxConcurrentTransactions: number = 5,
) => {
  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    return await submitMultiTokenBulkWithdrawal(
      cardanoProvider,
      maxConcurrentTransactions,
    );
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

export const runSpecifiedWithdrawal = async () => {
  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    // First create the complete specification
    const spec = await createWithdrawalSpecification(cardanoProvider);

    if (spec.tokens.length === 0) {
      console.log("❌ No withdrawable tokens found");
      return null;
    }

    // Then execute the complete withdrawal in one transaction
    return await executeSpecifiedWithdrawal(cardanoProvider, spec);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

const main = async () => {
  console.log("Starting Withdrawal Script");
  console.log("=========================");

  // For testing - uncomment the function you want to run:

  // Single deposit withdrawal (original functionality):
  // await runSingleWithdrawal("10386c278fd4eb72bbbe3bdaa2b52488ac0e43b69bb73025b15f8bab42bf3854", 1)

  // Single token bulk withdrawal:
  // await runSingleTokenBulkWithdrawal("8b89e250694eddd14e020601a4f11087f377b74fe6e64293c35c1bd8b630c058")

  // Index-based multi-token withdrawal (single transaction for 10 positions):
  await runIndexedMultiTokenWithdrawal(10);
};

// Run main if this script is executed directly
if (
  process.argv[1] &&
  import.meta.url.includes(process.argv[1].replace(/\\/g, "/"))
) {
  main().catch(console.error);
}
