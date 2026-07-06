# Design: Per-Campaign Script Instantiation

**Status:** proposal for review — input to a design session with Pi. Nothing built yet.
**Audience:** Pi + Mark. Assumes familiarity with `AUDIT-PROPOSE-PATH.md` (read the "Council review
— 2026-07-03" section first).
**Goal:** settle the architecture so the custody fixes land in ONE redeploy with no open critical
TODOs.

---

## 1. Why we're here (one paragraph)

The propose flow was completed and audited. `propose()` is now correct. But a 6-agent review of the
*reclaim* lifecycle found `redeem()` is critically broken (cross-proposal theft + stranding, all
realizable on-chain), and — crucially — the obvious fix (`After{cosponsored_hash}` datum field) is
**unsound**: it can't be enforced. This doc proposes the fix that *is* sound and lists the decisions
needed to build it once.

## 2. Root cause (the load-bearing fact)

**All proposals share one reward account.** The cosponsor validator is parameterized only by
`(state_policy_id, state_nft, true_policy_id)` — not per-proposal (`validators/cosponsor.ak:15-19`)
— so there is one script hash, one address, one stake/reward credential for the entire protocol.
Every proposal's ledger deposit-refund accrues to that single reward account. The Cardano ledger
requires a reward withdrawal to drain the **whole** balance at once, and the withdraw script context
sees only `withdrawals = [(own_credential, total)]` — a single integer with **no per-proposal
provenance**. Consequence: nothing on-chain can attribute a refunded lovelace to the proposal it
came from, so `redeem()`'s attempt to do so (the `#""` catch-all bucket in `cosponsor_ada_map`)
commingles all proposals' money, and any datum label we stamp on an `After` output is
attacker-chosen. **You cannot fix attribution downstream of a shared account.**

## 3. Proposed architecture: one script instance per campaign

Give **each campaign its own parameterized cosponsor script** → distinct script hash → **distinct
address, reward account, and gADA policy**, holding only that campaign's money. Cross-campaign
commingling then becomes structurally impossible, and the entire `#""`/expired-set keying machinery
can be **deleted** from `redeem()`, `aggregate()`, and `withdraw()` at once. Pooling is preserved
(many pledgers still pool into one campaign's `Before` UTxOs); only *cross-campaign* pooling — the
bug class — is removed.

**"Campaign" = one governance action being crowdfunded** (1:1 with a proposal). *[Decision D1 —
confirm this granularity.]*

**This is not novel — it extends an existing pattern.** `cosponsor_state` is already parameterized
by a genesis `OutputReference` (`protocol_boot_utxo`) and mints its NFT exactly once by requiring
that UTxO be spent (`validators/cosponsor_state.ak:52-66`). Per-campaign instantiation applies the
same genesis-seed idea to the cosponsor validator itself: a campaign is created by spending a unique
seed UTxO, which parameterizes (and thus uniquely names) that campaign's script.

### Before / after

| Aspect | Today (shared) | Per-campaign |
|---|---|---|
| cosponsor script | 1 for all proposals | 1 per campaign (seed-parameterized) |
| script address / reward account | shared | isolated per campaign |
| gADA policy | shared (token name = proposal hash) | per campaign (its own policy) |
| refund attribution | impossible → the bug | trivial (account holds one campaign) |
| `cosponsor_ada_map` `#""` keying | required, exploitable | **deleted** |
| `After` datum | needs unforgeable identity (can't have) | stays nullary |

## 4. The decisions to settle (this is the agenda)

### D1 — Campaign granularity
1:1 campaign↔proposal (recommended — it's what makes reward-account isolation equal per-proposal
isolation). Confirm.

### D2 — Does the global `cosponsor_state` / MPF survive?
The MPF's only job was recording which proposals expired, for `redeem()`'s time-lock. With isolated
campaigns we can replace it:
- **Option A — keep a global expiry registry.** A shared (read-only, non-custodial) state UTxO still
  records per-campaign deadlines; redeem references it. Pro: one place to track expiry. Con: keeps a
  shared component (and its current bugs: permissionless spend, attacker-chosen `final_validity` —
  would still need fixing); reintroduces coordination.
- **Option B — per-campaign expiry, no global MPF (recommended).** Each campaign records its own
  deadline (e.g. stamped into the `After` datum at `withdraw()`, or a tiny per-campaign state UTxO),
  and `redeem()` checks `transaction.validity_range` against it directly. Deletes the global MPF, the
  `Proof`/`anchor_list` redeemer plumbing, `mpf_updated_correctly`, AND the entire `TODO(mpf-multi-
  entry)` problem. Fully isolated. This is the cleaner fix and likely *removes* more code than it
  adds.

Recommendation: **Option B.** *[This is the biggest decision — it determines whether the MPF stays.]*

### D3 — Reference-script deployment: cost model
Each campaign is a distinct ~18KB script. Options for making it spendable:
- **Deploy a reference script per campaign** (simple; costs ~min-ADA locked per campaign + one tx at
  creation). Matches today's reference-script pattern.
- **Inline-witness the script per spend** (no locked ADA, but every deposit/propose/withdraw/redeem
  tx carries ~18KB → large fees, possible tx-size limits). Not recommended at this script size.
- Recommendation: **reference script per campaign**, deployed at campaign creation, its cost folded
  into the creation flow (D4). *[Confirm who bears the locked ADA and whether it's reclaimable.]*

### D4 — Campaign-creation flow (who, when, what it costs)
Creating a campaign = spend the genesis seed UTxO + deploy the parameterized reference script +
register the campaign's reward account (needed before propose) + establish initial state. That's a
few txs and ADA (ref-script min-ADA + ~2 ADA stake deposit + fees).
- **Who:** the proposal author, presumably. *[Confirm — or is it lazily created on first pledge?]*
- **When:** eager (at proposal creation) vs lazy (on first pledge). Eager is simpler to reason about;
  lazy avoids spinning up scripts for proposals nobody funds. *[Decision.]*

### D5 — Reward-account registration timing
Becomes per-campaign: each campaign's reward account must be registered before its propose. The
existing `register-reward-account.ts` generalizes to take the campaign script hash. Low risk.

### D6 — Backend indexer + frontend discovery
Today the UI scans ONE script address (`fetchWithdrawalPlan`, `useChainState`). Per-campaign, each
proposal maps to its own address derived from its seed. Needed:
- The cosponsor-api backend records the **seed → campaign-script-address** mapping per proposal and
  indexes each campaign's UTxOs.
- The frontend chain-state layer resolves a proposal's campaign address (from the backend) and scans
  that, instead of one global address. `proposalTotals.ts` / `useChainState.tsx` change from
  "scan the script" to "scan this campaign."
- *[This is real cross-repo work — scope it. Likely the backend does the aggregation and the UI just
  reads per-proposal totals from the API.]*

## 5. Campaign lifecycle (target)

1. **Create** — author spends a unique seed UTxO → derives campaign script → deploys its reference
   script → registers its reward account. Backend records seed + address for the proposal.
2. **Pledge** — pledgers `deposit` ADA into the campaign's `Before` UTxOs; gADA (campaign policy)
   minted 1:1.
3. **Aggregate** (optional) — consolidate small `Before` UTxOs within the campaign.
4. **Propose** — once pooled ≥ deposit, `propose` submits the gov action; ledger locks the deposit
   and (later) refunds it to *this campaign's* reward account.
5. **Withdraw** — after resolution, `withdraw` drains this campaign's reward account (unambiguous
   single-campaign balance) into an `After` UTxO, stamping the deadline (Option B).
6. **Redeem** — gADA holders burn tokens for ADA, gated by the deadline check against the tx
   validity range. Single campaign → simple per-token conservation, no cross-proposal keying.

## 6. Ledger-refund empirical validation (do BEFORE building — this is the crux risk)

The entire reclaim model assumes chain behavior the validator cannot assert. **Run these on preview
first; the answers may reshape the design:**
- After a governance action is **enacted**: does the ledger refund `gov_action_deposit` to
  `return_address`? At which epoch boundary / timing?
- After an action **expires** unenacted (or is dropped/rejected): same refund? timing?
- Does the refund land at exactly the campaign's reward account, and nothing else touch it?
- Confirm per-campaign accounts isolate cleanly with **≥2 concurrent campaigns**.
- Confirm a script stake credential can be registered and its rewards withdrawn by the withdraw
  validator (the `register-reward-account` on-chain-acceptance item, still unverified).

If refunds don't flow as assumed, withdraw()/redeem() need rethinking regardless of architecture.

## 7. Mapped change set (one redeploy)

**Aiken:**
1. Parameterize `cosponsor` by a campaign seed (genesis `OutputReference`) → per-campaign hash.
2. Delete `#""` catch-all keying; simplify `cosponsor_ada_map` to single-campaign sums.
3. `redeem()`: enforce the deadline vs `transaction.validity_range` (today only MPF *membership* is
   checked, not the timestamp); require a genuine claim (close the vacuous `expired=[]` path).
4. `aggregate()`: add datum guard — forbid `Before → After` conversion and (with per-campaign
   scoping) enforce within-campaign conservation. *(Currently no datum guard at all.)*
5. `deposit()`: constrain **all** script outputs to backed `Before{this proposal}`; reject
   unbacked-`After` fabrication. *(Currently only matching Before outputs are summed.)*
6. `withdraw()`: tie the `After` output to this campaign (trivial once per-campaign); stamp deadline
   (Option B); keep lovelace-equality.
7. ADA-only token guard on all Before/After outputs (resolves `validators/cosponsor.ak:14` TODO).
8. `cosponsor_state`: under Option B, **removed** (its permissionless-spend + attacker-chosen-expiry
   bugs disappear with it). Under Option A, add spend authorization + tamper-proof expiry.

**SDK (`offchain/`):**
9. Campaign-creation builder (seed spend + script derivation + ref-script deploy + reward-account
   registration).
10. Deposit/Propose/Withdraw/Redeem builders use the per-campaign address/policy/reward account.
11. Stop hardcoding `proof:[]`/`expiredProposals:{}` in withdraw/redeem builders
    (`UnifiedWithdrawal.ts:322-323`, `BrowserWithdrawal.ts:196-197`) — moot under Option B.
12. `TODO(mpf-multi-entry)` (`Propose.ts`, `proposeBuilder.ts`) — **eliminated** under Option B; else
    implemented.

**Fold in while redeploying anyway:**
13. **Network parameterization** — `conversion.ak` hardcodes testnet nibbles (`0x60/0x70/0xe0/0xf0`);
    parameterize now to avoid a second redeploy for mainnet.

**Backend/UI:** per-campaign address discovery + indexing (§4 D6).

**Explicit product decision (not custody):** NewConstitution / ProtocolParameters remain
unproposable (datum can't round-trip) — defer *iff* not needed at launch; document the decision.

## 8. Testing strategy

`validators/tests/redeem_audit.ak` is the spec and **flips**:
- `h1_*`, `h3_*` cross-proposal drains → must now **REJECT** (separate accounts make them
  unspendable together).
- `h2_*` honest reclaim → must **PASS**.
- New: aggregate cross-proposal merge REJECT; `Before→After` in aggregate REJECT; redeem-before-
  deadline REJECT; deposit unbacked-`After` REJECT; ADA-only guard tests.
`propose_proof.ak` golden vectors stay green (the CBOR reconstruction is unchanged; if any breaks,
stop — a field-set change leaked into `metadata_validation`).

## 9. Migration / redeploy

Fresh per-campaign topology → all existing preview pools orphaned (already the case for this
redeploy line). Preview cutover as in `RUNBOOK-PROPOSE-REDEPLOY.md`, plus the per-campaign creation
flow. Mainnet: not deployed; do network parameterization (change 13) before it.

## 10. Decisions needed (session checklist)

- **D1** campaign = proposal (1:1)?
- **D2** Option B (per-campaign expiry, delete global MPF) vs Option A (keep global registry)? ← biggest
- **D3** reference-script-per-campaign confirmed? who bears/recovers the locked ADA?
- **D4** campaign creation: author-initiated? eager vs lazy?
- **D6** backend-aggregates vs UI-scans-per-campaign for chain state
- Product: defer NewConstitution/ProtocolParameters at launch — yes/no?
- Sequencing: run the §6 preview refund-flow experiments **before** committing to the build?

## 11. Risks

- **Chain-behavior dependency** (§6) — the model rests on refund flow we haven't observed; validate
  first.
- **New architecture surface** — seed parameterization, campaign creation, address derivation, and
  backend indexing are new code needing their own review; we're trading a datum bug for a topology
  change.
- **Per-campaign cost/UX** — a script deploy + stake registration per campaign adds ADA cost and txs
  to creation; make sure the UX and economics are acceptable.
- **Independent pre-mainnet review** recommended regardless — this is deposit-custody code.
