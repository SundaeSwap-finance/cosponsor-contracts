import {
  PlutusData,
  PlutusMap,
  PlutusList,
  ConstrPlutusData,
} from "@blaze-cardano/core";
import { serialize } from "@blaze-cardano/data";
import { CosponsorTypes } from "@validators/GeneratedTypes/index.js";
import { TCredential } from "./Credential.js";

// Re-export PlutusData types for use in BrowserDeposit
export { PlutusData, PlutusMap, PlutusList, ConstrPlutusData };

// Base interface for all governance actions
export interface IGovernanceAction {
  kind: string;
}

// Shared type for referencing previous governance actions (ancestor)
export interface IGovernanceActionId {
  txHash: string; // 64-char hex transaction hash
  index: number; // Action index within the transaction
}

// Rational number type (for quorum)
export interface IRational {
  numerator: bigint;
  denominator: bigint;
}

/**
 * A single protocol-parameter update value. Covers every Conway param shape
 * currently supported end-to-end: plain integers (`I n` in the script
 * context) and unit/nonnegative intervals (`List [I num, I den]`). Nested
 * shapes (cost models, ex-unit prices, voting-threshold lists) are not yet
 * representable — extend here AND in `paramValueToPlutusData` /
 * `encodeGovernanceAction` together.
 */
export type TProtocolParamValue = bigint | IRational;

// Constructor 0: Protocol Parameters Update
export interface IProtocolParameters extends IGovernanceAction {
  kind: "ProtocolParameters";
  ancestor: IGovernanceActionId | null;
  /**
   * Sparse Conway `protocol_param_update` entries: `[paramId, newValue]`.
   * The ledger presents the update to scripts SORTED ascending by param id
   * (the guardrails validator relies on that), so entries are sorted at
   * encode time regardless of input order. An empty/absent update is
   * representable in the datum but NOT submittable (`MalformedProposal`).
   */
  newParameters?: Array<[bigint, TProtocolParamValue]>;
  /** Constitution guardrails script hash (Option<ScriptHash> on-chain). */
  guardRails?: string;
}

// Constructor 1: Hard Fork Initiation
export interface IHardFork extends IGovernanceAction {
  kind: "HardFork";
  ancestor: IGovernanceActionId | null;
  version: {
    major: number;
    minor: number;
  };
}

// Constructor 2: Treasury Withdrawal
export interface ITreasuryWithdrawal extends IGovernanceAction {
  kind: "TreasuryWithdrawal";
  // Can be either Map or Array (from API)
  beneficiaries:
    | Map<TCredential, bigint>
    | Array<[TCredential, bigint | string]>;
  guardRails?: string; // Optional - undefined for Option::None
}

// Constructor 3: No Confidence Motion
export interface INoConfidence extends IGovernanceAction {
  kind: "NoConfidence";
  ancestor: IGovernanceActionId | null;
}

// Constructor 4: Constitutional Committee Update
export interface IConstitutionalCommittee extends IGovernanceAction {
  kind: "ConstitutionalCommittee";
  ancestor: IGovernanceActionId | null;
  membersToRemove: TCredential[];
  // Can be either Map or Array (from API)
  membersToAdd:
    | Map<TCredential, bigint>
    | Array<[TCredential, bigint | string]>;
  quorum: IRational;
}

// Constructor 5: New Constitution
export interface INewConstitution extends IGovernanceAction {
  kind: "NewConstitution";
  ancestor: IGovernanceActionId | null;
  /**
   * Optional guardrails script hash. Maps to the on-chain
   * `Constitution { guardrails: Option<ScriptHash> }`. `undefined` = `None`,
   * which encodes byte-identically to the pre-realign output — so existing
   * NewConstitution proposals stay hash-stable. (audit H2)
   */
  guardrails?: string;
  /**
   * The constitution DOCUMENT anchor the ledger-level action requires
   * (`constitution = [anchor, script_hash / null]` in the Conway CDDL).
   * `url` is PLAIN TEXT (not hex — unlike the procedure anchor), `hash` the
   * 32-byte blake2b-256 of the document, hex.
   *
   * Consumed ONLY by the field-20 encoder at propose time. It has NO datum
   * slot — the V3 script context drops the constitution anchor, so the
   * on-chain structural comparison neither sees nor commits it. TRUST GAP:
   * the pledged gADA does not bind the constitution document; by convention
   * the proposal's CIP-108 metadata (which the gADA DOES commit via the
   * procedure anchor) must declare the same url+hash so anyone can verify
   * the submission off-chain. Cryptographic commitment is a datum extension
   * slated for the per-campaign redesign redeploy (mainnet-gate decision).
   */
  constitutionAnchor?: { url: string; hash: string };
  /**
   * @deprecated Superseded by {@link constitutionAnchor} (as an SDK-side,
   * encoder-only input — there is still no on-chain/datum slot). Ignored by
   * every builder. (audit H2)
   */
  constitutionHash?: string;
  /** @deprecated No on-chain slot. See {@link constitutionAnchor}. (audit H2) */
  constitutionUrl?: string;
}

// Constructor 6: Info Action (NicePoll)
export interface INicePoll extends IGovernanceAction {
  kind: "NicePoll";
}

// Union of all governance action types
export type TGovernanceAction =
  | IProtocolParameters
  | IHardFork
  | ITreasuryWithdrawal
  | INoConfidence
  | IConstitutionalCommittee
  | INewConstitution
  | INicePoll;

/**
 * Helper to convert credential format from UI to on-chain contract format
 * Input: { vkey: "hash" } or { script: "hash" }
 * Output: { VerificationKeyCredential: ["hash"] } or { ScriptCredential: ["hash"] }
 */
const credentialToContract = (
  cred: TCredential,
): { VerificationKeyCredential: [string] } | { ScriptCredential: [string] } => {
  if ("vkey" in cred) {
    return { VerificationKeyCredential: [cred.vkey] };
  } else {
    return { ScriptCredential: [cred.script] };
  }
};

/**
 * Create a PlutusMap for beneficiaries (Pairs<Credential, Lovelace>)
 *
 * CRITICAL: Aiken's Pairs<k,v> is encoded as a CBOR Map, NOT a list of tuples!
 * The Type.Array(Type.Tuple(...)) in CosponsorTypes produces a list, which fails validation.
 * This function manually constructs the proper CBOR Map structure.
 *
 * IMPORTANT: We use PlutusData/PlutusMap directly from @blaze-cardano/core to ensure
 * instanceof checks work correctly in @blaze-cardano/data's serialize function.
 *
 * Handles both Map<TCredential, bigint> and Array<[TCredential, bigint|string]> inputs
 * since the data may come as an array from the API.
 */
const createBeneficiariesMap = (
  beneficiaries:
    | Map<TCredential, bigint>
    | Array<[TCredential, bigint | string]>,
): PlutusData => {
  const plutusMap = new PlutusMap();

  // Handle both Map and Array inputs
  const entries: Array<[TCredential, bigint | string]> =
    beneficiaries instanceof Map
      ? Array.from(beneficiaries.entries())
      : beneficiaries;

  for (const [cred, amount] of entries) {
    // Serialize the credential to PlutusData
    const credContract = credentialToContract(cred);
    const credData = serialize(CosponsorTypes.Credential, credContract);

    // Convert amount to bigint if it's a string
    const amountBigInt = typeof amount === "string" ? BigInt(amount) : amount;

    // Serialize the amount to PlutusData (use directly imported class)
    const amountData = PlutusData.newInteger(amountBigInt);

    // Insert into the map
    plutusMap.insert(credData, amountData);
  }

  const result = PlutusData.newMap(plutusMap);
  return result;
};

/**
 * Helper to convert ancestor (previous governance action reference) to contract format
 * Uses undefined (not null) for Option::None in CBOR encoding
 */
const ancestorToContract = (
  ancestor: IGovernanceActionId | null,
): { transaction: string; proposalProcedure: bigint } | undefined => {
  if (ancestor === null || ancestor === undefined) {
    return undefined; // Option::None in CBOR
  }
  return {
    transaction: ancestor.txHash,
    proposalProcedure: BigInt(ancestor.index),
  };
};

/**
 * Sort + validate sparse param-update entries: ascending by param id (the
 * order the ledger presents to scripts), duplicates rejected.
 */
export const sortedParamEntries = (
  entries: Array<[bigint, TProtocolParamValue]> | undefined,
): Array<[bigint, TProtocolParamValue]> => {
  const sorted = [...(entries ?? [])].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] === sorted[i - 1][0]) {
      throw new Error(`sortedParamEntries: duplicate param id ${sorted[i][0]}`);
    }
  }
  return sorted;
};

/**
 * Encode one param value exactly as the ledger's ToPlutusData does for the
 * script context (cardano-ledger `Cardano.Ledger.Plutus.ToPlutusData`):
 * integers → I n; unit/nonnegative intervals → List [I num, I den]
 * (reduced rational, positive denominator — caller's responsibility).
 */
export const paramValueToPlutusData = (
  value: TProtocolParamValue,
): PlutusData => {
  if (typeof value === "bigint") {
    return PlutusData.newInteger(value);
  }
  const list = new PlutusList();
  list.add(PlutusData.newInteger(value.numerator));
  list.add(PlutusData.newInteger(value.denominator));
  return PlutusData.newList(list);
};

/** Inverse of {@link paramValueToPlutusData} (parse round-trip). */
export const paramValueFromPlutusData = (
  data: PlutusData,
): TProtocolParamValue => {
  const integer = data.asInteger();
  if (integer !== undefined) return integer;
  const list = data.asList();
  if (list && list.getLength() === 2) {
    const numerator = list.get(0).asInteger();
    const denominator = list.get(1).asInteger();
    if (numerator !== undefined && denominator !== undefined) {
      return { numerator, denominator };
    }
  }
  throw new Error(
    "paramValueFromPlutusData: unsupported param value shape (only " +
      "integer and rational-interval params are supported)",
  );
};

/**
 * Convert UI governance action to on-chain contract format
 *
 * Constructor indices (must match Aiken on-chain code):
 * 0 = ParameterChange (ProtocolParameters)
 * 1 = HardForkInitiation (HardFork)
 * 2 = TreasuryWithdrawal
 * 3 = NoConfidence
 * 4 = ConstitutionalCommittee
 * 5 = NewConstitution
 * 6 = NicePoll (Info Action)
 */
export const ToContractType = (
  ga: TGovernanceAction,
): CosponsorTypes.GovernanceAction => {
  switch (ga.kind) {
    case "ProtocolParameters": {
      // Constructor 0: ParameterChange
      // `newParameters` is the opaque `ProtocolParametersUpdate` which
      // encodes as a bare CBOR Map (Pairs<Int, Data>). The record's
      // integer-like keys iterate in ascending numeric order (JS spec),
      // matching the sorted map the ledger shows the script context.
      // Values are pre-built PlutusData (TPlutusData passthrough).
      const pp = ga as IProtocolParameters;
      const newParameters: Record<number, PlutusData> = {};
      for (const [id, value] of sortedParamEntries(pp.newParameters)) {
        newParameters[Number(id)] = paramValueToPlutusData(value);
      }
      return {
        ProtocolParameters: {
          ancestor: ancestorToContract(pp.ancestor),
          newParameters,
          guardrails: pp.guardRails, // undefined for Option::None
        },
      };
    }

    case "HardFork": {
      // Constructor 1: HardFork
      // ProtocolVersion is a single ctor-0 record — no extra wrapper.
      const hf = ga as IHardFork;
      return {
        HardFork: {
          ancestor: ancestorToContract(hf.ancestor),
          newVersion: {
            major: BigInt(hf.version.major),
            minor: BigInt(hf.version.minor),
          },
        },
      };
    }

    case "TreasuryWithdrawal": {
      // Constructor 2: TreasuryWithdrawal
      // `beneficiaries` is `Pairs<Credential, Lovelace>` — a CBOR Map with
      // Constr-typed keys. @blaze-cardano/data's schema language can't
      // represent Constr-keyed Maps, so the schema types this field as
      // `TPlutusData` and we hand it a pre-built PlutusMap. The serializer's
      // `instanceof PlutusData` short-circuit forwards it unchanged.
      const tw = ga as ITreasuryWithdrawal;
      return {
        TreasuryWithdrawal: {
          beneficiaries: createBeneficiariesMap(tw.beneficiaries),
          guardrails: tw.guardRails, // undefined for Option::None
        },
      };
    }

    case "NoConfidence": {
      // Constructor 3: NoConfidence
      const nc = ga as INoConfidence;
      return {
        NoConfidence: {
          ancestor: ancestorToContract(nc.ancestor),
        },
      };
    }

    case "ConstitutionalCommittee": {
      // Constructor 4: ConstitutionalCommittee
      // `addedMembers` is `Pairs<Credential, Mandate>` — same CBOR-Map /
      // TPlutusData passthrough pattern as TreasuryWithdrawal beneficiaries.
      const cc = ga as IConstitutionalCommittee;
      return {
        ConstitutionalCommittee: {
          ancestor: ancestorToContract(cc.ancestor),
          evictedMembers: cc.membersToRemove.map(credentialToContract),
          addedMembers: createBeneficiariesMap(cc.membersToAdd),
          quorum: {
            numerator: cc.quorum.numerator,
            denominator: cc.quorum.denominator,
          },
        },
      };
    }

    case "NewConstitution": {
      // Constructor 5: NewConstitution
      // Aiken `Constitution { guardrails: Option<ScriptHash> }` is a single
      // ctor-0 record. The schema now matches that exactly — no extra
      // `{ Constitution: ... }` wrapper layer.
      const nc = ga as INewConstitution;
      return {
        NewConstitution: {
          ancestor: ancestorToContract(nc.ancestor),
          constitution: {
            // undefined → Option::None (byte-identical to the pre-realign
            // output); a hex ScriptHash → Option::Some. (audit H2)
            guardRails: nc.guardrails,
          },
        },
      };
    }

    case "NicePoll": {
      // Constructor 6: NicePoll (Info Action)
      return "NicePoll";
    }

    default: {
      throw new Error(
        `Unknown governance action kind: ${(ga as IGovernanceAction).kind}`,
      );
    }
  }
};

/**
 * Inverse of `ToContractType` — convert a parsed CosponsorTypes.GovernanceAction
 * back into the high-level UI `TGovernanceAction` shape with a discriminating
 * `kind` field.
 *
 * Pre-audit code at `parseCosponsorDatum.ts:41-43` did this conversion via
 * `proposal.procedure?.governanceAction || { kind: "Unknown" }` — but when
 * the action was present, the parsed value was `{TreasuryWithdrawal: {...}}`
 * or the literal string `"NicePoll"`, neither of which has a `.kind` field.
 * Every downstream `.action.kind` read returned `undefined`, and
 * `Cosponsor.new({...}).gAda()` threw `Unknown governance action kind: undefined`.
 *
 * **Caveats around `Pairs<Credential, V>` fields:** the schema's
 * `beneficiaries` / `addedMembers` are now `TPlutusData` passthrough (see
 * AUDIT.md F5/F6), so a parsed datum surfaces them as raw `PlutusData`
 * instances. This helper returns `beneficiaries: []` / `membersToAdd: []`
 * — placeholders. Callers that need the actual map contents should
 * destructure them out of the raw datum themselves, or operate on the
 * `rawCosponsoredProposal` field that `parseCosponsorDatum` preserves.
 */
export const fromContractType = (
  parsed: CosponsorTypes.GovernanceAction,
): TGovernanceAction => {
  if (typeof parsed === "string") {
    if (parsed === "NicePoll") {
      return { kind: "NicePoll" };
    }
    throw new Error(`fromContractType: unexpected string variant "${parsed}"`);
  }
  if ("ProtocolParameters" in parsed) {
    // Round-trip newParameters + guardrails so the rebuild is hash-lossless
    // (same asymmetric-round-trip bug class as TreasuryWithdrawal guardrails).
    const pp = parsed.ProtocolParameters;
    const entries: Array<[bigint, TProtocolParamValue]> = Object.entries(
      pp.newParameters ?? {},
    ).map(([id, value]) => [
      BigInt(id),
      paramValueFromPlutusData(value as PlutusData),
    ]);
    return {
      kind: "ProtocolParameters",
      ancestor: contractAncestorToUi(pp.ancestor),
      newParameters:
        entries.length > 0 ? sortedParamEntries(entries) : undefined,
      guardRails: pp.guardrails,
    };
  }
  if ("HardFork" in parsed) {
    const v = parsed.HardFork.newVersion;
    return {
      kind: "HardFork",
      ancestor: contractAncestorToUi(parsed.HardFork.ancestor),
      version: { major: Number(v.major), minor: Number(v.minor) },
    };
  }
  if ("TreasuryWithdrawal" in parsed) {
    return {
      kind: "TreasuryWithdrawal",
      beneficiaries: [],
      guardRails: parsed.TreasuryWithdrawal.guardrails,
    };
  }
  if ("NoConfidence" in parsed) {
    return {
      kind: "NoConfidence",
      ancestor: contractAncestorToUi(parsed.NoConfidence.ancestor),
    };
  }
  if ("ConstitutionalCommittee" in parsed) {
    const cc = parsed.ConstitutionalCommittee;
    return {
      kind: "ConstitutionalCommittee",
      ancestor: contractAncestorToUi(cc.ancestor),
      membersToRemove: cc.evictedMembers.map(contractCredentialToUi),
      membersToAdd: [],
      quorum: {
        numerator: cc.quorum.numerator,
        denominator: cc.quorum.denominator,
      },
    };
  }
  if ("NewConstitution" in parsed) {
    return {
      kind: "NewConstitution",
      ancestor: contractAncestorToUi(parsed.NewConstitution.ancestor),
      // The on-chain Constitution carries only `guardrails: Option<ScriptHash>`
      // (no document anchor) — round-trip it so the rebuild is lossless. (H2)
      guardrails: parsed.NewConstitution.constitution?.guardRails,
    };
  }
  throw new Error(
    `fromContractType: unhandled variant ${JSON.stringify(Object.keys(parsed))}`,
  );
};

const contractAncestorToUi = (
  a: { transaction: string; proposalProcedure: bigint } | undefined,
): IGovernanceActionId | null => {
  if (!a) return null;
  return { txHash: a.transaction, index: Number(a.proposalProcedure) };
};

const contractCredentialToUi = (
  c: { VerificationKeyCredential: [string] } | { ScriptCredential: [string] },
): TCredential => {
  if ("VerificationKeyCredential" in c) {
    return { vkey: c.VerificationKeyCredential[0] };
  }
  return { script: c.ScriptCredential[0] };
};

/**
 * Build the entire TreasuryWithdrawal GovernanceAction as PlutusData
 *
 * This bypasses serialize() completely to avoid instanceof PlutusData issues
 * caused by Vite module duplication after wallet interactions.
 *
 * Structure:
 * - Constructor 2 (TreasuryWithdrawal)
 * - Field 0: beneficiaries (CBOR Map of Credential -> Lovelace)
 * - Field 1: guardrails (Option<ScriptHash>) - None = Constructor 1 with no fields
 */
export const buildTreasuryWithdrawalAsPlutusData = (
  tw: ITreasuryWithdrawal,
): PlutusData => {
  // Build beneficiaries map
  const plutusMap = new PlutusMap();
  const entries: Array<[TCredential, bigint | string]> =
    tw.beneficiaries instanceof Map
      ? Array.from(tw.beneficiaries.entries())
      : tw.beneficiaries;

  for (const [cred, amount] of entries) {
    // Build credential as PlutusData
    const credContract = credentialToContract(cred);
    const credData = serialize(CosponsorTypes.Credential, credContract);

    // Build amount as PlutusData
    const amountBigInt = typeof amount === "string" ? BigInt(amount) : amount;
    const amountData = PlutusData.newInteger(amountBigInt);

    plutusMap.insert(credData, amountData);
  }

  const beneficiariesData = PlutusData.newMap(plutusMap);

  // Build guardrails as Option<ScriptHash>:
  //   None       = Constructor 1, no fields  (byte-identical to the previous
  //                hardcoded-None output, so existing tokens stay hash-stable)
  //   Some(hash) = Constructor 0, [ByteArray(hash)]
  // Mirrors buildNewConstitutionAsPlutusData (audit H2). Previously this was
  // hardcoded to None while the parse path preserved guardrails — an
  // asymmetric round-trip that made any TW datum with guardrails=Some fail
  // the extractCosponsoredProposalFromDatum hash check.
  let guardrailsData: PlutusData;
  if (tw.guardRails) {
    const someFields = new PlutusList();
    someFields.add(PlutusData.newBytes(Buffer.from(tw.guardRails, "hex")));
    guardrailsData = PlutusData.newConstrPlutusData(
      new ConstrPlutusData(0n, someFields),
    );
  } else {
    guardrailsData = PlutusData.newConstrPlutusData(
      new ConstrPlutusData(1n, new PlutusList()),
    );
  }

  // Build TreasuryWithdrawal (Constructor 2)
  const fields = new PlutusList();
  fields.add(beneficiariesData);
  fields.add(guardrailsData);

  const result = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(2n, fields),
  );

  return result;
};

/**
 * Check if a governance action is TreasuryWithdrawal
 */
export const isTreasuryWithdrawal = (
  ga: TGovernanceAction,
): ga is ITreasuryWithdrawal => {
  return ga.kind === "TreasuryWithdrawal";
};

/**
 * Build a Credential as PlutusData
 * VerificationKeyCredential = Constructor 0, ScriptCredential = Constructor 1
 */
const buildCredentialAsPlutusData = (
  cred:
    | { VerificationKeyCredential: [string] }
    | { ScriptCredential: [string] },
): PlutusData => {
  const fields = new PlutusList();

  if ("VerificationKeyCredential" in cred) {
    // Constructor 0
    fields.add(
      PlutusData.newBytes(
        Buffer.from(cred.VerificationKeyCredential[0], "hex"),
      ),
    );
    return PlutusData.newConstrPlutusData(new ConstrPlutusData(0n, fields));
  } else {
    // Constructor 1
    fields.add(
      PlutusData.newBytes(Buffer.from(cred.ScriptCredential[0], "hex")),
    );
    return PlutusData.newConstrPlutusData(new ConstrPlutusData(1n, fields));
  }
};

/**
 * Build an Anchor as PlutusData
 * Anchor { url: ByteArray, hash: ByteArray }
 */
const buildAnchorAsPlutusData = (url: string, hash: string): PlutusData => {
  const fields = new PlutusList();
  fields.add(PlutusData.newBytes(Buffer.from(url, "hex")));
  fields.add(PlutusData.newBytes(Buffer.from(hash, "hex")));
  return PlutusData.newConstrPlutusData(new ConstrPlutusData(0n, fields));
};

/**
 * Build CosponsoredProposalProcedure as PlutusData
 * Used for computing the token asset name hash
 *
 * Structure:
 * - CosponsoredProposalProcedure (Constructor 0)
 *   - ProposalProcedure (Constructor 0)
 *     - deposit: Int
 *     - returnAddress: Credential
 *     - governanceAction: PlutusData
 *   - Anchor (Constructor 0)
 *     - url: ByteArray
 *     - hash: ByteArray
 */
export const buildCosponsoredProposalProcedureAsPlutusData = (
  governanceActionData: PlutusData,
  params: {
    deposit: bigint;
    returnAddress:
      | { ScriptCredential: [string] }
      | { VerificationKeyCredential: [string] };
    anchor: { url: string; hash: string };
  },
): PlutusData => {
  // Build returnAddress as Credential
  const returnAddressData = buildCredentialAsPlutusData(params.returnAddress);

  // Build ProposalProcedure (Constructor 0)
  const proposalProcedureFields = new PlutusList();
  proposalProcedureFields.add(PlutusData.newInteger(params.deposit));
  proposalProcedureFields.add(returnAddressData);
  proposalProcedureFields.add(governanceActionData);
  const proposalProcedureData = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, proposalProcedureFields),
  );

  // Build Anchor
  const anchorData = buildAnchorAsPlutusData(
    params.anchor.url,
    params.anchor.hash,
  );

  // Build CosponsoredProposalProcedure (Constructor 0)
  const cosponsoredFields = new PlutusList();
  cosponsoredFields.add(proposalProcedureData);
  cosponsoredFields.add(anchorData);

  return PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, cosponsoredFields),
  );
};

/**
 * Compute the gADA token asset name for a cosponsored proposal — the
 * canonical proposal identity.
 *
 * Independent of any class instantiation; only requires the proposal and
 * the cosponsor script hash. Pre-audit code forced consumers to build a
 * `Cosponsor.new({...})` instance just to call `.gAda()` (which also
 * required `statePolicyId`, irrelevant to the asset name). This helper
 * avoids that and uses the manual `buildCosponsoredProposalProcedureAsPlutusData`
 * path directly — which is byte-equivalent to the schema path (locked
 * down by `gADA asset-name equivalence` tests).
 */
export const computeProposalAssetName = (
  proposal: {
    deposit: bigint;
    anchor: { url: string; hash: string };
    action: TGovernanceAction;
  },
  cosponsorScriptHash: string,
): string => {
  const governanceActionData = buildGovernanceActionAsPlutusData(
    proposal.action,
  );
  return buildCosponsoredProposalProcedureAsPlutusData(governanceActionData, {
    deposit: proposal.deposit,
    returnAddress: { ScriptCredential: [cosponsorScriptHash] },
    anchor: proposal.anchor,
  }).hash();
};

/**
 * Build governance action PlutusData for any action type
 * Returns the raw PlutusData for the governance action
 */
export const buildGovernanceActionAsPlutusData = (
  action: TGovernanceAction,
): PlutusData => {
  switch (action.kind) {
    case "NicePoll":
      // Constructor 6 with no fields
      return PlutusData.newConstrPlutusData(
        new ConstrPlutusData(6n, new PlutusList()),
      );

    case "TreasuryWithdrawal":
      return buildTreasuryWithdrawalAsPlutusData(action as ITreasuryWithdrawal);

    case "NewConstitution":
      return buildNewConstitutionAsPlutusData(action as INewConstitution);

    case "HardFork":
      return buildHardForkAsPlutusData(action as IHardFork);

    case "NoConfidence":
      return buildNoConfidenceAsPlutusData(action as INoConfidence);

    case "ProtocolParameters":
      return buildProtocolParametersAsPlutusData(action as IProtocolParameters);

    case "ConstitutionalCommittee":
      return buildConstitutionalCommitteeAsPlutusData(
        action as IConstitutionalCommittee,
      );

    default:
      throw new Error(
        `Unknown governance action kind: ${(action as IGovernanceAction).kind}`,
      );
  }
};

/**
 * Build an ancestor (GovernanceActionId) as PlutusData
 * GovernanceActionId { transaction: ByteArray, proposalProcedure: Int }
 *
 * Option encoding:
 * - None: Constructor 1, no fields
 * - Some: Constructor 0, with the value
 */
const buildAncestorAsPlutusData = (
  ancestor: IGovernanceActionId | null,
): PlutusData => {
  if (ancestor === null || ancestor === undefined) {
    // Option::None
    return PlutusData.newConstrPlutusData(
      new ConstrPlutusData(1n, new PlutusList()),
    );
  }

  // Build GovernanceActionId (record = Constructor 0)
  const actionIdFields = new PlutusList();
  actionIdFields.add(PlutusData.newBytes(Buffer.from(ancestor.txHash, "hex")));
  actionIdFields.add(PlutusData.newInteger(BigInt(ancestor.index)));
  const actionIdData = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, actionIdFields),
  );

  // Wrap in Option::Some (Constructor 0)
  const someFields = new PlutusList();
  someFields.add(actionIdData);
  return PlutusData.newConstrPlutusData(new ConstrPlutusData(0n, someFields));
};

/**
 * Build the NewConstitution GovernanceAction as PlutusData
 *
 * Structure:
 * - Constructor 5 (NewConstitution)
 * - Field 0: ancestor (Option<GovernanceActionId>)
 * - Field 1: constitution (Constitution record - Constructor 0)
 *   - Field 0: guardrails (Option<ScriptHash>) - None when nc.guardrails unset
 */
export const buildNewConstitutionAsPlutusData = (
  nc: INewConstitution,
): PlutusData => {
  // Build ancestor
  const ancestorData = buildAncestorAsPlutusData(nc.ancestor);

  // Build Constitution (record type = Constructor 0)
  // Constitution { guardrails: Option<ScriptHash> }
  //   None       = Constructor 1, no fields  (byte-identical to pre-realign)
  //   Some(hash) = Constructor 0, [ByteArray(hash)]
  let guardrailsData: PlutusData;
  if (nc.guardrails) {
    const someFields = new PlutusList();
    someFields.add(PlutusData.newBytes(Buffer.from(nc.guardrails, "hex")));
    guardrailsData = PlutusData.newConstrPlutusData(
      new ConstrPlutusData(0n, someFields),
    );
  } else {
    guardrailsData = PlutusData.newConstrPlutusData(
      new ConstrPlutusData(1n, new PlutusList()),
    );
  }

  const constitutionFields = new PlutusList();
  constitutionFields.add(guardrailsData);
  const constitutionData = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, constitutionFields),
  );

  // Build NewConstitution (Constructor 5)
  const fields = new PlutusList();
  fields.add(ancestorData);
  fields.add(constitutionData);

  const result = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(5n, fields),
  );

  return result;
};

/**
 * Check if a governance action is HardFork
 */
export const isHardFork = (ga: TGovernanceAction): ga is IHardFork => {
  return ga.kind === "HardFork";
};

/**
 * Build the HardFork GovernanceAction as PlutusData
 *
 * Structure:
 * - Constructor 1 (HardFork)
 * - Field 0: ancestor (Option<GovernanceActionId>)
 * - Field 1: newVersion (ProtocolVersion)
 *   - ProtocolVersion is a regular record type in Aiken:
 *     `pub type ProtocolVersion { major: Int, minor: Int }`
 *   - Regular records encode as Constructor 0 with fields in order
 *   - So it's just: Constructor 0 [major, minor]
 */
export const buildHardForkAsPlutusData = (hf: IHardFork): PlutusData => {
  // Build ancestor
  const ancestorData = buildAncestorAsPlutusData(hf.ancestor);

  // Build ProtocolVersion (regular record = Constructor 0 with fields)
  const versionFields = new PlutusList();
  versionFields.add(PlutusData.newInteger(BigInt(hf.version.major)));
  versionFields.add(PlutusData.newInteger(BigInt(hf.version.minor)));
  const versionData = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, versionFields),
  );

  // Build HardFork (Constructor 1)
  const fields = new PlutusList();
  fields.add(ancestorData);
  fields.add(versionData);

  const result = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(1n, fields),
  );

  return result;
};

/**
 * Check if a governance action is NoConfidence
 */
export const isNoConfidence = (ga: TGovernanceAction): ga is INoConfidence => {
  return ga.kind === "NoConfidence";
};

/**
 * Build the NoConfidence GovernanceAction as PlutusData
 *
 * Structure:
 * - Constructor 3 (NoConfidence)
 * - Field 0: ancestor (Option<GovernanceActionId>)
 */
export const buildNoConfidenceAsPlutusData = (
  nc: INoConfidence,
): PlutusData => {
  // Build ancestor
  const ancestorData = buildAncestorAsPlutusData(nc.ancestor);

  // Build NoConfidence (Constructor 3)
  const fields = new PlutusList();
  fields.add(ancestorData);

  const result = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(3n, fields),
  );

  return result;
};

/**
 * Check if a governance action is ProtocolParameters
 */
export const isProtocolParameters = (
  ga: TGovernanceAction,
): ga is IProtocolParameters => {
  return ga.kind === "ProtocolParameters";
};

/**
 * Build the ProtocolParameters GovernanceAction as PlutusData
 *
 * Structure:
 * - Constructor 0 (ProtocolParameters / ParameterChange)
 * - Field 0: ancestor (Option<GovernanceActionId>)
 * - Field 1: newParameters (ProtocolParametersUpdate)
 *   - ProtocolParametersUpdate is an OPAQUE TYPE in Aiken:
 *     `pub opaque type ProtocolParametersUpdate { inner: Pairs<ProtocolParametersIndex, Data> }`
 *   - Opaque types in Aiken DON'T get Constructor wrappers - they encode directly as their inner type
 *   - Pairs<K,V> encodes as a CBOR Map
 *   - So ProtocolParametersUpdate encodes directly as a CBOR Map (empty map = no parameter changes)
 * - Field 2: guardrails (Option<ScriptHash>) - None
 */
export const buildProtocolParametersAsPlutusData = (
  pp: IProtocolParameters,
): PlutusData => {
  // Build ancestor
  const ancestorData = buildAncestorAsPlutusData(pp.ancestor);

  // Build ProtocolParametersUpdate
  // Opaque types encode directly as their inner type (no Constructor wrapper)
  // inner: Pairs<Int, Data> = CBOR Map, ascending by param id (the order the
  // ledger presents to the script context; guardrails relies on it).
  const updateMap = new PlutusMap();
  for (const [id, value] of sortedParamEntries(pp.newParameters)) {
    updateMap.insert(PlutusData.newInteger(id), paramValueToPlutusData(value));
  }
  const updateData = PlutusData.newMap(updateMap);

  // Build guardrails as Option<ScriptHash> (Some = ctor 0 [bytes], None =
  // ctor 1 — byte-identical to the previous hardcoded None for no-guardrails
  // proposals, so existing tokens stay hash-stable).
  let guardrailsData: PlutusData;
  if (pp.guardRails) {
    const someFields = new PlutusList();
    someFields.add(PlutusData.newBytes(Buffer.from(pp.guardRails, "hex")));
    guardrailsData = PlutusData.newConstrPlutusData(
      new ConstrPlutusData(0n, someFields),
    );
  } else {
    guardrailsData = PlutusData.newConstrPlutusData(
      new ConstrPlutusData(1n, new PlutusList()),
    );
  }

  // Build ProtocolParameters (Constructor 0)
  const fields = new PlutusList();
  fields.add(ancestorData);
  fields.add(updateData);
  fields.add(guardrailsData);

  const result = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, fields),
  );

  return result;
};

/**
 * Check if a governance action is ConstitutionalCommittee
 */
export const isConstitutionalCommittee = (
  ga: TGovernanceAction,
): ga is IConstitutionalCommittee => {
  return ga.kind === "ConstitutionalCommittee";
};

/**
 * Build Rational as PlutusData
 * Rational { numerator: Int, denominator: Int }
 */
const buildRationalAsPlutusData = (rational: IRational): PlutusData => {
  const fields = new PlutusList();
  fields.add(PlutusData.newInteger(rational.numerator));
  fields.add(PlutusData.newInteger(rational.denominator));
  return PlutusData.newConstrPlutusData(new ConstrPlutusData(0n, fields));
};

/**
 * Build the ConstitutionalCommittee GovernanceAction as PlutusData
 *
 * Structure:
 * - Constructor 4 (ConstitutionalCommittee)
 * - Field 0: ancestor (Option<GovernanceActionId>)
 * - Field 1: evictedMembers (List of Credentials)
 * - Field 2: addedMembers (CBOR Map of Credential -> Mandate/epoch)
 * - Field 3: quorum (Rational)
 */
export const buildConstitutionalCommitteeAsPlutusData = (
  cc: IConstitutionalCommittee,
): PlutusData => {
  // Build ancestor
  const ancestorData = buildAncestorAsPlutusData(cc.ancestor);

  // Build evictedMembers (List of Credentials)
  const evictedList = new PlutusList();
  for (const cred of cc.membersToRemove) {
    const credContract = credentialToContract(cred);
    const credData = buildCredentialAsPlutusData(credContract);
    evictedList.add(credData);
  }
  const evictedData = PlutusData.newList(evictedList);

  // Build addedMembers (CBOR Map of Credential -> Mandate)
  const addedMap = new PlutusMap();
  const entries: Array<[TCredential, bigint | string]> =
    cc.membersToAdd instanceof Map
      ? Array.from(cc.membersToAdd.entries())
      : cc.membersToAdd;

  for (const [cred, mandate] of entries) {
    const credContract = credentialToContract(cred);
    const credData = buildCredentialAsPlutusData(credContract);
    const mandateBigInt =
      typeof mandate === "string" ? BigInt(mandate) : mandate;
    const mandateData = PlutusData.newInteger(mandateBigInt);
    addedMap.insert(credData, mandateData);
  }
  const addedData = PlutusData.newMap(addedMap);

  // Build quorum (Rational)
  const quorumData = buildRationalAsPlutusData(cc.quorum);

  // Build ConstitutionalCommittee (Constructor 4)
  const fields = new PlutusList();
  fields.add(ancestorData);
  fields.add(evictedData);
  fields.add(addedData);
  fields.add(quorumData);

  const result = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(4n, fields),
  );

  return result;
};

/**
 * Check if a governance action is NewConstitution
 */
export const isNewConstitution = (
  ga: TGovernanceAction,
): ga is INewConstitution => {
  return ga.kind === "NewConstitution";
};
