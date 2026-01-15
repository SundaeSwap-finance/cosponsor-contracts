import { Core } from "@blaze-cardano/sdk";
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

// Constructor 0: Protocol Parameters Update
export interface IProtocolParameters extends IGovernanceAction {
  kind: "ProtocolParameters";
  ancestor: IGovernanceActionId | null;
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
  constitutionHash: string;
  constitutionUrl: string;
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
      const pp = ga as IProtocolParameters;
      return {
        ProtocolParameters: {
          ancestor: ancestorToContract(pp.ancestor),
          newParameters: {
            ProtocolParametersUpdate: {
              // Empty array = no parameter changes (valid for testing)
              inner: [],
            },
          },
          guardrails: undefined, // No guardrails
        },
      };
    }

    case "HardFork": {
      // Constructor 1: HardFork
      const hf = ga as IHardFork;
      return {
        HardFork: {
          ancestor: ancestorToContract(hf.ancestor),
          newVersion: {
            ProtocolVersion: {
              major: BigInt(hf.version.major),
              minor: BigInt(hf.version.minor),
            },
          },
        },
      };
    }

    case "TreasuryWithdrawal": {
      // Constructor 2: TreasuryWithdrawal
      // CRITICAL: beneficiaries must be a CBOR Map (Pairs<Credential, Lovelace>),
      // NOT an array of tuples. We pre-construct the PlutusMap and pass it through.
      // The serialize() function passes PlutusData instances through directly.
      const tw = ga as ITreasuryWithdrawal;
      const beneficiariesMap = createBeneficiariesMap(tw.beneficiaries);
      return {
        TreasuryWithdrawal: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          beneficiaries: beneficiariesMap as any, // PlutusData passed through serialize()
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
      // CRITICAL: addedMembers must be a CBOR Map (Pairs<Credential, Mandate>)
      const cc = ga as IConstitutionalCommittee;
      const addedMembersMap = createBeneficiariesMap(cc.membersToAdd); // Same structure as beneficiaries
      return {
        ConstitutionalCommittee: {
          ancestor: ancestorToContract(cc.ancestor),
          evictedMembers: cc.membersToRemove.map(credentialToContract),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          addedMembers: addedMembersMap as any, // PlutusData passed through serialize()
          quorum: {
            numerator: cc.quorum.numerator,
            denominator: cc.quorum.denominator,
          },
        },
      };
    }

    case "NewConstitution": {
      // Constructor 5: NewConstitution
      // Constitution is a record type (ctor 0) with single field guardrails: Option<ScriptHash>
      // The generated types wrap it in { Constitution: {...} } but serialization needs it flat
      const nc = ga as INewConstitution;
      return {
        NewConstitution: {
          ancestor: ancestorToContract(nc.ancestor),
          // Try matching the exact generated type structure
          constitution: {
            Constitution: {
              guardRails: undefined, // Option::None for no guardrails script
            },
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

  // Build guardrails as Option::None (Constructor 1, no fields)
  // In Aiken, Option::None is ConstrPlutusData with alternative 1 and empty fields
  const guardrailsNone = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(1n, new PlutusList()),
  );

  // Build TreasuryWithdrawal (Constructor 2)
  const fields = new PlutusList();
  fields.add(beneficiariesData);
  fields.add(guardrailsNone);

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
      PlutusData.newBytes(Buffer.from(cred.VerificationKeyCredential[0], "hex")),
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
 *   - Field 0: guardrails (Option<ScriptHash>) - None for now
 */
export const buildNewConstitutionAsPlutusData = (
  nc: INewConstitution,
): PlutusData => {
  // Build ancestor
  const ancestorData = buildAncestorAsPlutusData(nc.ancestor);

  // Build Constitution (record type = Constructor 0)
  // Constitution { guardrails: Option<ScriptHash> }
  // guardrails: None = Constructor 1, no fields
  const guardrailsNone = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(1n, new PlutusList()),
  );

  const constitutionFields = new PlutusList();
  constitutionFields.add(guardrailsNone);
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
  // inner: Pairs<Int, Data> = CBOR Map
  // For no parameter changes, use an empty map
  const updateData = PlutusData.newMap(new PlutusMap());

  // Build guardrails as Option::None (Constructor 1, no fields)
  const guardrailsNone = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(1n, new PlutusList()),
  );

  // Build ProtocolParameters (Constructor 0)
  const fields = new PlutusList();
  fields.add(ancestorData);
  fields.add(updateData);
  fields.add(guardrailsNone);

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
    const mandateBigInt = typeof mandate === "string" ? BigInt(mandate) : mandate;
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
