import { Blaze, Core, Provider, Wallet } from "@blaze-cardano/sdk";
import { parse, serialize } from "@blaze-cardano/data";
import { BROWSER_CONFIG } from "./BrowserConfig.js";
import { getCosponsorScriptAddress } from "./scriptAddress.js";
import { CosponsorTypes } from "../validators/GeneratedTypes/index.js";
import type { ICosponsoredProposal } from "../validators/Cosponsor.js";
import type {
  IGovernanceActionId,
  TGovernanceAction,
} from "../validators/Types/GovernanceAction.js";
import type { TCredential } from "../validators/Types/Credential.js";
import { computeProposalAssetName } from "../validators/Types/GovernanceAction.js";
import { extractInlineDatum } from "../helpers/datumUtils.js";

import { logger } from "../logger.js";

// Each datum-extraction helper distinguishes three states explicitly:
//   - Parse succeeded and the datum is a `Before { cosponsored }` → return the
//     value.
//   - Parse succeeded but the datum is `After` (proposal already processed) →
//     return `null`. Callers can present this as "no proposal data".
//   - Parse threw or the datum is structurally unexpected → return `null` AND
//     the helper logs the reason. Pre-audit code returned `""` /
//     `{ url:"", hash:"" }` / `"Unknown"` in this case, making it impossible
//     for callers to tell "successfully decoded as After" apart from "decode
//     failed". Returning `null` everywhere puts the caller in charge of the
//     fallback policy.

/** The result type of `parse(CosponsorTypes.CosponsorDatum, …)`. */
type TParsedCosponsorDatum = ReturnType<
  typeof parse<typeof CosponsorTypes.CosponsorDatum>
>;

/**
 * Parse a raw datum into a `CosponsorDatum`, returning `null` (with a
 * context-tagged warn log) when the parse throws. Shared by every extractor
 * so a script UTxO's datum is CBOR-deserialized ONCE per scan instead of
 * once per extractor (it was 4× per UTxO before this helper existed).
 */
const parseCosponsorDatumData = (
  datumPlutusData: Core.PlutusData,
  context: string,
): TParsedCosponsorDatum | null => {
  try {
    return parse(CosponsorTypes.CosponsorDatum, datumPlutusData);
  } catch (error) {
    logger.warn(`${context}: parse failed`, error);
    return null;
  }
};

/**
 * Narrow a parsed datum to its `Before.cosponsored` payload. Returns `null`
 * for `After`-state datums and unexpected shapes.
 */
const cosponsoredFromParsed = (parsedDatum: TParsedCosponsorDatum) =>
  typeof parsedDatum === "object" &&
  parsedDatum !== null &&
  "Before" in parsedDatum &&
  parsedDatum.Before &&
  "cosponsored" in parsedDatum.Before
    ? parsedDatum.Before.cosponsored
    : null;

type TParsedCosponsored = NonNullable<ReturnType<typeof cosponsoredFromParsed>>;

/** Serialize + hash an already-parsed cosponsored procedure (asset name). */
const proposalHashFromCosponsored = (
  cosponsored: TParsedCosponsored,
): string | null => {
  try {
    return serialize(
      CosponsorTypes.CosponsoredProposalProcedure,
      cosponsored,
    ).hash();
  } catch (error) {
    logger.warn("computeProposalHashFromDatum: re-serialize failed", error);
    return null;
  }
};

/** Governance-action kind of an already-parsed cosponsored procedure. */
const actionKindFromCosponsored = (
  cosponsored: TParsedCosponsored,
): string | null => {
  const govAction = cosponsored.procedure?.governanceAction;
  if (!govAction) return null;
  if (typeof govAction === "string") {
    return govAction; // "NicePoll"
  }
  if (typeof govAction === "object") {
    const keys = Object.keys(govAction);
    return keys[0] ?? null;
  }
  return null;
};

/** Anchor of an already-parsed cosponsored procedure. */
const anchorFromCosponsored = (
  cosponsored: TParsedCosponsored,
): { url: string; hash: string } | null => {
  const anchor = cosponsored.anchor;
  if (!anchor) return null;
  return {
    url: anchor.url ?? "",
    hash: anchor.hash ?? "",
  };
};

/**
 * Compute the proposal hash from a PlutusData datum.
 *
 * The gADA token asset name is `serialize(CosponsorTypes.CosponsoredProposalProcedure, proposal).hash()`,
 * so this function is also the canonical asset-name computation for the SDK.
 *
 * Returns `null` when the datum is `After` (no proposal procedure to hash) or
 * when parse/serialize threw. The `null` return is meaningful: a caller that
 * stored it in a Map keyed by asset name should skip storage rather than use
 * an empty string as a sentinel (the pre-audit behaviour collapsed every
 * unparseable UTxO under the same `""` key).
 */
export const computeProposalHashFromDatum = (
  datumPlutusData: Core.PlutusData,
): string | null => {
  const parsedDatum = parseCosponsorDatumData(
    datumPlutusData,
    "computeProposalHashFromDatum",
  );
  if (parsedDatum === null) return null;

  if (parsedDatum === "After") {
    logger.debug("computeProposalHashFromDatum: After-state datum");
    return null;
  }

  const cosponsored = cosponsoredFromParsed(parsedDatum);
  if (!cosponsored) {
    logger.debug(
      "computeProposalHashFromDatum: unexpected datum shape",
      typeof parsedDatum === "object" && parsedDatum !== null
        ? Object.keys(parsedDatum)
        : typeof parsedDatum,
    );
    return null;
  }

  return proposalHashFromCosponsored(cosponsored);
};

/**
 * Extract governance action kind from a parsed datum.
 *
 * Returns `null` for `After`-state datums and for any failure. Pre-audit
 * code returned `"Unknown"`, indistinguishable from a real Unknown kind.
 */
export const extractActionKindFromDatum = (
  datumPlutusData: Core.PlutusData,
): string | null => {
  const parsedDatum = parseCosponsorDatumData(
    datumPlutusData,
    "extractActionKindFromDatum",
  );
  if (parsedDatum === null || parsedDatum === "After") return null;

  const cosponsored = cosponsoredFromParsed(parsedDatum);
  if (!cosponsored) return null;

  return actionKindFromCosponsored(cosponsored);
};

/**
 * Extract anchor from a parsed datum.
 *
 * Returns `null` for `After`-state datums and for any failure. Callers that
 * previously saw `{ url: "", hash: "" }` could not distinguish "decode
 * failed" from "datum carries an intentionally-empty anchor" — and Bug 2
 * exploited exactly that ambiguity. With `null` the caller must make an
 * explicit policy choice.
 */
export const extractAnchorFromDatum = (
  datumPlutusData: Core.PlutusData,
): { url: string; hash: string } | null => {
  const parsedDatum = parseCosponsorDatumData(
    datumPlutusData,
    "extractAnchorFromDatum",
  );
  if (parsedDatum === null || parsedDatum === "After") return null;

  const cosponsored = cosponsoredFromParsed(parsedDatum);
  if (!cosponsored) return null;

  return anchorFromCosponsored(cosponsored);
};

/**
 * Convert a schema-side parsed `GovernanceActionId` (the form returned by
 * `parse(CosponsorTypes.CosponsorDatum, …)`) into the typed
 * `IGovernanceActionId` accepted by the manual builders. The schema uses
 * `{ transaction, proposalProcedure }` (matching the on-chain record); the
 * typed shape uses `{ txHash, index }`.
 */
const ancestorFromSchema = (
  schemaAncestor:
    | { transaction: string; proposalProcedure: bigint }
    | undefined
    | null,
): IGovernanceActionId | null => {
  if (!schemaAncestor) return null;
  return {
    txHash: schemaAncestor.transaction,
    index: Number(schemaAncestor.proposalProcedure),
  };
};

/**
 * Convert a parsed schema-side Credential shape (`{ VerificationKeyCredential: [hash] }`
 * / `{ ScriptCredential: [hash] }`) into the typed `TCredential`
 * (`{ vkey }` / `{ script }`) accepted by the manual builders.
 */
const credentialFromSchema = (cred: unknown): TCredential | null => {
  if (!cred || typeof cred !== "object") return null;
  if (
    "VerificationKeyCredential" in cred &&
    Array.isArray(
      (cred as { VerificationKeyCredential: unknown[] })
        .VerificationKeyCredential,
    )
  ) {
    const arr = (cred as { VerificationKeyCredential: unknown[] })
      .VerificationKeyCredential;
    if (typeof arr[0] === "string") return { vkey: arr[0] };
  }
  if (
    "ScriptCredential" in cred &&
    Array.isArray((cred as { ScriptCredential: unknown[] }).ScriptCredential)
  ) {
    const arr = (cred as { ScriptCredential: unknown[] }).ScriptCredential;
    if (typeof arr[0] === "string") return { script: arr[0] };
  }
  return null;
};

/**
 * Walk a `Pairs<Credential, Int>` PlutusMap (the wire shape of
 * TreasuryWithdrawal.beneficiaries / ConstitutionalCommittee.addedMembers)
 * back into the typed `Map<TCredential, bigint>` accepted by the manual
 * builders. The schema marks these fields as `TPlutusData` passthrough so
 * the parsed value is the raw `PlutusData` — we walk the map ourselves.
 *
 * Returns null when any entry's credential can't be decoded (caller treats
 * that as "procedure can't be safely reconstructed").
 */
const credentialMapFromPlutusData = (
  data: unknown,
): Map<TCredential, bigint> | null => {
  if (!data) {
    logger.warn("credentialMapFromPlutusData: data is null/undefined");
    return null;
  }
  // Duck-type via `asMap` (PlutusData uses `getKind()` not `kind()`, so don't
  // try to gate on a method-name check — just call asMap inside try/catch).
  // Object.keys on a real PlutusData returns [] because its fields are
  // private, so length-of-keys is also not a useful signal.
  const pd = data as Core.PlutusData;
  if (typeof pd.asMap !== "function") {
    logger.warn(
      "credentialMapFromPlutusData: data lacks .asMap() — got",
      typeof data,
      "constructor",
      (data as { constructor?: { name?: string } }).constructor?.name,
    );
    return null;
  }
  let plutusMap: Core.PlutusMap;
  try {
    const maybeMap = pd.asMap();
    if (!maybeMap) {
      logger.warn(
        "credentialMapFromPlutusData: pd.asMap() returned null/undefined — kind was",
        pd.getKind?.(),
      );
      return null;
    }
    plutusMap = maybeMap;
  } catch (error) {
    logger.warn("credentialMapFromPlutusData: pd.asMap() threw", error);
    return null;
  }
  const result = new Map<TCredential, bigint>();
  const keys = plutusMap.getKeys();
  for (let i = 0; i < keys.getLength(); i++) {
    const keyData = keys.get(i);
    const valueData = plutusMap.get(keyData);
    if (!valueData) {
      logger.warn(
        `credentialMapFromPlutusData: map[${i}] value missing for key`,
      );
      return null;
    }
    // Parse the credential PlutusData back through the schema.
    let credParsed: unknown;
    try {
      credParsed = parse(CosponsorTypes.Credential, keyData);
    } catch (error) {
      logger.warn(
        `credentialMapFromPlutusData: map[${i}] credential parse threw`,
        error,
      );
      return null;
    }
    const cred = credentialFromSchema(credParsed);
    if (!cred) {
      logger.warn(
        `credentialMapFromPlutusData: map[${i}] credentialFromSchema returned null — parsed shape was`,
        typeof credParsed === "object" && credParsed !== null
          ? Object.keys(credParsed)
          : credParsed,
      );
      return null;
    }
    let amount: bigint;
    try {
      amount = valueData.asInteger() ?? 0n;
    } catch (error) {
      logger.warn(
        `credentialMapFromPlutusData: map[${i}] value.asInteger() threw`,
        error,
      );
      return null;
    }
    result.set(cred, amount);
  }
  return result;
};

/**
 * Convert the parsed-schema governance action (the value returned by
 * `parse(CosponsorTypes.CosponsorDatum, …).Before.cosponsored.procedure.governanceAction`)
 * into the typed `TGovernanceAction` accepted by `browserDeposit` /
 * `buildGovernanceActionAsPlutusData`.
 *
 * Returns `null` when the action variant is structurally unrecognised or
 * carries data we can't reconstruct losslessly. Caller treats that as
 * "procedure can't be safely re-used" and falls back to building from
 * card-level fields (which may itself fail loudly — preferable to silently
 * producing a different procedure hash).
 */
const typedActionFromSchema = (
  parsedAction: unknown,
): TGovernanceAction | null => {
  if (parsedAction === "NicePoll") {
    return { kind: "NicePoll" };
  }
  if (!parsedAction || typeof parsedAction !== "object") return null;
  const obj = parsedAction as Record<string, unknown>;

  if ("ProtocolParameters" in obj) {
    const inner = obj.ProtocolParameters as {
      ancestor?: { transaction: string; proposalProcedure: bigint };
    };
    return {
      kind: "ProtocolParameters",
      ancestor: ancestorFromSchema(inner?.ancestor),
    };
  }
  if ("HardFork" in obj) {
    const inner = obj.HardFork as {
      ancestor?: { transaction: string; proposalProcedure: bigint };
      newVersion: { major: bigint; minor: bigint };
    };
    if (!inner?.newVersion) return null;
    return {
      kind: "HardFork",
      ancestor: ancestorFromSchema(inner.ancestor),
      version: {
        major: Number(inner.newVersion.major),
        minor: Number(inner.newVersion.minor),
      },
    };
  }
  if ("TreasuryWithdrawal" in obj) {
    const inner = obj.TreasuryWithdrawal as {
      beneficiaries: unknown;
      guardrails?: string;
    };
    const beneficiaries = credentialMapFromPlutusData(inner?.beneficiaries);
    if (!beneficiaries) return null;
    return {
      kind: "TreasuryWithdrawal",
      beneficiaries,
      guardRails: inner.guardrails,
    };
  }
  if ("NoConfidence" in obj) {
    const inner = obj.NoConfidence as {
      ancestor?: { transaction: string; proposalProcedure: bigint };
    };
    return {
      kind: "NoConfidence",
      ancestor: ancestorFromSchema(inner?.ancestor),
    };
  }
  if ("ConstitutionalCommittee" in obj) {
    const inner = obj.ConstitutionalCommittee as {
      ancestor?: { transaction: string; proposalProcedure: bigint };
      evictedMembers: unknown[];
      addedMembers: unknown;
      quorum: { numerator: bigint; denominator: bigint };
    };
    const evicted: TCredential[] = [];
    for (const e of inner.evictedMembers ?? []) {
      const cred = credentialFromSchema(e);
      if (!cred) return null;
      evicted.push(cred);
    }
    const added = credentialMapFromPlutusData(inner.addedMembers);
    if (!added) return null;
    return {
      kind: "ConstitutionalCommittee",
      ancestor: ancestorFromSchema(inner.ancestor),
      membersToRemove: evicted,
      membersToAdd: added,
      quorum: inner.quorum,
    };
  }
  if ("NewConstitution" in obj) {
    const inner = obj.NewConstitution as {
      ancestor?: { transaction: string; proposalProcedure: bigint };
      constitution?: { guardRails?: string };
    };
    // The on-chain Constitution carries only `guardrails: Option<ScriptHash>`
    // (no document anchor). Round-trip it so the rebuild matches byte-for-byte
    // — see `buildNewConstitutionAsPlutusData`. (audit H2)
    return {
      kind: "NewConstitution",
      ancestor: ancestorFromSchema(inner.ancestor),
      guardrails: inner.constitution?.guardRails,
    };
  }
  return null;
};

/**
 * Reconstruct the full typed `ICosponsoredProposal` from a script UTxO's
 * datum so callers (UI's "Sponsor again from Your Pledges" flow) can re-mint
 * the SAME gADA token instead of building a different procedure from
 * card-level fields. Returns `null` for `After`-state UTxOs, decode
 * failures, and variants whose action data can't be losslessly converted.
 *
 * Verified by re-hashing: we re-build the procedure PlutusData via the
 * manual builder and check the hash matches the original on-chain
 * `proposalHash`. If they diverge (lossy conversion) we return `null`
 * rather than hand back a procedure that would mint a different token.
 */
export const extractCosponsoredProposalFromDatum = (
  datumPlutusData: Core.PlutusData,
  expectedProposalHash: string,
): ICosponsoredProposal | null => {
  const parsedDatum = parseCosponsorDatumData(
    datumPlutusData,
    `extractCosponsoredProposalFromDatum (hash ${expectedProposalHash.slice(0, 16)}…)`,
  );
  if (parsedDatum === null) return null;
  if (parsedDatum === "After") {
    logger.debug(
      `extractCosponsoredProposalFromDatum: datum in After state for hash ` +
        `${expectedProposalHash.slice(0, 16)}…`,
    );
    return null;
  }
  const cosponsored = cosponsoredFromParsed(parsedDatum);
  if (!cosponsored) {
    logger.warn(
      `extractCosponsoredProposalFromDatum: unexpected datum shape for hash ` +
        `${expectedProposalHash.slice(0, 16)}…`,
      typeof parsedDatum === "object" && parsedDatum !== null
        ? Object.keys(parsedDatum)
        : typeof parsedDatum,
    );
    return null;
  }
  return cosponsoredProposalFromCosponsored(cosponsored, expectedProposalHash);
};

/**
 * Core of {@link extractCosponsoredProposalFromDatum}, operating on an
 * already-parsed `Before.cosponsored` payload so scan loops that parsed the
 * datum once can skip the redundant re-parse.
 */
const cosponsoredProposalFromCosponsored = (
  cosponsored: TParsedCosponsored,
  expectedProposalHash: string,
): ICosponsoredProposal | null => {
  const procedure = cosponsored.procedure;
  if (!procedure || !cosponsored.anchor) {
    logger.warn(
      `extractCosponsoredProposalFromDatum: missing procedure or anchor for hash ` +
        `${expectedProposalHash.slice(0, 16)}…`,
      { hasProcedure: !!procedure, hasAnchor: !!cosponsored.anchor },
    );
    return null;
  }

  const action = typedActionFromSchema(procedure.governanceAction);
  if (!action) {
    const variant =
      typeof procedure.governanceAction === "string"
        ? procedure.governanceAction
        : procedure.governanceAction
          ? Object.keys(procedure.governanceAction as object)[0]
          : "<missing>";
    logger.warn(
      `extractCosponsoredProposalFromDatum: typed-action conversion failed for ` +
        `variant "${variant}" (hash ${expectedProposalHash.slice(0, 16)}…)`,
    );
    return null;
  }

  const candidate: ICosponsoredProposal = {
    deposit: procedure.deposit,
    anchor: { url: cosponsored.anchor.url, hash: cosponsored.anchor.hash },
    action,
  };

  // Verify round-trip: rebuild the procedure via the manual builder (the
  // same path `browserDeposit` will take when minting the next pledge) and
  // confirm its hash matches the on-chain asset name. Mismatch means our
  // typed-action conversion dropped data — refuse the reuse rather than
  // hand back a procedure that would mint a different gADA token.
  try {
    const cosponsorHash = BROWSER_CONFIG.scripts.cosponsor.hash;
    const reHash = computeProposalAssetName(candidate, cosponsorHash);
    if (reHash !== expectedProposalHash) {
      logger.warn(
        `extractCosponsoredProposalFromDatum: manual-builder hash ` +
          `(${reHash.slice(0, 16)}…) does not match on-chain proposalHash ` +
          `(${expectedProposalHash.slice(0, 16)}…) — refusing reuse`,
      );
      return null;
    }
  } catch (error) {
    logger.warn(
      "extractCosponsoredProposalFromDatum: round-trip hash check threw",
      error,
    );
    return null;
  }

  return candidate;
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
  utxo: Core.TransactionUnspentOutput;
  /**
   * Parsed governance action kind from the datum. Empty string when the
   * datum could not be decoded — check `decodingFailed` to disambiguate.
   */
  actionKind: string;
  /**
   * Parsed anchor from the datum. `{ url: "", hash: "" }` when the datum
   * could not be decoded — check `decodingFailed` to disambiguate.
   */
  anchor: { url: string; hash: string };
  /**
   * blake2b-256 hash of `CosponsoredProposalProcedure` — matches the gADA
   * token asset name. Empty string when the datum could not be decoded or
   * the UTxO is in `After` state. Check `decodingFailed` to tell the two
   * apart.
   */
  proposalHash: string;
  /**
   * `true` when the datum was present but could not be parsed (schema
   * regression, malformed bytes, etc.). Callers should treat this UTxO's
   * anchor / actionKind / proposalHash as opaque rather than using them
   * to label a user-facing proposal. See AUDIT.md Bug 2 for context.
   */
  decodingFailed: boolean;
  /**
   * `true` when the UTxO has no inline datum at all (legitimate edge case
   * for `After`-state script UTxOs or non-standard UTxOs sent here).
   */
  hasDatum: boolean;
  /**
   * Full typed `ICosponsoredProposal` recovered from the datum, suitable
   * for re-use with `browserDeposit` to mint into the SAME gADA token.
   * `null` for `After`-state UTxOs, decode failures, or variants whose
   * action data can't be losslessly converted to the typed shape (the
   * round-trip hash check refuses to return a procedure that would mint
   * a different token).
   */
  cosponsoredProposal: ICosponsoredProposal | null;
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
  blaze: Blaze<Provider, Wallet>,
): Promise<IWithdrawalPlan> => {
  logger.debug("Fetching withdrawal plan...");

  const gAdaPolicyId = BROWSER_CONFIG.scripts.cosponsor.hash;

  // Calculate the cosponsor script address from the script hash
  const cosponsorScriptAddress = getCosponsorScriptAddress(
    blaze.provider.network,
    gAdaPolicyId,
  );

  // Step 1: Get all gADA tokens from user's wallet
  logger.debug("Scanning wallet for gADA tokens...");
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
        const tokenAmount =
          typeof amount === "bigint" ? amount : BigInt(amount);
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

  logger.debug(
    `Found ${userTokens.length} gADA token type(s), total: ${availableToWithdraw / 1_000_000n} ADA`,
  );

  // Step 2: Get all UTxOs at script address, sorted biggest-first
  logger.debug("Fetching script UTxOs...");
  logger.debug(`Script address: ${cosponsorScriptAddress.toBech32()}`);

  // Get UTxOs from provider
  let rawScriptUtxos = await blaze.provider.getUnspentOutputs(
    cosponsorScriptAddress,
  );

  // Apply pending transaction tracking (for tx chaining)
  const { pendingUtxoTracker } = await import("./utxoTracker.js");
  const stats = pendingUtxoTracker.getStats();
  if (stats.spentCount > 0 || stats.pendingCount > 0) {
    logger.debug(
      `Applying UTxO tracking: ${stats.spentCount} spent, ${stats.pendingCount} pending`,
    );
    rawScriptUtxos = pendingUtxoTracker.applyToUtxoList(rawScriptUtxos);
  }

  const scriptUtxos: IScriptUtxo[] = rawScriptUtxos.map(
    (utxo: Core.TransactionUnspentOutput) => {
      const output = utxo.output();
      const datum = output.datum();
      const txId = utxo.input().transactionId().slice(0, 8);

      if (!datum) {
        logger.debug(`UTxO ${txId}...: no datum`);
        return {
          txHash: utxo.input().transactionId(),
          outputIndex: Number(utxo.input().index()),
          lockedAmount: utxo.output().amount().coin(),
          utxo,
          actionKind: "",
          anchor: { url: "", hash: "" },
          proposalHash: "",
          decodingFailed: false,
          hasDatum: false,
          cosponsoredProposal: null,
        };
      }

      // Standardised inline-datum extraction (audit H3). Returns null when the
      // datum is present but not inline (e.g. hash-only). Pre-H3 this coerced
      // the raw datum object into PlutusData and let the extractors fail their
      // way to the same "decode failed" outcome — now it's explicit.
      const inlineDatum = extractInlineDatum(datum);

      // Parse the datum ONCE and feed the parsed payload to every extractor.
      // The pre-refactor code re-parsed the same CBOR up to 4× per UTxO
      // (hash, kind, anchor, typed-procedure recovery).
      const parsedDatum = inlineDatum
        ? parseCosponsorDatumData(inlineDatum, `UTxO ${txId} datum`)
        : null;
      const cosponsored =
        parsedDatum !== null && parsedDatum !== "After"
          ? cosponsoredFromParsed(parsedDatum)
          : null;

      const proposalHash = cosponsored
        ? proposalHashFromCosponsored(cosponsored)
        : null;
      const actionKind = cosponsored
        ? actionKindFromCosponsored(cosponsored)
        : null;
      const anchor = cosponsored ? anchorFromCosponsored(cosponsored) : null;

      // `null` from any extractor means either "After-state datum" or
      // "decode threw". The latter is the dangerous case — Bug 2 lived
      // here, with empty strings masquerading as real data. Treat any
      // null as a decode failure for diagnostic purposes; callers can
      // still see hasDatum=true so they know there *was* something.
      const decodingFailed =
        proposalHash === null || actionKind === null || anchor === null;

      if (decodingFailed) {
        logger.debug(`UTxO ${txId}...: ✗ datum decode failed`);
      } else {
        logger.debug(
          `UTxO ${txId}...: ✓ actionKind=${actionKind}, hash=${proposalHash.slice(0, 16)}...`,
        );
      }

      // Only attempt typed-procedure recovery when basic decoding succeeded;
      // it does its own re-hash check internally and returns null on any
      // lossy / mismatched conversion.
      const cosponsoredProposal =
        !decodingFailed && proposalHash && cosponsored
          ? cosponsoredProposalFromCosponsored(cosponsored, proposalHash)
          : null;

      return {
        txHash: utxo.input().transactionId(),
        outputIndex: Number(utxo.input().index()),
        lockedAmount: utxo.output().amount().coin(),
        utxo,
        actionKind: actionKind ?? "",
        anchor: anchor ?? { url: "", hash: "" },
        proposalHash: proposalHash ?? "",
        decodingFailed,
        hasDatum: true,
        cosponsoredProposal,
      };
    },
  );

  // Sort by locked amount descending (biggest first)
  scriptUtxos.sort((a, b) => (b.lockedAmount > a.lockedAmount ? 1 : -1));

  const totalScriptAda = scriptUtxos.reduce(
    (sum, u) => sum + u.lockedAmount,
    0n,
  );

  logger.debug(
    `Found ${scriptUtxos.length} script UTxO(s), total: ${totalScriptAda / 1_000_000n} ADA`,
  );

  for (const utxo of scriptUtxos) {
    logger.debug(
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
  /**
   * Tx hash of the script UTxO this deposit was matched to. Empty string
   * when no script UTxO could be matched — check `unmatched`.
   */
  depositTxHash: string;
  /** Output index of the matched script UTxO, or 0 when `unmatched`. */
  depositOutputIndex: number;
  depositAmount: bigint;
  /**
   * Cosponsored proposal data recovered from the matched script UTxO's
   * datum.
   *
   * - `cosponsoredProposal` is the fully-typed `ICosponsoredProposal` ready
   *   to feed directly to `browserDeposit` (and produce the SAME gADA token
   *   asset name, so the new pledge aggregates into the existing position).
   *   `null` when `unmatched` is true, when the datum failed to decode, or
   *   when the variant's action data can't be losslessly converted (the
   *   builder's round-trip hash check refuses to return a procedure that
   *   would mint a different token).
   * - The narrow `actionSummary` view is preserved for callers that just
   *   want the action kind / anchor without dealing with full typed shape.
   *   Always populated; `action.kind` is `"Unknown"` for unmatched
   *   deposits.
   */
  cosponsoredProposal: ICosponsoredProposal | null;
  actionSummary: {
    deposit: bigint;
    anchor: { url: string; hash: string };
    action: { kind: string };
  };
  proposalUrl: string;
  proposalHash: string;
  /**
   * `true` when no script UTxO matched this token's asset name. Pre-audit
   * code silently stamped the user's deposit with an unrelated UTxO's
   * anchor in this case (Bug 2) — now the deposit is surfaced with empty
   * fields so the UI can render an "unknown proposal" state rather than a
   * misleading label.
   */
  unmatched: boolean;
}

/**
 * @deprecated Use fetchWithdrawalPlan instead
 * Legacy function that returns IUserDeposit[] format
 */
export const fetchUserDeposits = async (
  blaze: Blaze<Provider, Wallet>,
): Promise<IUserDeposit[]> => {
  const plan = await fetchWithdrawalPlan(blaze);

  // Create a map from proposal hash to script UTxO for fast lookup
  // The gADA token asset name IS the blake2b-256 hash of ProposalProcedure
  const utxoByProposalHash = new Map<string, IScriptUtxo>();
  for (const utxo of plan.scriptUtxos) {
    if (utxo.proposalHash) {
      // Store UTxO by its computed proposal hash
      utxoByProposalHash.set(utxo.proposalHash, utxo);
      logger.debug(
        `  UTxO ${utxo.txHash.slice(0, 8)}... hash ${utxo.proposalHash.slice(0, 16)}... action: ${utxo.actionKind}`,
      );
    }
  }

  logger.debug(
    `Created proposal hash map with ${utxoByProposalHash.size} entries`,
  );

  // Debug: Show all computed hashes
  logger.debug("Available proposal hashes in map:");
  for (const [hash, utxo] of utxoByProposalHash.entries()) {
    logger.debug(`  ${hash} -> ${utxo.actionKind}`);
  }

  // Convert to legacy format - create one "deposit" per token type
  const deposits: IUserDeposit[] = [];

  logger.debug("\nUser tokens to match:");
  for (const token of plan.userTokens) {
    logger.debug(`  Token asset name: ${token.tokenAssetName}`);
  }

  for (const token of plan.userTokens) {
    // Look up the matching UTxO by token asset name (which IS the proposal hash)
    const matchedUtxo = utxoByProposalHash.get(token.tokenAssetName);

    if (matchedUtxo) {
      // Found exact match by proposal hash
      logger.debug(
        `  ✓ Token ${token.tokenAssetName.slice(0, 16)}... matched to ${matchedUtxo.actionKind}`,
      );

      deposits.push({
        tokenAssetName: token.tokenAssetName,
        tokenAmount: token.tokenAmount,
        depositTxHash: matchedUtxo.txHash,
        depositOutputIndex: matchedUtxo.outputIndex,
        depositAmount: token.tokenAmount,
        cosponsoredProposal: matchedUtxo.cosponsoredProposal,
        actionSummary: {
          deposit: token.tokenAmount,
          anchor: matchedUtxo.anchor,
          action: { kind: matchedUtxo.actionKind },
        },
        proposalUrl: matchedUtxo.anchor.url
          ? Buffer.from(matchedUtxo.anchor.url, "hex").toString()
          : "On-chain proposal",
        proposalHash: token.tokenAssetName,
        unmatched: false,
      });
    } else {
      // No match found. Pre-audit code fell back to amount-based UTxO
      // selection and stamped that UTxO's anchor onto the user's deposit
      // — which is Bug 2: distinct deposits ended up labeled as the same
      // proposal whenever any script UTxO's datum failed to decode (e.g.,
      // before the schema fixes, every NewConstitution deposit triggered
      // this). The fallback is removed. The deposit is surfaced with
      // empty proposal data and `unmatched: true`; the UI is expected to
      // render this as "unknown proposal" rather than guessing.
      logger.debug(
        `  ✗ Token ${token.tokenAssetName.slice(0, 16)}... no hash match — surfacing as unmatched`,
      );

      deposits.push({
        tokenAssetName: token.tokenAssetName,
        tokenAmount: token.tokenAmount,
        depositTxHash: "",
        depositOutputIndex: 0,
        depositAmount: token.tokenAmount,
        cosponsoredProposal: null,
        actionSummary: {
          deposit: token.tokenAmount,
          anchor: { url: "", hash: "" },
          action: { kind: "Unknown" },
        },
        proposalUrl: "On-chain proposal",
        proposalHash: token.tokenAssetName,
        unmatched: true,
      });
    }
  }

  logger.debug(`Created ${deposits.length} withdrawal-ready deposit(s)`);

  return deposits;
};
