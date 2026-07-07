import { ICosponsoredProposal } from "@validators/index";
import { IGovernanceActionId } from "@validators/Types/GovernanceAction";

/**
 * Named test proposals for the propose E2E flow. Select at runtime with
 * `TEST_PROPOSAL=<name>` — honored by `deposit.ts` and `propose-dry-run.ts` so
 * the pooled deposits and the propose target use the IDENTICAL procedure.
 *
 * WHY THIS MATTERS: the gADA token name is `blake2b(procedure)`. If a deposit
 * run and a propose run build even slightly different procedures, they hash to
 * different tokens and the propose can't find the pooled UTxOs. So every
 * hash-affecting field here is a FIXED constant — do not make them
 * env-dependent, or two runs with different env would diverge.
 *
 * `anchor.url` is HEX-encoded (matches `deposit.ts` and `anchorUrlHexToText`
 * in `Propose.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SUBMIT-READY FIXTURES (SUBMIT_*) — added 2026-07-04
 * ─────────────────────────────────────────────────────────────────────────
 * Deployment #2 propose VALIDATES on-chain (all scripts pass), but a REAL
 * submission must also satisfy Conway ledger governance rules. These SUBMIT_*
 * fixtures target those rules. Every open decision / placeholder below is
 * collected in `cosponsor-contracts/PROPOSAL-SUBMISSION-DECISIONS.md` — review
 * that file and fill the `PLACEHOLDER_*` values before submitting.
 *
 * Confirmed preview params (epoch 1347): gov_action_deposit = 1000 tADA,
 * protocol version = 11.0, gov_action_lifetime = 30 epochs, guardrails
 * (constitution) script hash = fa24fb30…  Nothing is submitted by preparing
 * these — submission is a separate, explicit step (PROPOSE_SUBMIT=1).
 */

// ── Ledger constants (preview, epoch 1347) ────────────────────────────────

/**
 * The protocol `gov_action_deposit`. EVERY governance action must lock exactly
 * this as the proposal deposit (refunded when the action is enacted/expires).
 * The CoSponsor pool must therefore reach >= this for a real submission.
 */
export const GOV_ACTION_DEPOSIT = 1_000_000_000n; // 1000 tADA

/**
 * Constitution guardrails script hash — canonical definition now lives in
 * `utils/guardrails.ts` (D1 resolved: the builder witnesses it via reference
 * input). Re-exported here for the fixtures below.
 */
import { GUARDRAILS_SCRIPT_HASH } from "@/utils/guardrails.js";
export { GUARDRAILS_SCRIPT_HASH };

// ── PLACEHOLDERS (fill from PROPOSAL-SUBMISSION-DECISIONS.md before submit) ──

/**
 * PLACEHOLDER D2 — previous-governance-action-id ("ancestor") for the purposes
 * that thread state. Conway REJECTS these actions unless the ancestor equals
 * the currently-enacted action id for that purpose (or null iff none is enacted
 * on preview since genesis). Must be read from preview's live governance state
 * at submission time. `null` here is a guess that is only valid if that purpose
 * has never been enacted on preview — almost certainly wrong for Committee /
 * Constitution. TreasuryWithdrawal and InfoAction take NO ancestor.
 */
// D2a — the enacted action that set the current preview committee (from Koios
// /committee_info). Every NoConfidence / UpdateCommittee action must reference it.
const PLACEHOLDER_ANCESTOR_COMMITTEE: IGovernanceActionId | null = {
  txHash: "ac993231c39a4ee13bcf888e971e099809c4c08d96a7572aa3611a5ed42fa7d4",
  index: 0,
};
// D2b — last enacted HardForkInitiation on preview (Koios /proposal_list,
// enacted epoch 1291; resolved 2026-07-06 via utils/ancestors.ts).
const PLACEHOLDER_ANCESTOR_HARDFORK: IGovernanceActionId | null = {
  txHash: "fa2b252c9d645b376ee68f94ea87764dad6510e201726921e0cb733161ca6ef8",
  index: 0,
};
// D2c — last enacted ParameterChange on preview (enacted epoch 1330).
const PLACEHOLDER_ANCESTOR_PPARAMS: IGovernanceActionId | null = {
  txHash: "2a2dc37b22939d3ae7395c8a409d4d0625201c88926d641d6f4441c3287e39ba",
  index: 0,
};
// D2d — NO NewConstitution has ever been enacted on preview (Koios verified
// 2026-07-06), so null is the ledger-correct ancestor for this purpose.
const PLACEHOLDER_ANCESTOR_CONSTITUTION: IGovernanceActionId | null = null;
// NOTE: ancestors are hashed into the gADA at deposit time but checked against
// LIVE state at submission — always run `assertAncestorCurrent` (or the
// propose-dry-run submit guard) before PROPOSE_SUBMIT=1.

/**
 * PLACEHOLDER D3 — a REGISTERED stake account for a TreasuryWithdrawal
 * beneficiary. The ledger rejects withdrawals whose return account isn't
 * registered on-chain (`TreasuryWithdrawalReturnAccountsDoNotExist`). The dummy
 * `aa…aa` used by the dry-run fixture is NOT registered. Candidates: the
 * cosponsor reward account (already registered), or register the test wallet's
 * own stake key. Set as `{ vkey }` or `{ script }`.
 */
const PLACEHOLDER_WITHDRAWAL_BENEFICIARY = {
  // D3 RESOLVED: the Deployment #2 cosponsor script credential — its reward
  // account (stake_test17rv9pmevv…) was registered by register-reward-account
  // at deploy time, satisfying TreasuryWithdrawalReturnAccountsDoNotExist.
  script: "d850ef2c64d86f4a258d69cf4f2e73f966a433f54116c7e5b391e53c",
} as const;

/**
 * PLACEHOLDER D4 — HardFork target protocol version. Current preview is 11.0.
 * A hardfork to an unsupported major version is rejected by nodes that don't
 * recognise it. DECISION: `{ major: 12, minor: 0 }` (next major) vs a minor
 * bump. Left as next-major; confirm what preview nodes accept.
 */
const PLACEHOLDER_HARDFORK_VERSION = { major: 12, minor: 0 }; // D4

/**
 * PLACEHOLDER D5 — ConstitutionalCommittee update parameters: members to add
 * (credential → mandate epoch, <= current_epoch + committee_max_term_length
 * (365)), members to remove, and the quorum threshold rational. All dummy.
 */
const PLACEHOLDER_COMMITTEE_MEMBER_TO_ADD = {
  vkey: "11111111111111111111111111111111111111111111111111111111",
} as const; // D5a
const PLACEHOLDER_COMMITTEE_MANDATE_EPOCH = 1700n; // D5b (absolute epoch)
const PLACEHOLDER_COMMITTEE_QUORUM = { numerator: 1n, denominator: 1n }; // D5c

// ── helper ────────────────────────────────────────────────────────────────

const hexUrl = (s: string): string => Buffer.from(s).toString("hex");

// ── DRY-RUN fixture (kept; NOT submittable — 150 tADA deposit) ─────────────

const TEST_WITHDRAWAL_1_DEPOSIT = 150_000_000n;

/**
 * TEST_WITHDRAWAL_1 — a TreasuryWithdrawal requesting 10 tADA to a fixed test
 * beneficiary. Correct for a DRY-RUN only (script eval checks pooled >=
 * procedure.deposit); the ledger's deposit / guardrails / return-account rules
 * are enforced only at REAL submission, which this fixture does NOT satisfy.
 * Golden-locked Aiken<->SDK in `propose_proof.ak :: golden_treasury_withdrawal…`.
 */
export const TEST_WITHDRAWAL_1: ICosponsoredProposal = {
  deposit: TEST_WITHDRAWAL_1_DEPOSIT,
  anchor: {
    url: hexUrl("https://cosponsor.app/proposal/test-withdrawal-1"),
    hash: "2222222222222222222222222222222222222222222222222222222222222222",
  },
  action: {
    kind: "TreasuryWithdrawal",
    beneficiaries: [
      [
        { vkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        10_000_000n,
      ],
    ],
    guardRails: undefined,
  },
};

// ── SUBMIT-READY fixtures (all deposit = GOV_ACTION_DEPOSIT) ────────────────

/**
 * SUBMIT_INFO — InfoAction (NicePoll). The ONLY type with no extra ledger
 * requirements: no ancestor, no guardrails, no return account. Fully ready to
 * submit once the pool reaches 1000 tADA. Best first real-submission candidate;
 * exercises pledge → propose → submit → vote-down → deposit-refund.
 */
export const SUBMIT_INFO: ICosponsoredProposal = {
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    // Anchor URL + dataHash are LOCKED into the gADA at deposit time — do not
    // change without re-depositing. This URL points at the preview UI's served
    // static file (cosponsor-ui/static/proposals/info-action.jsonld), VERIFIED
    // live: GET returns 200 application/ld+json, bytes hash to df37068a. hash =
    // blake2b-256 of that file; changing the domain/path changes the gADA.
    url: hexUrl(
      "https://cosponsor.preview.sundae.fi/proposals/info-action.jsonld",
    ),
    hash: "df37068aa4185c0d53249bda992a43bf04d4c0883205a292898d9f59fc9580e7",
  },
  action: { kind: "NicePoll" },
};

/**
 * SUBMIT_NO_CONFIDENCE — motion of no confidence. Needs the Committee-purpose
 * ancestor (D2a). No guardrails, no return account.
 */
export const SUBMIT_NO_CONFIDENCE: ICosponsoredProposal = {
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    url: hexUrl(
      "https://cosponsor.preview.sundae.fi/proposals/no-confidence.jsonld",
    ),
    hash: "051b12f69528a2271ddc4697cf05f8782bb67f7d16714d2320ec60ce95e594ea",
  },
  action: { kind: "NoConfidence", ancestor: PLACEHOLDER_ANCESTOR_COMMITTEE },
};

/**
 * SUBMIT_TREASURY_WITHDRAWAL — 10 tADA treasury withdrawal, 1000 tADA deposit.
 * Needs guardrails witness (D1) + a registered beneficiary account (D3). No
 * ancestor.
 */
export const SUBMIT_TREASURY_WITHDRAWAL: ICosponsoredProposal = {
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    url: hexUrl(
      "https://cosponsor.preview.sundae.fi/proposals/treasury-withdrawal.jsonld",
    ),
    hash: "b37fdc18554dc4e8e306b12bb196265d3cd424fc9b2b119c87e61e2c2a4a0013",
  },
  action: {
    kind: "TreasuryWithdrawal",
    beneficiaries: [[PLACEHOLDER_WITHDRAWAL_BENEFICIARY, 10_000_000n]],
    guardRails: GUARDRAILS_SCRIPT_HASH, // D1: builder must also witness it
  },
};

/**
 * SUBMIT_HARDFORK — hard-fork initiation. Needs ancestor (D2b) + a target
 * version preview nodes accept (D4).
 */
export const SUBMIT_HARDFORK: ICosponsoredProposal = {
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    url: hexUrl(
      "https://cosponsor.preview.sundae.fi/proposals/hard-fork.jsonld",
    ),
    hash: "9ae7d84db82a8a140f0d7cd15c05f8024586e29d199517a49e47fdeb2d86ad99",
  },
  action: {
    kind: "HardFork",
    ancestor: PLACEHOLDER_ANCESTOR_HARDFORK,
    version: PLACEHOLDER_HARDFORK_VERSION,
  },
};

/**
 * SUBMIT_COMMITTEE — constitutional-committee update. Needs ancestor (D2a,
 * shares the Committee purpose) + member/quorum decisions (D5). No guardrails.
 */
export const SUBMIT_COMMITTEE: ICosponsoredProposal = {
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    url: hexUrl(
      "https://cosponsor.preview.sundae.fi/proposals/constitutional-committee.jsonld",
    ),
    hash: "5a982f93a6d1e8cfd619964022e17e05bc164eafe57de9806fb5e5f81bd37996",
  },
  action: {
    kind: "ConstitutionalCommittee",
    ancestor: PLACEHOLDER_ANCESTOR_COMMITTEE,
    membersToRemove: [],
    membersToAdd: [
      [
        PLACEHOLDER_COMMITTEE_MEMBER_TO_ADD,
        PLACEHOLDER_COMMITTEE_MANDATE_EPOCH,
      ],
    ],
    quorum: PLACEHOLDER_COMMITTEE_QUORUM,
  },
};

/**
 * SUBMIT_NEW_CONSTITUTION — new constitution (D6 RESOLVED 2026-07-06: SDK
 * encoder work only, no contract change). The constitution DOCUMENT anchor
 * (`constitutionAnchor`, plain-text url + blake2b-256 of the raw file) is an
 * encoder-only input with NO datum slot — it does NOT affect the gADA hash
 * (locked by `protocol-parameters-roundtrip`-style invariance test), so the
 * datum still commits only {ancestor, guardrails}. By convention the CIP-108
 * metadata declares the same document. Keeps the CURRENT guardrails script
 * (a no-op constitution change if it ever ratified — it won't).
 */
export const SUBMIT_NEW_CONSTITUTION: ICosponsoredProposal = {
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    url: hexUrl(
      "https://cosponsor.preview.sundae.fi/proposals/new-constitution.jsonld",
    ),
    // Updated 2026-07-06: metadata now declares the constitution document in
    // its references (the constitutionAnchor convention).
    hash: "2ccb4c0504f63588d77ef4fb2175ecf85a2ff39df11ce5e97f8d46b079dd40cf",
  },
  action: {
    kind: "NewConstitution",
    ancestor: PLACEHOLDER_ANCESTOR_CONSTITUTION,
    guardrails: GUARDRAILS_SCRIPT_HASH,
    // blake2b-256 of cosponsor-ui/static/proposals/test-constitution.txt
    // (LF-pinned via .gitattributes; hash is over the RAW served bytes).
    constitutionAnchor: {
      url: "https://cosponsor.preview.sundae.fi/proposals/test-constitution.txt",
      hash: "18075c0bc7c6f23481739c78921ca6c74124d676be19680f90bee4857102b534",
    },
  },
};

/**
 * SUBMIT_PROTOCOL_PARAMS — protocol-parameter update (D7 RESOLVED 2026-07-06).
 * Change: maxTxSize (param 3) 16384 → 16400 — integer-valued, inert (+16
 * bytes headroom), and inside the guardrails bounds [0, 32768] from
 * defaultConstitution.json. The ledger rejects EMPTY updates
 * (MalformedProposal), and the guardrails script bounds-checks the values,
 * so this is the minimal real change. Needs the D2c ancestor + guardrails
 * witness (D1, wired in the builder).
 */
export const SUBMIT_PROTOCOL_PARAMS: ICosponsoredProposal = {
  deposit: GOV_ACTION_DEPOSIT,
  anchor: {
    url: hexUrl(
      "https://cosponsor.preview.sundae.fi/proposals/protocol-parameters.jsonld",
    ),
    hash: "5cf73c70390e3e7dee487798785bbe4408dfd9e2ed8c8fab8d7abfd17d27b758",
  },
  action: {
    kind: "ProtocolParameters",
    ancestor: PLACEHOLDER_ANCESTOR_PPARAMS,
    newParameters: [[3n, 16400n]],
    guardRails: GUARDRAILS_SCRIPT_HASH,
  },
};

export const TEST_PROPOSALS: Record<string, ICosponsoredProposal> = {
  // Dry-run only
  TEST_WITHDRAWAL_1,
  // Submit-ready (subject to the PLACEHOLDER_* decisions above)
  SUBMIT_INFO,
  SUBMIT_NO_CONFIDENCE,
  SUBMIT_TREASURY_WITHDRAWAL,
  SUBMIT_HARDFORK,
  SUBMIT_COMMITTEE,
  SUBMIT_NEW_CONSTITUTION,
  SUBMIT_PROTOCOL_PARAMS,
};

/** Returns the proposal named by `TEST_PROPOSAL`, or undefined if unset. */
export const selectTestProposal = (): ICosponsoredProposal | undefined => {
  const name = process.env.TEST_PROPOSAL;
  if (!name) return undefined;
  const proposal = TEST_PROPOSALS[name];
  if (!proposal) {
    throw new Error(
      `Unknown TEST_PROPOSAL "${name}". Known: ${Object.keys(TEST_PROPOSALS).join(", ")}`,
    );
  }
  return proposal;
};
