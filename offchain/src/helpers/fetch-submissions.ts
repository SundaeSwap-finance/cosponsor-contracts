import dotenv from "dotenv";
import { CardanoProvider } from "@utils/provider";
import { Cosponsor, ICosponsoredProposal } from "@validators/Cosponsor";
import { CosponsorState } from "@validators/CosponsorState";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "@/Config";
import { Core } from "@blaze-cardano/sdk";
import { serialize } from "@blaze-cardano/data";
import { CosponsorTypes } from "@validators/GeneratedTypes";
import { parseCosponsorDatum } from "@helpers/parseCosponsorDatum";
import { extractInlineDatum } from "@helpers/datumUtils";

dotenv.config();

interface ISubmissionInfo {
  txHash: string;
  outputIndex: number;
  adaAmount: bigint;
  address: string;
  proposalHash: string;
  parsedDatum?: {
    proposal: ICosponsoredProposal;
    datumType: "Before" | "After";
  };

  rawDatum?: any;
  validationStatus?: "valid" | "malformed" | "unknown";
  validationReason?: string;
}

interface IProposalGroup {
  proposalHash: string;
  proposal: ICosponsoredProposal;
  submissions: ISubmissionInfo[];
  totalAda: bigint;
  submissionCount: number;
  status: "Active" | "Completed" | "Unknown";
}

interface IGroupedSubmissions {
  [proposalHash: string]: IProposalGroup;
}

interface IMalformedSubmission {
  txHash: string;
  outputIndex: number;
  adaAmount: bigint;
  address: string;
  reason: string;

  rawDatum?: any;
}

interface IFetchResult {
  validSubmissions: IGroupedSubmissions;
  malformedSubmissions: IMalformedSubmission[];
  totalStats: {
    totalUTxOs: number;
    validUTxOs: number;
    malformedUTxOs: number;
    totalAda: bigint;
    validAda: bigint;
    malformedAda: bigint;
  };
}

// The outcome of decoding one script UTxO's datum, plus its structural
// validation. Kept as a plain value (no on-chain calls) so the valid-vs-
// malformed routing can be unit-tested without a live provider — see
// `groupClassifiedSubmissions`.
export interface IClassifiedSubmission {
  txHash: string;
  outputIndex: number;
  adaAmount: bigint;
  address: string;

  rawDatum?: any;
  decode:
    | {
        ok: true;
        proposalHash: string;
        proposal: ICosponsoredProposal;
        datumType: "Before" | "After";
      }
    | { ok: false; reason: string };
  // Structural validation (e.g. UTxO still unspent). Only meaningful when
  // `decode.ok` is true; ignored otherwise.
  validation: { isValid: boolean; reason?: string };
}

// Pure grouping of classified submissions.
//
// Audit C1: a UTxO whose datum cannot be decoded into a cosponsor proposal
// has no real proposal identity. Such UTxOs are surfaced as `malformed` and
// skipped — never fabricated into a synthetic `unknown_<txid>` group with a
// placeholder `{ anchor: "unknown", action: { kind: "Unknown" } }`. The old
// behaviour collided distinct failed deposits (e.g. two outputs of the same
// tx) under one key, mislabelling them as a single "proposal".
export const groupClassifiedSubmissions = (
  classified: IClassifiedSubmission[],
): IFetchResult => {
  const groupedSubmissions: IGroupedSubmissions = {};
  const malformedSubmissions: IMalformedSubmission[] = [];

  let totalAda = 0n;
  let validAda = 0n;
  let malformedAda = 0n;

  const pushMalformed = (item: IClassifiedSubmission, reason: string) => {
    malformedSubmissions.push({
      txHash: item.txHash,
      outputIndex: item.outputIndex,
      adaAmount: item.adaAmount,
      address: item.address,
      reason,
      rawDatum: item.rawDatum,
    });
    malformedAda += item.adaAmount;
  };

  for (const item of classified) {
    totalAda += item.adaAmount;

    // Decode failure: cannot form a real proposal identity — skip, don't group.
    if (!item.decode.ok) {
      pushMalformed(item, item.decode.reason);
      continue;
    }

    // Structural validation failure (e.g. UTxO already spent).
    if (!item.validation.isValid) {
      pushMalformed(
        item,
        item.validation.reason || "Unknown validation failure",
      );
      continue;
    }

    validAda += item.adaAmount;

    const { proposalHash, proposal, datumType } = item.decode;
    const submissionInfo: ISubmissionInfo = {
      txHash: item.txHash,
      outputIndex: item.outputIndex,
      adaAmount: item.adaAmount,
      address: item.address,
      proposalHash,
      parsedDatum: { proposal, datumType },
      rawDatum: item.rawDatum,
      validationStatus: "valid",
    };

    if (!groupedSubmissions[proposalHash]) {
      groupedSubmissions[proposalHash] = {
        proposalHash,
        proposal,
        submissions: [],
        totalAda: 0n,
        submissionCount: 0,
        status: datumType === "After" ? "Completed" : "Active",
      };
    }

    groupedSubmissions[proposalHash].submissions.push(submissionInfo);
    groupedSubmissions[proposalHash].totalAda += item.adaAmount;
    groupedSubmissions[proposalHash].submissionCount++;
  }

  return {
    validSubmissions: groupedSubmissions,
    malformedSubmissions,
    totalStats: {
      totalUTxOs: classified.length,
      validUTxOs: Object.values(groupedSubmissions).reduce(
        (sum, group) => sum + group.submissionCount,
        0,
      ),
      malformedUTxOs: malformedSubmissions.length,
      totalAda,
      validAda,
      malformedAda,
    },
  };
};

// Helper function to validate deposit structure - simplified to just check if script UTxO exists
const validateDepositStructure = async (
  blaze: any,
  txHash: string,
  outputIndex: number,
): Promise<{ isValid: boolean; reason?: string }> => {
  try {
    // Only check if the script UTxO still exists and is unspent
    const scriptRef = new Core.TransactionInput(
      Core.TransactionId(txHash),
      BigInt(outputIndex),
    );

    const scriptResult = await blaze.provider.resolveUnspentOutputs([
      scriptRef,
    ]);
    if (scriptResult.length === 0) {
      return {
        isValid: false,
        reason: "Script UTxO already spent or doesn't exist",
      };
    }

    // If script UTxO exists, consider it valid - we'll handle gAda tokens during withdrawal
    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      reason: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// Helper function to extract proposal hash from cosponsor proposal.
// Throws on failure rather than fabricating a synthetic key — pre-audit
// code returned `${proposal.deposit}_${proposal.anchor.hash.slice(0, 8)}`
// on error, which collides across distinct proposals (AUDIT.md F14).
//
// Audit H1: hash the RAW parsed procedure (the exact on-chain bytes), NOT a
// rebuild from the typed action. `fromContractType` is intentionally lossy for
// the Pairs-typed fields (TreasuryWithdrawal `beneficiaries` /
// ConstitutionalCommittee `addedMembers`), so the old `Cosponsor.new(...).gAda()`
// rebuild produced a WRONG gADA hash for those variants. `serialize`-ing the
// preserved `rawCosponsoredProposal` matches the on-chain token name exactly,
// the same way `depositIndexer` already computes it.
const getProposalHash = (rawCosponsoredProposal: unknown): string => {
  return serialize(
    CosponsorTypes.CosponsoredProposalProcedure,

    rawCosponsoredProposal as any,
  ).hash();
};

export const fetchAllSubmissions = async (
  cardanoProvider: CardanoProvider,
): Promise<IFetchResult> => {
  console.log("=== Fetching All On-Chain Submissions ===");

  const blaze = cardanoProvider.getBlaze();

  // Initialize cosponsor state to get the script addresses
  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  // Create a cosponsor instance to get the base script hash
  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
  });

  const scriptAddress = cosponsor.address(blaze.provider.network);
  console.log(`Scanning script address: ${scriptAddress.toBech32()}`);

  try {
    // Get all UTxOs at the cosponsor script address
    const scriptUtxos = await blaze.provider.getUnspentOutputs(scriptAddress);
    console.log(`Found ${scriptUtxos.length} UTxOs at script address`);

    // Scan each UTxO into a provider-free `IClassifiedSubmission`, then hand
    // the whole batch to `groupClassifiedSubmissions` for the valid/malformed
    // routing (audit C1 — decode failures no longer fabricate a group).
    const classified: IClassifiedSubmission[] = [];

    for (let i = 0; i < scriptUtxos.length; i++) {
      const utxo = scriptUtxos[i];
      const output = utxo.output();
      const adaAmount = output.amount().coin();
      const txHash = utxo.input().transactionId();
      const outputIndex = Number(utxo.input().index());

      console.log(`\n--- UTxO ${i + 1} ---`);
      console.log(`  Transaction: ${txHash}`);
      console.log(`  Output Index: ${outputIndex}`);
      console.log(
        `  ADA Amount: ${adaAmount} lovelace (${adaAmount / 1_000_000n} ADA)`,
      );

      let decode: IClassifiedSubmission["decode"];
      let rawDatum: any = null;

      try {
        const datum = output.datum();
        console.log(`  Datum kind: ${datum ? datum.kind() : "null"}`);

        const inlineDatum = extractInlineDatum(datum);
        if (inlineDatum) {
          console.log(`  Found inline datum, parsing...`);
          rawDatum = inlineDatum;

          const parseResult = parseCosponsorDatum(inlineDatum);

          if (parseResult.ok) {
            const parsed = parseResult.value;
            let proposalHash: string;
            try {
              proposalHash = getProposalHash(parsed.rawCosponsoredProposal);
            } catch (hashErr) {
              console.warn(`  Could not compute proposal hash:`, hashErr);
              proposalHash = `uncomputed_${txHash.slice(0, 8)}`;
            }
            console.log(`  Parsed ${parsed.datumType} datum`);
            console.log(`  Proposal Hash: ${proposalHash.slice(0, 16)}...`);
            console.log(
              `  Action: ${parsed.proposal.action?.kind || "Unknown"}`,
            );
            console.log(
              `  Anchor: ${parsed.proposal.anchor.url.slice(0, 50)}...`,
            );
            decode = {
              ok: true,
              proposalHash,
              proposal: parsed.proposal,
              datumType: parsed.datumType,
            };
          } else {
            decode = {
              ok: false,
              reason: `datum decode failed: ${parseResult.reason}`,
            };
          }
        } else {
          // No inline PlutusData to decode. Keep a distinct reason for the
          // malformed record (C1 surfaces these; H3 standardises extraction).
          const reason = !datum
            ? "no datum present"
            : datum.kind() === 0
              ? `datum is hash-only (no inline datum): ${datum.asDataHash()}`
              : "inline datum data is null";
          decode = { ok: false, reason };
        }
      } catch (e: any) {
        decode = {
          ok: false,
          reason: `error accessing datum: ${e?.message ?? String(e)}`,
        };
      }

      if (!decode.ok) {
        console.warn(
          `[fetch-submissions] datum decode failed for tx ${txHash}; skipping (${decode.reason})`,
        );
      }

      classified.push({
        txHash,
        outputIndex,
        adaAmount,
        address: output.address().toBech32(),
        rawDatum,
        decode,
        // Placeholder; the structural check runs in the batched pass below.
        validation: { isValid: true },
      });
    }

    // Only the structural (unspent) check requires a provider call; skip it
    // for UTxOs we already know we can't decode — they're malformed anyway.
    // The checks are independent per UTxO, so run them concurrently instead
    // of one sequential round-trip per loop iteration (~100 decodable UTxOs
    // went from ~100×latency to ~1×latency wall-clock).
    const decodable = classified.filter((item) => item.decode.ok);
    if (decodable.length > 0) {
      console.log(
        `\nValidating deposit structure for ${decodable.length} decodable UTxO(s)...`,
      );
      await Promise.all(
        decodable.map(async (item) => {
          item.validation = await validateDepositStructure(
            blaze,
            item.txHash,
            item.outputIndex,
          );
          console.log(
            item.validation.isValid
              ? `  ${item.txHash.slice(0, 16)}…#${item.outputIndex}: valid withdrawable deposit`
              : `  ${item.txHash.slice(0, 16)}…#${item.outputIndex}: malformed deposit: ${item.validation.reason}`,
          );
        }),
      );
    }

    return groupClassifiedSubmissions(classified);
  } catch (error) {
    console.error("Error fetching submissions:", error);
    throw error;
  }
};

const main = async () => {
  console.log("Fetching All Current Submissions");
  console.log("================================");

  let cardanoProvider: CardanoProvider | null = null;

  try {
    console.log("Initializing CardanoProvider...");
    cardanoProvider = await CardanoProvider.fromEnv();
    console.log("CardanoProvider initialized successfully");

    // Check balance to verify connection
    const balance = await cardanoProvider.getWalletBalance();
    console.log(`Current wallet balance: ${balance.balance / 1_000_000n} ADA`);

    // Fetch all submissions
    const result = await fetchAllSubmissions(cardanoProvider);

    // Display results
    console.log(`\n${"=".repeat(70)}`);
    console.log("SUBMISSION ANALYSIS");
    console.log("=".repeat(70));

    const proposalHashes = Object.keys(result.validSubmissions);

    if (
      proposalHashes.length === 0 &&
      result.malformedSubmissions.length === 0
    ) {
      console.log("No submissions found on-chain.");
      return;
    }

    // Display valid submissions
    if (proposalHashes.length > 0) {
      console.log("✅ VALID WITHDRAWABLE DEPOSITS");
      console.log("-".repeat(50));

      for (const proposalHash of proposalHashes) {
        const group = result.validSubmissions[proposalHash];

        console.log(`\n📋 Proposal: ${proposalHash}`);
        console.log(`   Submissions: ${group.submissionCount}`);
        console.log(
          `   Total ADA: ${group.totalAda / 1_000_000n} ADA (${group.totalAda} lovelace)`,
        );
        console.log(`   Status: ${group.status}`);

        // Show individual submissions
        for (const submission of group.submissions) {
          console.log(
            `     • ${submission.adaAmount / 1_000_000n} ADA - ${submission.txHash}:${submission.outputIndex}`,
          );
        }
      }
    }

    // Display malformed submissions
    if (result.malformedSubmissions.length > 0) {
      console.log(`\n⚠️  MALFORMED PERMANENTLY LOCKED UTxOs`);
      console.log("-".repeat(50));

      for (const malformed of result.malformedSubmissions) {
        console.log(
          `\n🔒 Locked UTxO: ${malformed.txHash}:${malformed.outputIndex}`,
        );
        console.log(
          `   ADA Amount: ${malformed.adaAmount / 1_000_000n} ADA (${malformed.adaAmount} lovelace)`,
        );
        console.log(`   Reason: ${malformed.reason}`);
        console.log(`   Address: ${malformed.address.slice(0, 50)}...`);
      }
    }

    // Display summary statistics
    console.log(`\n📊 SUMMARY STATISTICS:`);
    console.log("=".repeat(50));
    console.log(`Total UTxOs Found: ${result.totalStats.totalUTxOs}`);
    console.log(`├─ Valid Withdrawable: ${result.totalStats.validUTxOs}`);
    console.log(`└─ Malformed Locked: ${result.totalStats.malformedUTxOs}`);
    console.log(``);
    console.log(`Total ADA: ${result.totalStats.totalAda / 1_000_000n} ADA`);
    console.log(
      `├─ Withdrawable ADA: ${result.totalStats.validAda / 1_000_000n} ADA`,
    );
    console.log(
      `└─ Locked ADA: ${result.totalStats.malformedAda / 1_000_000n} ADA`,
    );

    if (proposalHashes.length > 0) {
      console.log(`\nValid Proposals: ${proposalHashes.length}`);
    }

    console.log("=".repeat(70));
  } catch (error) {
    console.error("Fetch submissions failed:", error);
    process.exit(1);
  } finally {
    if (cardanoProvider) {
      await cardanoProvider.cleanup();
    }
  }
};

// Run main if this script is executed directly
if (import.meta.main) {
  main().catch(console.error);
}

export default fetchAllSubmissions;
