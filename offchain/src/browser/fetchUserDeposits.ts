/* eslint-disable no-console */
import { Core } from "@blaze-cardano/sdk";
import { BROWSER_CONFIG } from "./BrowserConfig.js";

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
    throw new Error(`Unsupported additional info: ${additionalInfo}`);
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
        this.pos += len;
        break;
      }
      case 4: {
        // Array
        const arrLen = this.readUint(additionalInfo);
        for (let i = 0; i < arrLen; i++) {
          this.skipValue();
        }
        break;
      }
      case 5: {
        // Map
        const mapLen = this.readUint(additionalInfo);
        for (let i = 0; i < mapLen * 2; i++) {
          this.skipValue();
        }
        break;
      }
      case 6: // Tag
        this.readUint(additionalInfo);
        this.skipValue();
        break;
      case 7: // Simple/float
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

    // CosponsorDatum - should be tag 121 (constructor 0 = Before)
    const datumTag = reader.readTag();
    console.log("🔍 CBOR Parse: datumTag =", datumTag);
    if (datumTag !== 121) {
      console.log("🔍 CBOR Parse: Expected tag 121, got", datumTag);
      return "Unknown";
    } // Not CosponsorDatum::Before

    // Array with 1 element (CosponsoredProposalProcedure)
    const datumLen = reader.readArrayLength();
    console.log("🔍 CBOR Parse: datumLen =", datumLen);
    if (datumLen < 1) {
      return "Unknown";
    }

    // CosponsoredProposalProcedure - should be tag 121 (constructor 0)
    const cppTag = reader.readTag();
    console.log("🔍 CBOR Parse: cppTag =", cppTag);
    if (cppTag !== 121) {
      return "Unknown";
    }

    // Array with 2 elements [ProposalProcedure, Anchor]
    const cppLen = reader.readArrayLength();
    if (cppLen < 2) {
      return "Unknown";
    }

    // ProposalProcedure - should be tag 121 (constructor 0)
    const ppTag = reader.readTag();
    if (ppTag !== 121) {
      return "Unknown";
    }

    // Array with 3 elements [deposit, returnAddress, governanceAction]
    const ppLen = reader.readArrayLength();
    if (ppLen < 3) {
      return "Unknown";
    }

    // Skip deposit (integer)
    reader.skipValue();

    // Skip returnAddress (constructor with credential)
    reader.skipValue();

    // governanceAction - tag 121-127 indicates constructor 0-6
    const actionTag = reader.readTag();
    if (actionTag === null || actionTag < 121 || actionTag > 127) {
      return "Unknown";
    }

    const actionIndex = actionTag - 121;
    return GOVERNANCE_ACTION_KINDS[actionIndex] || `Unknown (${actionIndex})`;
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

    reader.readArrayLength();

    const cppTag = reader.readTag();
    if (cppTag !== 121) {
      return { url: "", hash: "" };
    }

    const cppLen = reader.readArrayLength();
    if (cppLen < 2) {
      return { url: "", hash: "" };
    }

    // Skip ProposalProcedure
    reader.skipValue();

    // Anchor - should be tag 121 (constructor 0)
    const anchorTag = reader.readTag();
    if (anchorTag !== 121) {
      return { url: "", hash: "" };
    }

    const anchorLen = reader.readArrayLength();
    if (anchorLen < 2) {
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

  const rawScriptUtxos =
    await blaze.provider.getUnspentOutputs(cosponsorScriptAddress);

  const scriptUtxos: IScriptUtxo[] = rawScriptUtxos.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (utxo: any) => {
      // Parse datum to get action kind and anchor
      let actionKind = "Unknown";
      let anchor = { url: "", hash: "" };

      try {
        const output = utxo.output();
        const datum = output.datum();

        console.log(
          "🔍 DEBUG datum:",
          datum,
          "type:",
          datum?.constructor?.name,
        );

        if (datum) {
          // Get the inline datum (PlutusData)
          const inlineDatum = datum.asInlineData?.();
          console.log(
            "🔍 DEBUG inlineDatum:",
            inlineDatum,
            "type:",
            inlineDatum?.constructor?.name,
          );

          if (inlineDatum) {
            // Get CBOR hex and parse it directly
            // This avoids API mismatch issues with Blaze's runtime PlutusData objects
            const cborHex = inlineDatum.toCbor?.();
            console.log(
              "🔍 DEBUG cborHex:",
              cborHex?.substring(0, 100),
              "...",
            );

            if (cborHex) {
              actionKind = parseGovernanceActionKindFromCbor(cborHex);
              anchor = parseAnchorFromCbor(cborHex);
              console.log("🔍 DEBUG parsed actionKind:", actionKind);
            }
          } else {
            // Maybe datum is already PlutusData? Try toCbor directly
            const directCbor = datum.toCbor?.();
            console.log(
              "🔍 DEBUG directCbor:",
              directCbor?.substring(0, 100),
              "...",
            );
            if (directCbor) {
              actionKind = parseGovernanceActionKindFromCbor(directCbor);
              anchor = parseAnchorFromCbor(directCbor);
              console.log("🔍 DEBUG parsed actionKind (direct):", actionKind);
            }
          }
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

  // Convert to legacy format - create one "deposit" per token type
  // The actual script UTxO selection happens at withdrawal time
  const deposits: IUserDeposit[] = [];

  for (const token of plan.userTokens) {
    // Find script UTxOs to cover this token's amount
    const { selected } = selectUtxosForWithdrawal(
      plan.scriptUtxos,
      token.tokenAmount,
    );

    if (selected.length > 0) {
      // Use the first selected UTxO's info for the deposit record
      const firstUtxo = selected[0];
      // The token asset name IS the blake2b hash of the proposal procedure
      // This uniquely identifies the proposal across the system
      deposits.push({
        tokenAssetName: token.tokenAssetName,
        tokenAmount: token.tokenAmount,
        depositTxHash: firstUtxo.txHash,
        depositOutputIndex: firstUtxo.outputIndex,
        depositAmount: token.tokenAmount, // Amount is based on tokens, not UTxO
        cosponsoredProposal: {
          deposit: token.tokenAmount,
          anchor: firstUtxo.anchor, // Use parsed anchor from datum
          action: { kind: firstUtxo.actionKind }, // Use parsed action kind from datum
        },
        proposalUrl: firstUtxo.anchor.url
          ? Buffer.from(firstUtxo.anchor.url, "hex").toString()
          : "On-chain proposal",
        proposalHash: token.tokenAssetName, // Token asset name = proposal hash
      });

      console.log(
        `  Token ${token.tokenAssetName.slice(0, 16)}... -> Action: ${firstUtxo.actionKind}`,
      );
    }
  }

  console.log(`Created ${deposits.length} withdrawal-ready deposit(s)`);

  return deposits;
};
