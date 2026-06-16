import { CardanoProvider } from "@utils/provider";
import { Cosponsor, ICosponsoredProposal } from "@validators/index";
import { CosponsorState } from "@validators/CosponsorState";
import { CosponsorTypes } from "@validators/GeneratedTypes";
import { serialize } from "@blaze-cardano/data";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "@/Config";
import {
  DepositInfo,
  DepositIndex,
  WalletToken,
  WalletTokens,
} from "../../types";
import * as fs from "fs";
import { parseCosponsorDatum } from "@helpers/parseCosponsorDatum";
import { extractInlineDatum } from "@helpers/datumUtils";

// Main indexer class
export class DepositIndexer {
  private cardanoProvider: CardanoProvider;
  private gAdaPolicyId: string;

  constructor(cardanoProvider: CardanoProvider) {
    this.cardanoProvider = cardanoProvider;
    // This will be set when we create the cosponsor instance
    this.gAdaPolicyId = "";
  }

  // Derive token info from deposits (wallet scanning is redundant)
  deriveTokensFromDeposits(deposits: DepositInfo[]): WalletTokens {
    console.log("Deriving required token info from deposits...");

    // Group deposits by token type to calculate required amounts
    const tokenMap = new Map<string, bigint>();

    for (const deposit of deposits) {
      const existing = tokenMap.get(deposit.tokenAssetName) || 0n;
      tokenMap.set(
        deposit.tokenAssetName,
        existing + BigInt(deposit.depositAmount),
      );
    }

    // Convert to WalletToken format
    const tokens: WalletToken[] = [];
    for (const [assetName, totalAmount] of tokenMap.entries()) {
      tokens.push({
        assetName,
        amount: totalAmount.toString(),
        utxoRef: "derived-from-deposits", // Not applicable since we're deriving from deposits
      });
    }

    const walletTokens: WalletTokens = {
      timestamp: new Date().toISOString(),
      totalTokens: tokens.length,
      policyId: this.gAdaPolicyId,
      tokens,
    };

    console.log(`Derived ${tokens.length} token types from deposits`);
    console.log(
      `Total required: ${tokens.reduce((sum, t) => sum + BigInt(t.amount), 0n) / 1_000_000n} gAda`,
    );

    return walletTokens;
  }

  // Scan script address for all deposits
  async scanDeposits(): Promise<DepositIndex> {
    console.log("Scanning script address for deposits...");

    const blaze = this.cardanoProvider.getBlaze();

    // Create cosponsor instance to get script address
    const cosponsorState = new CosponsorState(
      PROTOCOL_BOOT_TRANSACTION_ID,
      PROTOCOL_BOOT_TRANSACTION_INDEX,
      PROPOSAL_LIFETIME,
    );

    const mockProposal: ICosponsoredProposal = {
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

    this.gAdaPolicyId = cosponsor.script().hash();
    const scriptAddress = cosponsor.address(blaze.provider.network);

    console.log(`Script address: ${scriptAddress.toBech32()}`);

    // Get all UTxOs at script address
    const scriptUtxos = await blaze.provider.getUnspentOutputs(scriptAddress);
    console.log(`Found ${scriptUtxos.length} unspent UTxOs at script address`);

    const deposits: DepositInfo[] = [];

    // Process each script UTxO
    for (let i = 0; i < scriptUtxos.length; i++) {
      const scriptUtxo = scriptUtxos[i];
      const depositTxId = scriptUtxo.input().transactionId();
      const depositOutputIndex = Number(scriptUtxo.input().index());
      const depositAmount = scriptUtxo.output().amount().coin();
      const datum = scriptUtxo.output().datum();

      console.log(
        `Processing deposit ${i + 1}/${scriptUtxos.length}: ${depositTxId.slice(0, 16)}... (${depositAmount / 1_000_000n} ADA)`,
      );

      // Standardised inline-datum extraction (audit H3). Returns null for
      // absent / hash-only datums, which we skip.
      const inlineDatum = extractInlineDatum(datum);
      if (inlineDatum) {
        const parsedResult = parseCosponsorDatum(inlineDatum);
        if (parsedResult.ok && parsedResult.value.datumType === "Before") {
          // Calculate expected token using raw datum proposal to avoid circular dependency
          const expectedTokenAssetName = serialize(
            CosponsorTypes.CosponsoredProposalProcedure,

            parsedResult.value.rawCosponsoredProposal as any,
          ).hash();

          const proposalUrl = Buffer.from(
            parsedResult.value.proposal.anchor.url,
            "hex",
          ).toString("utf-8");

          deposits.push({
            tokenAssetName: expectedTokenAssetName,
            depositTxId,
            depositOutputIndex,
            depositAmount: depositAmount.toString(),
            proposalUrl,
            // The off-chain metadata anchor hash (CIP-100/108 SHA of the
            // anchor body). NOT the proposal-procedure hash. The
            // procedure hash equals `expectedTokenAssetName` above.
            anchorContentHash: parsedResult.value.proposal.anchor.hash,
            proposalHash: expectedTokenAssetName,
            isSpent: false, // All UTxOs we find are unspent
            spentStatus: "available",
          });

          console.log(`Token: ${expectedTokenAssetName.slice(0, 20)}...`);
        } else if (!parsedResult.ok) {
          console.warn(
            `Failed to parse deposit datum: reason=${parsedResult.reason}`,
            parsedResult.error,
          );
        } else {
          console.log(`Deposit datum is in After state — skipping`);
        }
      } else {
        console.log(`No inline datum found — skipping`);
      }
    }

    const depositIndex: DepositIndex = {
      timestamp: new Date().toISOString(),
      totalDeposits: deposits.length,
      availableDeposits: deposits.length,
      spentDeposits: 0,
      notFoundDeposits: 0,
      scriptAddress: scriptAddress.toBech32(),
      policyId: this.gAdaPolicyId,
      deposits,
    };

    console.log(
      `Deposit index built: ${deposits.length} entries (unspent deposits only)`,
    );

    return depositIndex;
  }

  // Save indexes to files
  async saveIndexes(depositIndex: DepositIndex): Promise<void> {
    fs.writeFileSync(
      "./deposit-index.json",
      JSON.stringify(depositIndex, null, 2),
    );
    console.log(`Deposit index saved to ./deposit-index.json`);
  }

  loadDepositIndex(): DepositIndex | null {
    try {
      const data = fs.readFileSync("./deposit-index.json", "utf8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // Full indexing workflow
  async buildCompleteIndex(): Promise<{
    walletTokens: WalletTokens;
    depositIndex: DepositIndex;
  }> {
    console.log("Fetching deposits and deriving token requirements...");

    // Step 1: Scan deposits (primary data source)
    const depositIndex = await this.scanDeposits();

    // Step 2: Derive token info from deposits (no redundant wallet scanning)
    const walletTokens = this.deriveTokensFromDeposits(depositIndex.deposits);

    // Step 3: Save to files
    await this.saveIndexes(depositIndex);

    return { walletTokens, depositIndex };
  }
}

// Standalone script functionality - just fetch and save data
const runStandaloneIndexer = async () => {
  console.log("Deposit Indexer - Data Fetcher");
  console.log("==============================");

  let cardanoProvider = null;

  try {
    const { CardanoProvider } = await import("../utils/provider");

    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    // Create indexer and build complete index
    const indexer = new DepositIndexer(cardanoProvider);
    const { walletTokens, depositIndex } = await indexer.buildCompleteIndex();

    console.log("\nData fetching complete:");
    console.log(`Wallet tokens: ${walletTokens.totalTokens} entries`);
    console.log(`Deposits: ${depositIndex.totalDeposits} entries`);
    console.log(`Data saved to ./wallet-tokens.json and ./deposit-index.json`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

// Check if this script is being run directly
if (import.meta.url.includes(process.argv[1]?.replace(/\\/g, "/"))) {
  runStandaloneIndexer().catch(console.error);
}
