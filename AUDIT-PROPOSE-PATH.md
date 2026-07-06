# WPropose Path Audit & Fix — 2026-07-02

> **⚠ SUPERSEDED IN PART (2026-07-03 redesign):** everywhere this document describes propose safety
> via `metadata_validation`'s whole-body CBOR reconstruction, that mechanism has since been
> REPLACED: `propose()` now checks `list.has(transaction.proposal_procedures,
> cosponsored.procedure)` directly against the Plutus V3 script context, and
> `metadata_validation`/`conversion.ak` are dead on the propose path. Rationale, consequences
> (including the open anchor-binding gate) and per-file detail: **`REVIEW-ONCHAIN-CHANGES.md`**.
> The findings, custody fixes (A/B), council review, and mainnet-gate checklist below remain
> current.

Triggered by Pi's question: *"Does it support the last step, creating the proposal once it has
enough funds?"* Answer at the time: no. This document records what the investigation found, what
was fixed, and what remains.

## Summary

The on-chain `WPropose` machinery existed but was **unfinished and unusable**: its transaction-body
CBOR reconstruction could not match any node-acceptable transaction, it had zero test coverage, no
off-chain builder ever exercised it, and it carried a cross-proposal fund-theft vulnerability. The
reconstruction and the vulnerability are now fixed and covered by 8 new tests (15/15 suite green).
The off-chain builder (SDK), redeploy, and UI remain (Phases 2–4 below).

## Design findings (unchanged, working as intended)

**Propose is permissionless by design.** `propose()` (`lib/calculation/cosponsor.ak`) has no
signature or author check — there is no author concept on-chain. Safety is structural:

1. **Funds can only exit into the exact pledged action.** `metadata_validation` reconstructs the
   transaction body CBOR — including the `proposal_procedures` field built from the datum's
   `cosponsored` procedure — and requires `transaction.id == blake2b_256(tx_cbor)`. No other body
   can produce the same id.
2. **The submitter never gets custody.** `ProposalProcedure.return_address` is fixed at deposit
   time to the cosponsor script's own credential (`offchain/src/browser/BrowserDeposit.ts`,
   `offchain/src/validators/Cosponsor.ts`). The ledger's deposit refund lands at the script's
   reward account → `WWithdraw` moves it into an `After` UTxO → gADA holders reclaim via `MRedeem`.
3. **Surplus is preserved.** Pooled ADA above `procedure.deposit` must return to the script under a
   `Before` datum for the same proposal.

The submitter's only costs are the tx fee and collateral. Any UI-level gating (e.g. author-only)
would be cosmetic; the product decision is to show "Submit proposal" to anyone once
`pledged >= deposit`.

## Defects found (all empirically confirmed, all fixed)

Proof method: golden CBOR vectors generated with `@blaze-cardano/core` (cardano-sdk serialization,
Conway era — the same serializer every SDK-built transaction goes through), asserted against the
on-chain converters in `validators/tests/propose_proof.ak`. Before the fix, every test failed with
the mismatched bytes visible side by side.

| # | Defect (pre-fix state) | Consequence |
|---|---|---|
| 1 | `metadata_validation` opened with `#"a9"` (CBOR map of 9) but appended 10 fields | Malformed reconstruction; could never hash-match |
| 2 | Withdrawals field (key `05`) missing — yet WPropose is a withdraw-purpose redeemer, so the real body always carries a 0-lovelace script withdrawal | Real body ≠ reconstruction, always |
| 3 | TTL (key `03`) missing — yet the co-spent `cosponsor_state` validator requires a finite validity upper bound | Same |
| 4 | `convert_proposal` emitted PlutusData constructor encodings (`d879...`) where ledger CDDL requires `[coin, reward_account_bytes, gov_action, anchor]` | A node rejects PlutusData-shaped bytes in `proposal_procedures`; a valid body never matches |
| 5 | `convert_outputs` emitted pre-Babbage array outputs — but the leftover output needs an inline datum, which only exists in map-form Babbage outputs | Leftover/change outputs inexpressible |
| 6 | `convert_inputs` concatenated raw 32-byte txids without the `0x5820` bytestring header, and no Conway tag-258 set wrapper | Inputs never matched |
| + | **Vulnerability:** `propose()` bucketed all `Before` inputs under one dict key, so pledges for proposal B could be spent into proposal A's submission, stranding B's gADA holders | Cross-proposal fund theft |

## Fixes applied (working tree, not yet committed)

- **`lib/calculation/conversion.ak`** — rewritten to emit byte-exact Conway CDDL: tag-258
  (`d90102`) sets, `5820`-headed hashes, legacy array outputs when datum-free / map-form Babbage
  outputs with `[1, #6.24(bytes)]` datum wrapping (mirrors cardano-sdk's per-output choice), real
  reward-account bytes (`0xe0`/`0xf0` + hash), new `convert_withdrawals` / `convert_ttl` /
  `convert_reference_inputs`, and per-variant `convert_governance_action` (Info, NoConfidence,
  HardFork, TreasuryWithdrawal, ConstitutionalCommittee).
- **`lib/calculation/cosponsor.ak`** — `metadata_validation` rebuilt: canonical ascending-key body
  `00,01,02,03,05,09,0b,0d,[0e],10,11,[12],14` with dynamic arity (`0e`/`12` included only when
  non-empty, matching the ledger's omit-empty behavior). Collateral fields stay redeemer-supplied
  (invisible to the script context). **Vulnerability fixed**: every cosponsor input's datum must
  hash to the same `proposal_procedure_hash` as the proposal being submitted.
- **`validators/tests/propose_proof.ak`** (new) — 8 tests: 4 golden-vector converter tests, the
  integrated canonical-body happy path, leftover-preservation (exercises real `CosponsorDatum`
  inline-datum bytes), and 2 attack tests (mixed-proposal inputs → aborts at the new check;
  tampered action in the real body → id mismatch). Doubles as the acceptance suite defining the
  canonical body layout the SDK builder must produce.

`aiken check`: **15/15 pass** (8 new + 7 pre-existing, no regressions).

## Known limitations (documented in code)

1. **NewConstitution and ProtocolParameters actions cannot be proposed.** Aiken's script-context
   types drop ledger-level data (the constitution's own anchor; the full parameter-update map), so
   their body bytes cannot be reconstructed from the datum. `convert_governance_action` fails
   loudly on them. Supporting them requires a datum-type extension (e.g. carrying raw action CBOR).
2. **Testnet-only address/reward-account tagging.** `conversion.ak` hardcodes the testnet network
   nibble (`0x60/0x70` payment, `0xe0/0xf0` reward). Must be parameterized before any mainnet
   deployment.
3. The Aiken fuzz-scenario framework isn't used for propose — the body-hash coupling makes random
   scenario generation impractical; deterministic fixtures are the right tool here.

## Remaining work

- **Phase 2 — SDK builder**: `offchain/src/transactions/Propose.ts` + browser wrapper. Strategy:
  build with Blaze (coin selection/fees/collateral), then splice body field `20`
  (`proposal_procedures`), recompute `script_data_hash` + tx id, hand exact CBOR to CIP-30
  `signTx`. Blaze has no governance support (confirmed). Includes the MPF proof plumbing for the
  `cosponsor_state` spend.
- **Phase 3 — redeploy + UI**: validator changes mean new script hashes → redeploy on preview
  (existing preview pools under the old hash are orphaned — drain via withdraw first where
  possible). UI `ModalPropose`/`ButtonPropose` on the proposal detail page, shown to any connected
  wallet when `pledgedAmount >= cosponsorTarget`.
- **Phase 4 — E2E on preview**: deposit → propose → refund → `WWithdraw` → `MRedeem` with a real
  non-empty MPF proof (that path has never been exercised with a genuine proof either).

---

# Findings — 2026-07-03 post-Phase-3 custody review

Two custody gaps surfaced while tracing the reclaim lifecycle (deposit → propose → refund →
withdraw → redeem). One is fixed; one is a serious confirmed vulnerability requiring a redesign.

## Finding A — propose leftover output not pinned (FIXED)

`propose()` (`lib/calculation/cosponsor.ak`) builds its output map with
`cosponsor_ada_map(dict.empty)`, which keys every output to `#""`. The leftover branch verified
only the surplus *amount* and that exactly one cosponsor output exists — it never checked that
output's datum. A proposer of A could route A's surplus into a `Before` UTxO labeled as proposal
B (siphoning A's pledgers' surplus to B's gADA holders) or into an `After` UTxO (prematurely
redeemable).

**Fix (applied):** the leftover branch now requires every cosponsor output to be
`Before { cosponsored }` hashing to the proposal being submitted (mirrors the Phase-1 input-side
guard). Tests: `attack_leftover_routed_to_other_proposal_rejected`,
`attack_leftover_as_after_datum_rejected` (both `fail`), plus the existing
`proof_propose_preserves_leftover_at_script` positive case — all green (17/17).
Folded into the same redeploy bytecode; no extra redeploy needed.

## Finding B — redeem() `#""`-bucket commingling (CONFIRMED EXPLOITABLE — redesign required)

`redeem()` (`lib/calculation/cosponsor.ak`) collapses **every** `After` UTxO and every
non-expired `Before` UTxO — across *all* proposals — into one shared `#""` bucket via
`cosponsor_ada_map`, and burns of non-expired gADA also key to `#""`. `no_ada_leak` enforces only
per-*bucket* conservation, so `#""` is a commingled pool with no proposal-identity check. Same bug
class as Finding A / the Phase-1 input guard, but `redeem()` has no equivalent guard.

Audit tests in `validators/tests/redeem_audit.ak` (6 tests, all green; suite 23/23):

- **H1 — CONFIRMED EXPLOITABLE** (`h1_cross_proposal_after_drain_confirmed`,
  independently re-verified). With `expired_proposals: []`, an attacker burns 5 ADA of an
  unrelated non-expired proposal X's gADA (keys `#""`) while spending proposal Y's `After` refund
  UTxO worth 5 ADA (keys `#""`) straight to their own wallet. Merged `#""` bucket = 5M − 5M = 0,
  no cosponsor output required → Y's refund is stolen with X's worthless gADA.
- **H2 — intended reclaim path is broken** (`h2a_…_works`, `h2b_…_unsatisfiable`). Honest
  refund-reclaim validates *only* when `expired_proposals` is empty — i.e. only via the same
  unguarded `#""` path H1 abuses. The moment the expired proposal is actually *listed* (with a
  valid proof), the gADA burn keys to the proposal hash while the `After` refund keys to `#""`;
  they land in different buckets and can never net → the refund becomes strandable. The
  `proof`/`expired_proposals` machinery is not just unused (UnifiedWithdrawal.ts always sends
  `[]`/`{}`), using it makes redeem impossible.
- **H3 — CONFIRMED EXPLOITABLE, bounded** (`h3a_…`, `h3b_…`, `h3c_over_extraction_rejected`).
  Theft extends to *live* pledges: burning proposal B's gADA drains proposal A's non-expired
  `Before` UTxO. Legitimate expired redemption + `#""` theft coexist in one tx. BUT `h3c` bounds
  it: per-key conservation holds — total ADA-out always equals total gADA burned. The exploit is
  *which proposal's* ADA you take, not *how much* (no inflation from nothing).

**Why not a quick stop-gap:** requiring every burn/spent-`Before` to be in `expired_proposals`
would block H1/H3 but (a) still leaves H2's `After` reclaim broken (After has no proposal
identity), and (b) breaks the *currently-working* pre-proposal withdraw flow (ModalWithdraw /
`UnifiedWithdrawal.ts` deliberately send `expired_proposals: []`). So a stop-gap regresses a
working path for tomorrow's testing while only half-closing the hole.

**Correct fix (redesign — follow-up, mainnet blocker):** give `After` a proposal-identity field
(`After { cosponsored_hash }`) so refunds key to their own proposal, and always key
`Before`/burns to the proposal hash regardless of expired-set membership. Eliminates `#""`
commingling entirely. Touches the datum → `withdraw()`/`redeem()`/`deposit()` + the SDK datum
builders + another redeploy. Scope with Pi. The `redeem_audit.ak` tests are the spec: after the
redesign, H1/H3 must flip to rejecting and H2's honest reclaim must validate *with* the expired
proposal listed.

**Preview impact for tomorrow:** none on the propose E2E. `propose()` is now well-guarded;
`redeem()` is the broken part, and redeem-after-propose was already blocked by
`TODO(mpf-multi-entry)`. Preview uses test ADA. Proceed with the propose test; do NOT rely on
redeem for anything real until the redesign lands.

---

# Mainnet gate checklist

Deposit-custody code — recommend an **independent review** before mainnet, not just in-house passes.

| # | Item | State | Blocks |
|---|------|-------|--------|
| 1 | propose leftover output pinned to proposal | ✅ fixed (Finding A) | — |
| 2 | Phase-1 cross-proposal input guard | ✅ fixed | — |
| 3 | WPropose body reconstruction correctness | ✅ fixed + golden-locked | — |
| 4 | **redeem() `#""` commingling (theft + broken reclaim)** | ❌ **confirmed vuln, redesign needed** (Finding B) | **mainnet** |
| 5 | MPF multi-entry (2nd+ propose, redeem-after-propose) | ❌ `TODO(mpf-multi-entry)` | 2nd propose / redeem |
| 6 | testnet-only address/reward tagging in conversion.ak | ⚠️ hardcoded 0x60/0x70/0xe0/0xf0 | mainnet |
| 7 | NewConstitution / ProtocolParameters unproposable | ⚠️ datum can't round-trip; fails loudly | those action types |
| 8 | stake-registration on-chain acceptance | ⏳ verify on preview | propose (untested) |

Items 4 and 5 are the same root cause family (proposal identity + MPF plumbing) and are best
tackled together in the redeem/After redesign.

---

# Council review — 2026-07-03 (6-agent audit + validation of the above)

An independent 3-auditor + 3-validator council re-derived every claim above from source. It
**upheld** findings A, B-H1, B-H2, B-H3 (all realizable on-chain) but **overturned the recommended
fix [R]** and found the mainnet checklist incomplete. Corrections below supersede the "correct fix"
and checklist in the 2026-07-03 section.

## Correction 1 — `After{cosponsored_hash}` is UNSOUND (the "add a field" fix is a trap)

The reward/stake account is shared across **all** proposals: the validator is parameterized only by
`(state_policy_id, state_nft, true_policy_id)` — not per-proposal (`validators/cosponsor.ak:15-19`)
— and every deposit/propose sets `returnAddress` to the one script credential
(`BrowserDeposit.ts:103`, `BrowserPropose.ts:67`). The Cardano ledger requires a reward withdrawal
to drain the **entire** account balance, and the withdraw script context sees only
`withdrawals = [(own_credential, total)]` — a single untagged integer with **zero per-proposal
provenance**. So any `hash` stamped on an `After` output at `withdraw()` is builder-declared and
**on-chain-unverifiable**: a withdrawer can label the whole multi-proposal lump `After{A}`,
stranding every other proposal's refund (escalating to theft when A's gADA is attacker-held). The
datum field merely relocates the `#""` commingling from redeem to withdraw. **Do not implement it.**
(An MPF amount-reconciliation-at-withdraw variant was also considered and rejected: a same-total
different-set relabel passes a sum check and converts stranding into theft — provenance isn't
provable to a spend/withdraw script.)

## Correction 2 — the SOUND fix is per-campaign script instantiation

Parameterize the cosponsor validator by a unique per-campaign seed (a genesis `OutputReference`
spent at campaign creation, or equivalent nonce) → **distinct script hash → distinct reward account
per campaign**, holding only that campaign's money. Then `withdraw()` drains an unambiguous
single-campaign balance, `After` can stay nullary (no identity field), and the entire `#""`/
expired-set keying in `cosponsor_ada_map` can be **deleted** because commingling becomes
structurally impossible in redeem(), aggregate(), and withdraw() at once. Pooling is preserved
(many pledgers → one campaign's `Before`); only *cross-campaign* pooling — the bug class — is
removed. Honest scope: this changes deployment topology and every SDK address-derivation path, not
just a datum. (Fragile non-recommended fallback: operationally serialize to one in-flight proposal
per full cycle — NOT enforced on-chain, breaks under concurrency.)

## Correction 3 — additional custody bugs the earlier review missed

- **aggregate()** (`cosponsor.ak:239-261`): only checks `ada_conserved + one_output_per_proposal +
  withdraw_zero` with **no datum guard** — can mix proposals / convert `Before → After`.
- **redeem() expiry is cosmetic**: only MPF *membership* is checked (`has()`), not the recorded
  expiration VALUE against `transaction.validity_range` — the time-lock isn't enforced; and the
  vacuous `expired_proposals=[]` path must be closed.
- **cosponsor_state expiry is attacker-controlled**: `proposal_expiration = final_validity +
  proposal_lifetime` with attacker-chosen `final_validity`; the state spend is also permissionless,
  and a victim's hash can be force-inserted as "expired" by resubmitting the identical procedure.
- **deposit()** (`cosponsor.ak:269-290`): `minted_correct_amount` only sums *matching* `Before`
  outputs — After outputs and unmatched Befores are unconstrained (unbacked-`After` fabrication).
- **token-quantity TODO** (`validators/cosponsor.ak:14`): no ADA-only guard on Before/After outputs
  → foreign-token/dust griefing.

## Corrected make-once change set (one redeploy, per-campaign architecture)

Aiken: (1) parameterize cosponsor by campaign seed; (2) delete `#""` catch-all keying / simplify
`cosponsor_ada_map`; (3) redeem: enforce expiry timestamp vs validity range + require real proof;
(4) aggregate: add datum/identity guard, forbid Before→After; (5) deposit: constrain ALL script
outputs to backed `Before{this proposal}`; (6) withdraw: tie After output to the campaign; (7)
ADA-only token guard everywhere; (8) cosponsor_state: add spend authorization + tamper-proof expiry.
SDK: (9) campaign-creation builder; (10) per-campaign address/reward derivation in all builders;
(11) stop hardcoding `proof:[]`/`expiredProposals:{}` in withdraw/redeem builders; (12) implement
`TODO(mpf-multi-entry)`. Tests: H1/H3 must now REJECT, H2 must PASS, + aggregate/deposit/expiry/
state-auth attack tests. Then redeploy.

## Corrected deferred-item triage

- **mpf-multi-entry — CRITICAL-PATH** (not deferrable): without it only one empty-trie propose works
  and the whole redeem-after-propose reclaim lifecycle is untestable — a redesign you can't exercise
  end-to-end is a half-fix.
- **testnet network tagging** (`conversion.ak` `0x60/0x70/0xe0/0xf0`) — **fold in now**: it's a
  mainnet gate (wrong prefixes = invalid mainnet addresses) and you're redeploying anyway; avoid a
  second redeploy by parameterizing the network nibble.
- **NewConstitution / ProtocolParameters unproposable** — genuinely deferrable, but only as an
  explicit documented product decision (not a custody bug).

## Residual risk (cannot be closed in one code pass)

- **Ledger refund flow must be validated empirically on preview** (timing + destination + clean
  per-campaign isolation with ≥2 concurrent campaigns) — chain behavior the validator can't assert.
- Per-campaign instantiation is new architecture (seed parameterization, state design, address
  derivation) that needs its own review — trading a datum bug for a topology change.
- Independent pre-mainnet review scope: refund flow E2E; re-audit aggregate()/deposit() under the
  new keying; state authorization + expiry enforcement; a fresh read of the load-bearing
  `metadata_validation` CBOR reconstruction (unchanged but easy to break on any field-set change).

## Immediate-next (tomorrow's preview) — unchanged and safe

Proceed with the **single-proposal propose happy path** on test ADA only. propose() is correct and
complete (A) and independent of the broken redeem path. Do NOT exercise multi-proposal aggregate or
the withdraw→redeem reclaim lifecycle. A green preview means "propose submission works," not "the
protocol is safe."

---

# Finding — 2026-07-03 (surfaced by the first TreasuryWithdrawal test case)

Setting up TEST_WITHDRAWAL_1 (a TreasuryWithdrawal requesting 10 tADA) surfaced a **latent bug in
the propose path for any action carrying credentials** (TreasuryWithdrawal, ConstitutionalCommittee):

- `Propose.ts:534` spreads `cosponsoredProposal` into `encodeProposalProcedures` **without
  converting** the action's `beneficiaries`.
- The SDK types `beneficiaries` as `TCredential` (the friendly `{ vkey }` / `{ script }` form), but
  `proposeBody.ts`'s `credentialParts` only recognised the on-chain `{ VerificationKeyCredential:[h] }`
  / `{ ScriptCredential:[h] }` form → it would **throw at encode time** for a real `TCredential`.
- Never caught because only NicePoll (no credentials) had ever been exercised. NicePoll / HardFork /
  NoConfidence are unaffected.
- Bonus: `proposeBody.ts` imported `TCredential` from the wrong module (`CosponsorTypes`, which has
  no such export) — a pre-existing dangling type error.

**Fixed:** `credentialParts` now normalises **both** forms (`{ vkey }`/`{ script }` and the on-chain
`{ VerificationKeyCredential }`/`{ ScriptCredential }`); the credential params widened to a
`TAnyCredential` union; the `TCredential` import corrected to `@validators/Types/Credential.js`.
Cross-locked by new golden tests on both sides —
`validators/tests/propose_proof.ak :: golden_treasury_withdrawal_matches_sdk` and the
`TreasuryWithdrawal encoding` case in `tests/propose-body-golden.test.ts` — asserting the same bytes
(`8302a1581de0<hash>1a00989680f6`). SDK 136 tests + Aiken 24 tests green; SDK repacked to 0.0.5 and
reinstalled into the UI so both the automated (scripts) and manual (UI) paths carry the fix.

This validates the value of the TreasuryWithdrawal test case: it caught a real encode-path bug before
it cost an on-chain failure. TreasuryWithdrawal is now the recommended first E2E propose case (it
exercises the reward-account encoding NicePoll doesn't).
