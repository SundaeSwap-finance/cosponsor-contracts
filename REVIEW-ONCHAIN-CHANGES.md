# On-chain changes for review — WPropose redesign + custody fixes

**Audience:** the smart-contract author. This branch carries every change made to the deployed
Aiken source since the last committed state, the tests that lock the behavior, and the rationale.
These are the exact sources **Deployment #2** (preview, cosponsor/gADA `d850ef2c…`, boot
`97f715b8…` — see `DEPLOYMENTS.md`) was built from; the deployed bytecode matches this branch, NOT
the previous commit. Compiler: aiken v1.1.17 → **v1.1.21** (`aiken.lock`), `plutus.json` rebuilt.

Everything here is **validated on-chain**: 8 governance actions across 6 action types (InfoAction,
NoConfidence, ConstitutionalCommittee, TreasuryWithdrawal, ParameterChange, NewConstitution) were
submitted on preview through these validators, including multi-entry MPF state updates (trie now at
6 leaves) and guardrails-witnessed actions.

---

## 1. `lib/calculation/cosponsor.ak` — the substantive change

### 1a. WPropose: whole-body CBOR reconstruction → direct context check  *(the redesign)*

**Before:** `propose()` called `metadata_validation`, which reconstructed the ENTIRE transaction
body CBOR byte-for-byte (12+ fields, with the WPropose redeemer smuggling in the three
context-invisible collateral fields) and required `blake2b_256(body) == transaction.id`, thereby
proving the body contained the pledged `proposal_procedures`.

**Why it was replaced:** the reconstruction required byte-exact canonical CBOR — including
canonically sorted input sets — that cardano-sdk/Blaze does not emit deterministically. Six
encoding defects were fixed (see `AUDIT-PROPOSE-PATH.md`), and it STILL could not reliably
validate: the builder had to post-process body bytes after every `complete()`, and any wallet that
re-serializes the tx breaks the id. The approach was structurally fragile.

**After:** Plutus V3 exposes `transaction.proposal_procedures` in the script context, so the
validator now checks directly:

```aiken
list.has(transaction.proposal_procedures, cosponsored.procedure)?
```

The datum's `cosponsored.procedure` IS the aiken-stdlib `ProposalProcedure`, compared structurally
against what the ledger itself says the transaction submits. No serializer coupling at all.

**Consequences to weigh:**
- `metadata_validation` and all of `conversion.ak` are now **DEAD on the propose path** (see §2).
- The WPropose redeemer still carries the three collateral ByteArrays (now `_`-ignored) — kept so
  the redeemer SHAPE is unchanged; can be pruned at the next type-breaking redeploy.
- The AlwaysTrue mint check no longer compares the token name to `script_data_hash`
  (`_script_data_hash`) — only "exactly one token minted" remains. The name check only existed to
  feed the reconstruction.
- **OPEN — anchor binding (mainnet gate):** the context's `ProposalProcedure` DROPS the anchor, so
  the metadata anchor is committed by the gADA at deposit but NOT re-verified at propose. Same for
  a NewConstitution's constitution-document anchor (no slot in the context's `Constitution`).
  Decide whether a targeted anchor check must be restored (would need the anchor threaded some
  other way) or whether gADA commitment + off-chain verification is acceptable.
- **Free win:** because the check is structural against the stdlib type, ParameterChange and
  NewConstitution became proposable with ZERO contract work (their previous blockers lived in the
  dead CBOR encoders). Both are now live on preview.

### 1b. Input pinning (cross-proposal theft fix)

Every pooled cosponsor INPUT's `Before` datum must hash to THIS proposal. Without it,
`cosponsor_ada_map`'s catch-all `#""` bucket let pledges for proposal B fund proposal A's
submission, stranding B's gADA holders. Attack test: `attack_mixed_proposal_inputs_rejected`.

### 1c. Leftover-output pinning (custody review Finding A)

When pooled > deposit, the surplus output must carry `InlineDatum(Before { cosponsored })` hashing
to THIS proposal — previously only the amount and output-count were checked, so the leftover could
be an `After` (prematurely redeemable) or a `Before` for a different proposal. Attack test:
`attack_leftover_relabeled_rejected` (propose_proof.ak).

---

## 2. `lib/calculation/conversion.ak` — corrected, but now dead code

The six ledger-CDDL encoding defects found in the audit were fixed here (PlutusData-vs-CDDL shapes,
set tags, anchor/url encoding, reward-account headers, etc.) BEFORE the redesign made the module
unreachable from `propose()`. It is retained in this change set because (a) the fixes are correct
and documented against the golden vectors, and (b) deleting it is a separate decision.
**Recommendation:** delete it (and the WPropose redeemer's collateral fields) at the next
type-breaking redeploy rather than maintaining testnet-tagged dead code. Note its reward-account
encoding is testnet-tagged — irrelevant while dead, a footgun if ever revived.

---

## 3. New test suites (the executable spec)

- **`validators/tests/propose_proof.ak`** (728 lines, 17 tests): golden vectors generated from
  @blaze-cardano/core lock the canonical Conway body layout the SDK produces; positive proofs for
  the propose path; attack tests for 1b/1c. These vectors are mirrored in the SDK
  (`offchain/tests/propose-body-golden.test.ts`) — the two suites are the shared lock between
  on-chain and off-chain serialization.
- **`validators/tests/redeem_audit.ak`** (326 lines, H1/H2/H3): adversarial audit of `redeem()`'s
  `#""`-bucket accounting. **These tests are the spec for the pending redesign** — they currently
  PROVE the vulnerability (H1 cross-proposal refund drain validates; H2 honest reclaim is
  unsatisfiable; H3 mixed-bucket splits) and must flip after the redesign. Full write-up:
  `AUDIT-PROPOSE-PATH.md` Finding B + the council review.

---

## 4. Explicitly NOT in this change set (known, deferred)

Documented in `AUDIT-PROPOSE-PATH.md` (mainnet-gate checklist) and
`DESIGN-per-campaign-instantiation.md`, awaiting the joint design session:
redeem `#""` commingling (Finding B), per-campaign script instantiation, aggregate() datum guard,
redeem expiry check, state-update authorization, deposit unbacked-After fabrication, ADA-only
token guard, anchor binding (§1a). None of these got worse; propose-leg custody got strictly
tighter (1b/1c).

## 5. How to re-verify

```
aiken check          # all tests incl. attack + H-audit suites
aiken build          # plutus.json must reproduce (v1.1.21)
```
On-chain evidence per action type: `DEPLOYMENTS.md` (Deployment #2 section, tx hashes + eval
exUnits for every redeemer).
