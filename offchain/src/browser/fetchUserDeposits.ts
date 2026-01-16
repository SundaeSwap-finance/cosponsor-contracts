/* eslint-disable no-console */
import { Core } from "@blaze-cardano/sdk";
import { parse, serialize } from "@blaze-cardano/data";
import { BROWSER_CONFIG } from "./BrowserConfig.js";
import { CosponsorTypes } from "../validators/GeneratedTypes/index.js";

/**
 * Map governance action constructor index to kind string
 * Must match Aiken on-chain enum order
 */
const GOVERNANCE_ACTION_KINDS: Record<number, string> = {
  0: "ProtocolParameters",
  1: "HardFork",
  2: "TreasuryWithdrawal",
  3: "NoConfidence",
  4: "ConstitutionalCommittee",
  5: "NewConstitution",
  6: "NicePoll",
};

/**
 * Simple CBOR decoder for navigating Plutus Data structures
 * Only handles what we need: tags, arrays, integers, and byte strings
 */
class CborReader {
  private data: Uint8Array;
  private pos: number;

  constructor(hex: string) {
    this.data = new Uint8Array(
      hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );
    this.pos = 0;
  }

  /**
   * Get current position in the byte array
   */
  getPosition(): number {
    return this.pos;
  }

  /**
   * Extract bytes from start to end position as hex string
   */
  extractHex(start: number, end: number): string {
    return Array.from(this.data.slice(start, end))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private readByte(): number {
    return this.data[this.pos++];
  }

  private peekByte(): number {
    return this.data[this.pos];
  }

  private readUint(additionalInfo: number): number {
    if (additionalInfo < 24) {
      return additionalInfo;
    }
    if (additionalInfo === 24) {
      return this.readByte();
    }
    if (additionalInfo === 25) {
      return (this.readByte() << 8) | this.readByte();
    }
    if (additionalInfo === 26) {
      return (
        (this.readByte() << 24) |
        (this.readByte() << 16) |
        (this.readByte() << 8) |
        this.readByte()
      );
    }
    if (additionalInfo === 31) {
      // Indefinite length - return -1 as sentinel
      return -1;
    }
    throw new Error(`Unsupported additional info: ${additionalInfo}`);
  }

  /**
   * Check if next byte is the CBOR break code (0xff)
   */
  isBreak(): boolean {
    return this.peekByte() === 0xff;
  }

  /**
   * Consume the break byte (0xff) for indefinite-length structures
   */
  readBreak(): void {
    const byte = this.readByte();
    if (byte !== 0xff) {
      throw new Error(`Expected break (0xff), got ${byte.toString(16)}`);
    }
  }

  /**
   * Read a CBOR tag and return the tag number
   */
  readTag(): number | null {
    const byte = this.peekByte();
    const majorType = byte >> 5;
    if (majorType !== 6) {
      return null;
    } // Not a tag
    this.readByte();
    const additionalInfo = byte & 0x1f;
    return this.readUint(additionalInfo);
  }

  /**
   * Read array length
   */
  readArrayLength(): number {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 4) {
      throw new Error(`Expected array, got major type ${majorType}`);
    }
    const additionalInfo = byte & 0x1f;
    return this.readUint(additionalInfo);
  }

  /**
   * Skip over a CBOR value (any type)
   */
  skipValue(): void {
    const byte = this.readByte();
    const majorType = byte >> 5;
    const additionalInfo = byte & 0x1f;

    switch (majorType) {
      case 0: // Unsigned integer
      case 1: // Negative integer
        this.readUint(additionalInfo);
        break;
      case 2: // Byte string
      case 3: {
        // Text string
        const len = this.readUint(additionalInfo);
        if (len >= 0) {
          this.pos += len;
        }
        // Note: indefinite-length strings not supported yet
        break;
      }
      case 4: {
        // Array
        const arrLen = this.readUint(additionalInfo);
        if (arrLen === -1) {
          // Indefinite-length array - read until break
          while (!this.isBreak()) {
            this.skipValue();
          }
          this.readBreak();
        } else {
          for (let i = 0; i < arrLen; i++) {
            this.skipValue();
          }
        }
        break;
      }
      case 5: {
        // Map
        const mapLen = this.readUint(additionalInfo);
        if (mapLen === -1) {
          // Indefinite-length map - read until break
          while (!this.isBreak()) {
            this.skipValue(); // key
            this.skipValue(); // value
          }
          this.readBreak();
        } else {
          for (let i = 0; i < mapLen * 2; i++) {
            this.skipValue();
          }
        }
        break;
      }
      case 6: // Tag
        this.readUint(additionalInfo);
        this.skipValue();
        break;
      case 7: // Simple/float/break
        if (additionalInfo < 24) {
          break;
        }
        if (additionalInfo === 24) {
          this.pos += 1;
          break;
        }
        if (additionalInfo === 25) {
          this.pos += 2;
          break;
        }
        if (additionalInfo === 26) {
          this.pos += 4;
          break;
        }
        if (additionalInfo === 27) {
          this.pos += 8;
          break;
        }
        // additionalInfo === 31 is break, handled elsewhere
        break;
    }
  }

  /**
   * Read a byte string and return as hex
   */
  readByteString(): string {
    const byte = this.readByte();
    const majorType = byte >> 5;
    if (majorType !== 2) {
      throw new Error(`Expected byte string, got major type ${majorType}`);
    }
    const additionalInfo = byte & 0x1f;
    const len = this.readUint(additionalInfo);
    const bytes = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

/**
 * Parse the governance action kind from datum CBOR
 *
 * Datum structure (navigating via CBOR tags):
 * - Tag 121 (Constructor 0): CosponsorDatum::Before
 *   - Array[1]: [CosponsoredProposalProcedure]
 *     - Tag 121 (Constructor 0): CosponsoredProposalProcedure
 *       - Array[2]: [ProposalProcedure, Anchor]
 *         - Tag 121 (Constructor 0): ProposalProcedure
 *           - Array[3]: [deposit, returnAddress, governanceAction]
 *             - governanceAction: Tag 121-127 (Constructor 0-6)
 *
 * CBOR tags for Plutus constructors 0-6: 121-127
 */
const parseGovernanceActionKindFromCbor = (cborHex: string): string => {
  try {
    const reader = new CborReader(cborHex);

    // CosponsorDatum - tag 121 = Before (has data), tag 122 = After (no data)
    const datumTag = reader.readTag();
    console.log("🔍 CBOR Parse: datumTag =", datumTag);
    if (datumTag === 122) {
      // CosponsorDatum::After - deposit has been processed, no proposal data
      console.log("🔍 CBOR Parse: Datum is After (processed), no action data");
      return "Processed";
    }
    if (datumTag !== 121) {
      console.log("🔍 CBOR Parse: Expected tag 121 or 122, got", datumTag);
      return "Unknown";
    } // Not CosponsorDatum::Before

    // Array with 1 element (CosponsoredProposalProcedure)
    // -1 means indefinite-length array, which is valid
    const datumLen = reader.readArrayLength();
    console.log("🔍 CBOR Parse: datumLen =", datumLen);
    if (datumLen === 0) {
      return "Unknown";
    }

    // CosponsoredProposalProcedure - should be tag 121 (constructor 0)
    const cppTag = reader.readTag();
    console.log("🔍 CBOR Parse: cppTag =", cppTag);
    if (cppTag !== 121) {
      return "Unknown";
    }

    // Array with 2 elements [ProposalProcedure, Anchor]
    // -1 means indefinite-length array, which is valid
    const cppLen = reader.readArrayLength();
    console.log("🔍 CBOR Parse: cppLen =", cppLen);
    if (cppLen === 0) {
      return "Unknown";
    }

    // ProposalProcedure - should be tag 121 (constructor 0)
    const ppTag = reader.readTag();
    console.log("🔍 CBOR Parse: ppTag =", ppTag);
    if (ppTag !== 121) {
      return "Unknown";
    }

    // Array with 3 elements [deposit, returnAddress, governanceAction]
    // -1 means indefinite-length array, which is valid
    const ppLen = reader.readArrayLength();
    console.log("🔍 CBOR Parse: ppLen =", ppLen);
    if (ppLen === 0) {
      return "Unknown";
    }

    // Skip deposit (integer)
    reader.skipValue();

    // Skip returnAddress (constructor with credential)
    reader.skipValue();

    // governanceAction - tag 121-127 indicates constructor 0-6
    const actionTag = reader.readTag();
    console.log("🔍 CBOR Parse: actionTag =", actionTag);
    if (actionTag === null || actionTag < 121 || actionTag > 127) {
      return "Unknown";
    }

    const actionIndex = actionTag - 121;
    const actionKind =
      GOVERNANCE_ACTION_KINDS[actionIndex] || `Unknown (${actionIndex})`;
    console.log("🔍 CBOR Parse: SUCCESS! actionKind =", actionKind);
    return actionKind;
  } catch (error) {
    console.warn("Failed to parse governance action from CBOR:", error);
    return "Unknown";
  }
};

/**
 * Parse anchor URL and hash from datum CBOR
 */
const parseAnchorFromCbor = (cborHex: string): { url: string; hash: string } => {
  try {
    const reader = new CborReader(cborHex);

    // Navigate to Anchor (same path as above, but read second element of CosponsoredProposalProcedure)
    const datumTag = reader.readTag();
    if (datumTag !== 121) {
      return { url: "", hash: "" };
    }

    // -1 means indefinite-length array, which is valid
    reader.readArrayLength();

    const cppTag = reader.readTag();
    if (cppTag !== 121) {
      return { url: "", hash: "" };
    }

    // -1 means indefinite-length array, which is valid
    const cppLen = reader.readArrayLength();
    if (cppLen === 0) {
      return { url: "", hash: "" };
    }

    // Skip ProposalProcedure
    reader.skipValue();

    // Anchor - should be tag 121 (constructor 0)
    const anchorTag = reader.readTag();
    if (anchorTag !== 121) {
      return { url: "", hash: "" };
    }

    // -1 means indefinite-length array, which is valid
    const anchorLen = reader.readArrayLength();
    if (anchorLen === 0) {
      return { url: "", hash: "" };
    }

    // Read URL (byte string)
    const url = reader.readByteString();
    // Read hash (byte string)
    const hash = reader.readByteString();

    return { url, hash };
  } catch (error) {
    console.warn("Failed to parse anchor from CBOR:", error);
    return { url: "", hash: "" };
  }
};

/**
 * Compute the proposal hash from a PlutusData datum
 * Uses the same serialize() function as when tokens are minted to ensure matching hashes
 *
 * The gADA token asset name is computed as:
 *   serialize(CosponsorTypes.CosponsoredProposalProcedure, proposal).hash()
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const computeProposalHashFromDatum = (datumPlutusData: any): string => {
  try {
    // Parse the datum using the same schema used when creating it
    const parsedDatum = parse(CosponsorTypes.CosponsorDatum, datumPlutusData);

    if (!parsedDatum) {
      console.log("🔍 parse() returned null/undefined for datum");
      return "";
    }

    // Check for "After" datum first
    if (parsedDatum === "After") {
      console.log("🔍 Datum is After (processed proposal)");
      return "";
    }

    if (typeof parsedDatum !== "object") {
      console.log("🔍 parsedDatum is not an object:", typeof parsedDatum);
      return "";
    }

    // Check if it's a "Before" datum with cosponsored proposal
    if (
      "Before" in parsedDatum &&
      parsedDatum.Before &&
      "cosponsored" in parsedDatum.Before
    ) {
      const cosponsoredProposal = parsedDatum.Before.cosponsored;

      // Re-serialize using the same function that was used during minting
      // This ensures the CBOR encoding is identical
      const serialized = serialize(
        CosponsorTypes.CosponsoredProposalProcedure,
        cosponsoredProposal,
      );

      const proposalHash = serialized.hash();
      return proposalHash;
    }

    console.log(
      "🔍 Datum structure unexpected, keys:",
      Object.keys(parsedDatum),
    );
    return "";
  } catch (error) {
    console.warn("Failed to compute proposal hash from datum:", error);
    return "";
  }
};

/**
 * Extract governance action kind from parsed datum
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractActionKindFromDatum = (datumPlutusData: any): string => {
  try {
    const parsedDatum = parse(CosponsorTypes.CosponsorDatum, datumPlutusData);

    if (!parsedDatum || typeof parsedDatum !== "object") {
      return "Unknown";
    }

    if (
      "Before" in parsedDatum &&
      parsedDatum.Before &&
      "cosponsored" in parsedDatum.Before
    ) {
      const govAction =
        parsedDatum.Before.cosponsored.procedure?.governanceAction;
      if (!govAction) return "Unknown";

      // The governance action is a union type - extract the kind from the object key
      if (typeof govAction === "string") {
        return govAction; // e.g., "NicePoll"
      }
      if (typeof govAction === "object") {
        const keys = Object.keys(govAction);
        if (keys.length > 0) {
          return keys[0]; // e.g., "TreasuryWithdrawal", "HardFork", etc.
        }
      }
      return "Unknown";
    }

    if (parsedDatum === "After") {
      return "Processed";
    }

    return "Unknown";
  } catch (error) {
    console.warn("Failed to extract action kind from datum:", error);
    return "Unknown";
  }
};

/**
 * Extract anchor from parsed datum
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extractAnchorFromDatum = (
  datumPlutusData: any,
): { url: string; hash: string } => {
  try {
    const parsedDatum = parse(CosponsorTypes.CosponsorDatum, datumPlutusData);

    if (!parsedDatum || typeof parsedDatum !== "object") {
      return { url: "", hash: "" };
    }

    if (
      "Before" in parsedDatum &&
      parsedDatum.Before &&
      "cosponsored" in parsedDatum.Before
    ) {
      const anchor = parsedDatum.Before.cosponsored.anchor;
      return {
        url: anchor?.url || "",
        hash: anchor?.hash || "",
      };
    }

    return { url: "", hash: "" };
  } catch (error) {
    console.warn("Failed to extract anchor from datum:", error);
    return { url: "", hash: "" };
  }
};

export interface IUserGadaBalance {
  /** The gADA token asset name */
  tokenAssetName: string;
  /** Total amount of this gADA token the user holds (in lovelace) */
  tokenAmount: bigint;
}

export interface IScriptUtxo {
  /** Transaction hash of the UTxO */
  txHash: string;
  /** Output index */
  outputIndex: number;
  /** ADA locked at this UTxO (in lovelace) */
  lockedAmount: bigint;
  /** The raw UTxO for transaction building */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  utxo: any;
  /** Parsed governance action kind from the datum */
  actionKind: string;
  /** Parsed anchor from the datum */
  anchor: { url: string; hash: string };
  /** Computed blake2b-256 hash of ProposalProcedure - matches gADA token asset name */
  proposalHash: string;
}

export interface IWithdrawalPlan {
  /** Total gADA tokens user can withdraw (in lovelace) */
  availableToWithdraw: bigint;
  /** User's gADA token balances */
  userTokens: IUserGadaBalance[];
  /** Script UTxOs sorted by size (biggest first) */
  scriptUtxos: IScriptUtxo[];
  /** Total ADA available at script address */
  totalScriptAda: bigint;
}

/**
 * Fetch withdrawal data for the connected wallet:
 * 1. Get all gADA tokens from user's wallet (determines how much they can withdraw)
 * 2. Get all UTxOs at script address (sorted biggest-first for efficient filling)
 *
 * The withdrawal amount is determined by the user's gADA token balance.
 * Script UTxOs are filled biggest-first to minimize transaction size.
 */
export const fetchWithdrawalPlan = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blaze: any,
): Promise<IWithdrawalPlan> => {
  console.log("Fetching withdrawal plan...");

  const gAdaPolicyId = BROWSER_CONFIG.scripts.cosponsor.hash;

  // Calculate the cosponsor script address from the script hash
  const cosponsorScriptAddress = Core.addressFromCredential(
    blaze.provider.network,
    Core.Credential.fromCore({
      hash: Core.Hash28ByteBase16(gAdaPolicyId),
      type: Core.CredentialType.ScriptHash,
    }),
  );

  // Step 1: Get all gADA tokens from user's wallet
  console.log("Scanning wallet for gADA tokens...");
  const walletUtxos = await blaze.wallet.getUnspentOutputs();

  const userTokens: IUserGadaBalance[] = [];
  const tokenMap = new Map<string, bigint>(); // assetName -> total amount

  for (const utxo of walletUtxos) {
    const multiasset = utxo.output().amount().multiasset();
    if (!multiasset) {
      continue;
    }

    for (const [assetId, amount] of multiasset.entries()) {
      // Check if this is a gADA token (matches our policy ID)
      if (assetId.startsWith(gAdaPolicyId)) {
        const assetName = assetId.substring(56); // Remove policy ID prefix (56 chars)
        const tokenAmount = typeof amount === "bigint" ? amount : BigInt(amount);
        const current = tokenMap.get(assetName) || 0n;
        tokenMap.set(assetName, current + tokenAmount);
      }
    }
  }

  // Convert map to array
  for (const [assetName, amount] of tokenMap) {
    userTokens.push({ tokenAssetName: assetName, tokenAmount: amount });
  }

  const availableToWithdraw = userTokens.reduce(
    (sum, t) => sum + t.tokenAmount,
    0n,
  );

  console.log(
    `Found ${userTokens.length} gADA token type(s), total: ${availableToWithdraw / 1_000_000n} ADA`,
  );

  // Step 2: Get all UTxOs at script address, sorted biggest-first
  console.log("Fetching script UTxOs...");
  console.log(`Script address: ${cosponsorScriptAddress.toBech32()}`);

  // Get UTxOs from provider
  let rawScriptUtxos =
    await blaze.provider.getUnspentOutputs(cosponsorScriptAddress);

  // Apply pending transaction tracking (for tx chaining)
  const { pendingUtxoTracker } = await import("./utxoTracker.js");
  const stats = pendingUtxoTracker.getStats();
  if (stats.spentCount > 0 || stats.pendingCount > 0) {
    console.log(`🔄 Applying UTxO tracking: ${stats.spentCount} spent, ${stats.pendingCount} pending`);
    rawScriptUtxos = pendingUtxoTracker.applyToUtxoList(rawScriptUtxos);
  }

  const scriptUtxos: IScriptUtxo[] = rawScriptUtxos.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (utxo: any) => {
      // Parse datum to get action kind, anchor, and proposal hash
      let actionKind = "Unknown";
      let anchor = { url: "", hash: "" };
      let proposalHash = "";

      try {
        const output = utxo.output();
        const datum = output.datum();

        if (datum) {
          // Get the inline datum (PlutusData)
          const inlineDatum = datum.asInlineData?.() || datum;

          // Use the typed parsing functions that use the same serialize logic as minting
          actionKind = extractActionKindFromDatum(inlineDatum);
          anchor = extractAnchorFromDatum(inlineDatum);
          proposalHash = computeProposalHashFromDatum(inlineDatum);

          const txId = utxo.input().transactionId().slice(0, 8);
          if (proposalHash) {
            console.log(
              `🔍 UTxO ${txId}...: ✓ actionKind=${actionKind}, hash=${proposalHash.slice(0, 16)}...`,
            );
          } else {
            console.log(
              `🔍 UTxO ${txId}...: ✗ No hash (actionKind=${actionKind})`,
            );
          }
        } else {
          console.log(
            `🔍 UTxO ${utxo.input().transactionId().slice(0, 8)}...: ✗ No datum`,
          );
        }
      } catch (error) {
        console.warn("Failed to parse UTxO datum:", error);
      }

      return {
        txHash: utxo.input().transactionId(),
        outputIndex: Number(utxo.input().index()),
        lockedAmount: utxo.output().amount().coin(),
        utxo,
        actionKind,
        anchor,
        proposalHash,
      };
    },
  );

  // Sort by locked amount descending (biggest first)
  scriptUtxos.sort((a, b) => (b.lockedAmount > a.lockedAmount ? 1 : -1));

  const totalScriptAda = scriptUtxos.reduce((sum, u) => sum + u.lockedAmount, 0n);

  console.log(
    `Found ${scriptUtxos.length} script UTxO(s), total: ${totalScriptAda / 1_000_000n} ADA`,
  );

  for (const utxo of scriptUtxos) {
    console.log(
      `  ${utxo.txHash.slice(0, 16)}...#${utxo.outputIndex}: ${utxo.lockedAmount / 1_000_000n} ADA`,
    );
  }

  return {
    availableToWithdraw,
    userTokens,
    scriptUtxos,
    totalScriptAda,
  };
};

/**
 * Select script UTxOs to fill a withdrawal amount (biggest-first strategy)
 */
export const selectUtxosForWithdrawal = (
  scriptUtxos: IScriptUtxo[],
  targetAmount: bigint,
): { selected: IScriptUtxo[]; totalSelected: bigint } => {
  const selected: IScriptUtxo[] = [];
  let totalSelected = 0n;

  for (const utxo of scriptUtxos) {
    if (totalSelected >= targetAmount) {
      break;
    }
    selected.push(utxo);
    totalSelected += utxo.lockedAmount;
  }

  return { selected, totalSelected };
};

// Legacy interface for backward compatibility
export interface IUserDeposit {
  tokenAssetName: string;
  tokenAmount: bigint;
  depositTxHash: string;
  depositOutputIndex: number;
  depositAmount: bigint;
  cosponsoredProposal: {
    deposit: bigint | string;
    anchor: { url: string; hash: string };
    action: { kind: string };
  };
  proposalUrl: string;
  proposalHash: string;
}

/**
 * @deprecated Use fetchWithdrawalPlan instead
 * Legacy function that returns IUserDeposit[] format
 */
export const fetchUserDeposits = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blaze: any,
): Promise<IUserDeposit[]> => {
  const plan = await fetchWithdrawalPlan(blaze);

  // Create a map from proposal hash to script UTxO for fast lookup
  // The gADA token asset name IS the blake2b-256 hash of ProposalProcedure
  const utxoByProposalHash = new Map<string, IScriptUtxo>();
  for (const utxo of plan.scriptUtxos) {
    if (utxo.proposalHash) {
      // Store UTxO by its computed proposal hash
      utxoByProposalHash.set(utxo.proposalHash, utxo);
      console.log(
        `  UTxO ${utxo.txHash.slice(0, 8)}... hash ${utxo.proposalHash.slice(0, 16)}... action: ${utxo.actionKind}`,
      );
    }
  }

  console.log(
    `Created proposal hash map with ${utxoByProposalHash.size} entries`,
  );

  // Debug: Show all computed hashes
  console.log("Available proposal hashes in map:");
  for (const [hash, utxo] of utxoByProposalHash.entries()) {
    console.log(`  ${hash} -> ${utxo.actionKind}`);
  }

  // Convert to legacy format - create one "deposit" per token type
  const deposits: IUserDeposit[] = [];

  console.log("\nUser tokens to match:");
  for (const token of plan.userTokens) {
    console.log(`  Token asset name: ${token.tokenAssetName}`);
  }

  for (const token of plan.userTokens) {
    // Look up the matching UTxO by token asset name (which IS the proposal hash)
    const matchedUtxo = utxoByProposalHash.get(token.tokenAssetName);

    if (matchedUtxo) {
      // Found exact match by proposal hash
      console.log(
        `  ✓ Token ${token.tokenAssetName.slice(0, 16)}... matched to ${matchedUtxo.actionKind}`,
      );

      deposits.push({
        tokenAssetName: token.tokenAssetName,
        tokenAmount: token.tokenAmount,
        depositTxHash: matchedUtxo.txHash,
        depositOutputIndex: matchedUtxo.outputIndex,
        depositAmount: token.tokenAmount,
        cosponsoredProposal: {
          deposit: token.tokenAmount,
          anchor: matchedUtxo.anchor,
          action: { kind: matchedUtxo.actionKind },
        },
        proposalUrl: matchedUtxo.anchor.url
          ? Buffer.from(matchedUtxo.anchor.url, "hex").toString()
          : "On-chain proposal",
        proposalHash: token.tokenAssetName,
      });
    } else {
      // No match found - fall back to selecting UTxOs by amount
      console.log(
        `  ✗ Token ${token.tokenAssetName.slice(0, 16)}... no hash match, using fallback`,
      );

      const { selected } = selectUtxosForWithdrawal(
        plan.scriptUtxos,
        token.tokenAmount,
      );

      if (selected.length > 0) {
        const firstUtxo = selected[0];
        deposits.push({
          tokenAssetName: token.tokenAssetName,
          tokenAmount: token.tokenAmount,
          depositTxHash: firstUtxo.txHash,
          depositOutputIndex: firstUtxo.outputIndex,
          depositAmount: token.tokenAmount,
          cosponsoredProposal: {
            deposit: token.tokenAmount,
            anchor: firstUtxo.anchor,
            action: { kind: firstUtxo.actionKind },
          },
          proposalUrl: firstUtxo.anchor.url
            ? Buffer.from(firstUtxo.anchor.url, "hex").toString()
            : "On-chain proposal",
          proposalHash: token.tokenAssetName,
        });
      }
    }
  }

  console.log(`Created ${deposits.length} withdrawal-ready deposit(s)`);

  return deposits;
};
