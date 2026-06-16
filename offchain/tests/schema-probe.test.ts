/**
 * Schema probe — validates audit claims F1, F3, F4, F5, F6 against runtime behaviour.
 *
 * Each test builds the on-chain "contract shape" for a governance-action variant
 * and asks two questions:
 *  - Does `serialize(CosponsorTypes.CosponsoredProposalProcedure, shape)` throw,
 *    produce stable bytes, and agree with the manual builder?
 *  - Does `buildCosponsoredProposalProcedureAsPlutusData(buildGovernanceActionAsPlutusData(...), ...)`
 *    produce stable bytes?
 *
 * The tests document behaviour at HEAD (pre-fix). Paired "convergence" tests
 * marked `test.skip` describe the post-fix world (schema and builder agree)
 * and get unskipped as each schema fix lands.
 */

import { describe, expect, test } from "bun:test";
import { serialize } from "@blaze-cardano/data";
import { CosponsorTypes } from "@/validators/GeneratedTypes/index.js";
import type { TGovernanceAction } from "@/validators/Types/GovernanceAction.js";
import {
  ToContractType,
  buildCosponsoredProposalProcedureAsPlutusData,
  buildGovernanceActionAsPlutusData,
  computeProposalAssetName,
} from "@/validators/Types/GovernanceAction.js";

const HASH28 = "00".repeat(28); // 28-byte payment / script hash placeholder
const ANCHOR_URL_HEX = Buffer.from(
  "https://cosponsor.app/proposal/probe",
).toString("hex");
const ANCHOR_HASH = "0".repeat(64);
const DEPOSIT = 100_000_000_000n;

const SAMPLE_PARAMS = {
  deposit: DEPOSIT,
  returnAddress: { ScriptCredential: [HASH28] as [string] },
  anchor: { url: ANCHOR_URL_HEX, hash: ANCHOR_HASH },
};

const buildContractShape = (action: TGovernanceAction) => ({
  procedure: {
    deposit: SAMPLE_PARAMS.deposit,
    returnAddress: SAMPLE_PARAMS.returnAddress,
    governanceAction: ToContractType(action),
  },
  anchor: SAMPLE_PARAMS.anchor,
});

const serializeViaSchema = (action: TGovernanceAction): string =>
  serialize(
    CosponsorTypes.CosponsoredProposalProcedure,

    buildContractShape(action) as any,
  ).toCbor();

const serializeViaBuilder = (action: TGovernanceAction): string =>
  buildCosponsoredProposalProcedureAsPlutusData(
    buildGovernanceActionAsPlutusData(action),
    SAMPLE_PARAMS,
  ).toCbor();

describe("CosponsorTypes schema — current behaviour at HEAD", () => {
  test("NicePoll: schema and manual builder agree (baseline that works)", () => {
    const action: TGovernanceAction = { kind: "NicePoll" };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });

  test("NoConfidence: schema and manual builder agree", () => {
    const action: TGovernanceAction = { kind: "NoConfidence", ancestor: null };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });

  test("F1 / F2 FIXED: ProtocolParameters — schema serialize now matches manual builder", () => {
    const action: TGovernanceAction = {
      kind: "ProtocolParameters",
      ancestor: null,
    };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });

  test("F1 / F2: ProtocolParameters — manual builder produces stable bytes", () => {
    const action: TGovernanceAction = {
      kind: "ProtocolParameters",
      ancestor: null,
    };
    expect(serializeViaBuilder(action)).toMatch(/^[0-9a-f]+$/);
  });

  test("F3 FIXED: HardFork — schema serialize now matches manual builder", () => {
    const action: TGovernanceAction = {
      kind: "HardFork",
      ancestor: null,
      version: { major: 10, minor: 0 },
    };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });

  test("F3: HardFork — manual builder produces stable bytes", () => {
    const action: TGovernanceAction = {
      kind: "HardFork",
      ancestor: null,
      version: { major: 10, minor: 0 },
    };
    expect(serializeViaBuilder(action)).toMatch(/^[0-9a-f]+$/);
  });

  test("F4 FIXED: NewConstitution (guardrails None) — schema serialize matches manual builder", () => {
    const action: TGovernanceAction = {
      kind: "NewConstitution",
      ancestor: null,
    };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });

  test("F4: NewConstitution — manual builder produces stable bytes", () => {
    const action: TGovernanceAction = {
      kind: "NewConstitution",
      ancestor: null,
    };
    expect(serializeViaBuilder(action)).toMatch(/^[0-9a-f]+$/);
  });

  test("H2: NewConstitution with guardrails Some — schema serialize matches manual builder", () => {
    const action: TGovernanceAction = {
      kind: "NewConstitution",
      ancestor: null,
      guardrails: "ab".repeat(28), // 28-byte ScriptHash hex
    };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });

  test("H2: NewConstitution guardrails None vs Some produce DIFFERENT bytes", () => {
    const none: TGovernanceAction = { kind: "NewConstitution", ancestor: null };
    const some: TGovernanceAction = {
      kind: "NewConstitution",
      ancestor: null,
      guardrails: "ab".repeat(28),
    };
    expect(serializeViaBuilder(some)).not.toBe(serializeViaBuilder(none));
  });

  test("F5: TreasuryWithdrawal — schema vs builder bytes (masked by PlutusMap workaround)", () => {
    // ToContractType pre-builds beneficiaries as a PlutusMap and casts to any,
    // so serialize() short-circuits via instanceof PlutusData rather than walking
    // the broken Type.Array(Type.Tuple) schema. Bytes should match the builder
    // today. The fix will remove the workaround and let the schema produce the
    // same bytes directly.
    const action: TGovernanceAction = {
      kind: "TreasuryWithdrawal",
      beneficiaries: [],
      guardRails: undefined,
    };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });

  test("F6: ConstitutionalCommittee — schema vs builder bytes (masked by PlutusMap workaround)", () => {
    const action: TGovernanceAction = {
      kind: "ConstitutionalCommittee",
      ancestor: null,
      membersToRemove: [],
      membersToAdd: [],
      quorum: { numerator: 1n, denominator: 2n },
    };
    expect(serializeViaSchema(action)).toBe(serializeViaBuilder(action));
  });
});

describe("gADA asset-name equivalence (the load-bearing contract)", () => {
  // The gADA token asset name = blake2b256 of the CBOR bytes of the cosponsored
  // proposal procedure. If the schema-walk and the manual-builder paths ever
  // disagree on bytes, the chain mint will reject (validator computes the
  // name itself) AND the SDK can't recover its own tokens later. Lock this
  // down across every governance-action variant.

  const VARIANTS: TGovernanceAction[] = [
    { kind: "NicePoll" },
    { kind: "NoConfidence", ancestor: null },
    { kind: "ProtocolParameters", ancestor: null },
    {
      kind: "HardFork",
      ancestor: null,
      version: { major: 10, minor: 0 },
    },
    {
      kind: "TreasuryWithdrawal",
      beneficiaries: [],
      guardRails: undefined,
    },
    {
      kind: "ConstitutionalCommittee",
      ancestor: null,
      membersToRemove: [],
      membersToAdd: [],
      quorum: { numerator: 1n, denominator: 2n },
    },
    {
      kind: "NewConstitution",
      ancestor: null,
      guardrails: "ab".repeat(28),
    },
  ];

  for (const action of VARIANTS) {
    test(`${action.kind}: schema serialize hash equals manual-builder hash`, () => {
      const schemaBytes = serializeViaSchema(action);
      const builderBytes = serializeViaBuilder(action);
      expect(schemaBytes).toBe(builderBytes);
      // Same equality via `computeProposalAssetName` (the public API
      // consumers should use — no Cosponsor class needed).
      const standaloneHash = computeProposalAssetName(
        {
          deposit: SAMPLE_PARAMS.deposit,
          action,
          anchor: SAMPLE_PARAMS.anchor,
        },
        SAMPLE_PARAMS.returnAddress.ScriptCredential[0],
      );
      expect(standaloneHash).toBe(
        buildCosponsoredProposalProcedureAsPlutusData(
          buildGovernanceActionAsPlutusData(action),
          SAMPLE_PARAMS,
        ).hash(),
      );
      // Stronger invariant: blake2b256 of the bytes — the actual gADA asset
      // name. We hash both ways via the PlutusData helper to make sure the
      // hash computation isn't path-dependent either.
      const schemaHash = serialize(
        CosponsorTypes.CosponsoredProposalProcedure,

        buildContractShape(action) as any,
      ).hash();
      const builderHash = buildCosponsoredProposalProcedureAsPlutusData(
        buildGovernanceActionAsPlutusData(action),
        SAMPLE_PARAMS,
      ).hash();
      expect(schemaHash).toBe(builderHash);
    });
  }
});

describe("Schema/builder convergence — TARGETS for the audit fixes", () => {
  // These describe the desired post-fix world: schema-walk and manual builder
  // produce identical bytes for every variant. Start `.skip`; unskip as each
  // fix lands.
  // F1/F2 convergence target moved to the "current behaviour" block as
  // "F1 / F2 FIXED" — schema and manual builder now agree.
  // F3 convergence target moved to the "current behaviour" block as
  // "F3 FIXED" — schema and manual builder now agree.
  // F4 convergence target moved to the "current behaviour" block as
  // "F4 FIXED" — schema and manual builder now agree.
});
