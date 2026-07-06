# CoSponsor Deployment Ledger

Accumulating record of every on-chain contract deployment: which version was deployed, where, and
what it contained. **Append a new entry per deployment — never overwrite.** The redeploy orchestrator
also writes machine-readable `deployed-contracts.json` (latest only) and `redeploy-output.json`; this
file is the durable human history.

A "version" is identified by the parameterized **cosponsor script hash** (the gADA policy id) — that
uniquely pins the on-chain logic + parameters. The SDK npm version and git state are recorded for
provenance but are not the on-chain identity.

Address semantics (see the reference-script deploy discussion): the deploy address is **spendable**
on preview so reference-script min-ADA is reclaimable on the next redeploy. Mainnet must use an
unspendable/always-false address for immutability (mainnet-gate item).

---

## Deployment #1 — Preview — 2026-07-03 (**LIVE / COMPLETE**)

Deployed via Blockfrost from the agent sandbox. First two attempts hit
`ConwayMempoolFailure "All inputs are spent"` on chained txs — VERIFIED root cause (from the on-chain
input chain, not assumed): largest-first coin selection always reselects the *running change* output,
and Blockfrost's **address** index lags a beat behind each spend, so the next tx grabs the
already-spent change. Fixed with **local UTxO chaining** (`offchain/src/utils/utxoChaining.ts`): keep
the expected wallet UTxO set locally (drop spent, add change) instead of trusting the API between
chained txs. Re-run completed cleanly. **Two previously-unverified unknowns now confirmed on-chain:
script stake-registration works, and the boot UTxO is at index 0.**

| Field | Value |
|---|---|
| Network | preview |
| Status | **LIVE — full stack deployed + registered + state NFT minted** |
| SDK npm version | 0.0.5 |
| Aiken compiler | v1.1.21 |
| Git state | cosponsor-contracts working tree (UNCOMMITTED) |
| Deploy address (reference scripts) | `addr_test1qp69u6ka06zrxm0akqsfku6w862klmxx5gv8s2n5sv75nfxenku8xvgssv0852hyj36cpkzfs5p0pqpspt6qapm2rapqkayyvf` (spendable, reclaimable) |
| Protocol boot UTxO | `d395e5f427380afa959ad9b0e8c11e6f6bf8fdf3f1669bdfb6de0227e461bae9#0` |
| **Cosponsor hash (gADA policy)** | `8c902eac18a93796efa6b85b4b975754eab52d649faf6a9012b2f27d` |
| CosponsorState hash | `158c3efa50e67e0d8520272f20b79bfc0329b71d80fcddca71aa9428` |
| AlwaysTrue hash | `def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea` |
| State NFT | policy = CosponsorState hash, name `cosponsor_state_nft` |
| Reward (stake) address registered | `stake_test17zxfqt4vrz5n09h056u9kjuh2a2w4dfdvj06765sz2e0ylgfme46r` ✅ |
| Deploy tx — CosponsorState | `5db4832471a55a5b71e7bb1a579e62dccdb5531342576c0717f93b87a9736496` |
| Deploy tx — AlwaysTrue | `b406d71432aca5e449a42290724cfadf9269d3f260e6cd3a7677540170d6de3a` |
| Deploy tx — Cosponsor | `c2a28bd41b8216362d9fdabc69b05eb7a567629a7113637c22fbea518f5e6d07` |
| Register reward tx | `9a11c3dc12ea1cb607d7ff5afb568ea83c56b0f7427ce060a0900f242d7c26fc` |
| Mint state NFT tx | `93b18a04ffe00ba3055d5b0b78fa042bb01edc6c8297670761ff54eede33f404` |

**To target this deployment from scripts/SDK, set:**
`PROTOCOL_BOOT_TRANSACTION_ID=d395e5f427380afa959ad9b0e8c11e6f6bf8fdf3f1669bdfb6de0227e461bae9`,
`PROTOCOL_BOOT_TRANSACTION_INDEX=0`, `PROPOSAL_LIFETIME_MS=432000000`,
`SCRIPT_REFERENCE_ADDRESS=addr_test1qp69u6ka06z…kayyvf` (BrowserConfig.ts already patched).

**Contents / what this version fixes** (vs the prior deployed `87264e48…` pre-fix contracts, now
orphaned):
- WPropose body-reconstruction rewrite (`metadata_validation` + `conversion.ak`) — propose actually
  validates now.
- Phase-1 cross-proposal input guard (`propose()`).
- Leftover-output pinning (Finding A, 2026-07-03).
- Credential-form encoder fix (TreasuryWithdrawal/ConstitutionalCommittee propose path).
- TreasuryWithdrawal encoding golden-locked Aiken↔SDK.

**Known NOT fixed in this version** (documented, deferred to the per-campaign redesign):
- `redeem()` `#""`-bucket commingling (cross-proposal theft + broken reclaim) — CRITICAL, redesign.
- aggregate() datum guard, redeem expiry timestamp, state auth, deposit unbacked-After, token guard.
- MPF multi-entry; testnet-only address tagging.
This version is for **propose-leg validation on preview only** — do NOT rely on redeem/withdraw.

**Test target on this deployment:** TEST_WITHDRAWAL_1 (TreasuryWithdrawal, 10 tADA) via
`TEST_PROPOSAL=TEST_WITHDRAWAL_1 bun run deposit` then `... propose-dry-run`.

### Dry-run result on Deployment #1 (2026-07-03)

- **Deposit** toward TEST_WITHDRAWAL_1 (TreasuryWithdrawal, 150 tADA): ✅ tx `7625d7150d071e420d6bdc8233cee28c525099d749294d11fd6c2874f3aaac71`, indexed at cosponsor addr.
- **Propose BUILD** (SDK two-pass + field-20 splice + tx-id recompute, TreasuryWithdrawal): ✅ built, id `d5fd52a8…`, 1219-byte body.
- **Propose EVALUATION** (authoritative, via Ogmios v6 og1 — Blockfrost's proxy gave only an empty/uninformative `ScriptFailures{}`): ❌ **REJECTED**. Two scripts error: `withdraw` index 0 (WPropose / `metadata_validation`) and `spend` index 2 (a cosponsor spend). Empty traces (non-trace build).
- **Read-out:** the propose path builds a well-formed tx but the on-chain validator rejects it. Most likely a full-tx-body reconstruction mismatch in `metadata_validation` (the golden vectors cross-lock the `proposal_procedures` field only, NOT an entire real-tx body incl. inputs/outputs/collateral/mint/script_data_hash) and/or the withdrawal not matching `present_in_withdrawal`'s 0-lovelace check. **Next: rebuild Aiken with traces (`aiken build --trace verbose` / traced blueprint) and re-evaluate to pinpoint the failing check.**

### ROOT CAUSE of the propose rejection (2026-07-03) — anchor-URL hex/text inconsistency

Pinned both failing scripts and the cause by decoding the built tx:
- `withdraw` idx 0 = **WPropose** (`Constr 122`) → `propose()`/`metadata_validation`.
- `spend` idx 2 = **cosponsor_state** (redeemer = `{proof:[], anchor_list:[…]}`).

Evidence: the deposited **gADA token = `3029efb5…`**, which is the proposal hash computed with the
anchor URL in **hex** form (matches `TEST_WITHDRAWAL_1.anchor.url`, which is hex — the datum
convention). But the ledger's `proposal_procedures` field (20) and the state redeemer's `anchor_list`
carry the URL as **decoded text** (`https://cosponsor.app/proposal/test-withdrawal-1`) — because the
ledger requires a real URL string, and `Propose.ts` correctly runs `anchorUrlHexToText` for field 20.

The mismatch: on-chain `metadata_validation` reconstructs field 20 from the **datum's** `cosponsored`
(hex URL) via `convert_anchor`, which uses the URL bytes **as-is** (no hex→text decode) → it produces
a hex-URL field 20, but the actual tx's field 20 is text-URL → the body hash ≠ `tx.id` → WPropose
fails. Likewise the state MPF: the SDK's new root uses the hex-URL hash while the validator recomputes
from the text-URL redeemer anchor → roots differ → `mpf_updated_correctly` fails.

**Fix direction (not yet applied):** canonicalize the anchor URL to a single form across deposit
datum, gADA hash, field-20 encoding, `convert_anchor`, and the state MPF. Cleanest is **store the
URL as text everywhere** (drop the hex convention) so no decode is needed on-chain and all four
derivations agree. Touches the SDK deposit/anchor handling + `Cosponsor.gAda()` (and check the UI's
`proposalIdentity.ts` anchor construction); no Aiken change if the datum stores text. Requires a
re-deposit + re-propose to verify. This is a design change — do it deliberately, not hastily.

### Propose root-cause + redesign decision (2026-07-03, traced deployment 22249b75/8c902eac)

Trace-enabled eval pinned both propose failures:
- **WPropose `metadata_validation` ? False** — the CBOR body reconstruction hashes the *sorted*
  Plutus script-context input order, but cardano-sdk serializes input sets NON-DETERMINISTICALLY
  (JS-Set order — 3 runs gave 3 orders). The byte-exact CBOR-hash approach is fragile by design;
  hex post-sorting loses to Transaction.toCbor() re-shuffling on every round-trip.
- **cosponsor_state `mpf_updated_correctly` ? False** — MPF leaf formula verified correct
  (`blake2b(0xff‖blake2b(key)‖blake2b(value))`); mismatch is the key (proposalHash vs
  proposal_procedure_hash) or the expiration value (slotToUnix(ttl)+lifetime vs final_validity+lifetime).

**Decision:** redesign WPropose to verify the pledged action via the Plutus V3
`transaction.proposal_procedures` context field DIRECTLY (as cosponsor_state already does), dropping
`metadata_validation`'s whole-body CBOR reconstruction. Removes the input-ordering + collateral-byte
fragility, simpler + more auditable. Plus fix the MPF key/expiration alignment. Then redeploy + re-verify.

---

## Deployment #2 — Preview — 2026-07-03 (**LIVE / COMPLETE — propose validates end-to-end**)

First deployment on which the **propose leg validates fully on-chain**. Both propose bugs from
Deployment #1 are fixed and independently confirmed by an authoritative on-chain evaluation (all four
redeemers accepted). Non-traced production build (clean source, no debug traces).

| Field | Value |
|---|---|
| Network | preview |
| Status | **LIVE — deployed + registered + state NFT minted; propose eval PASSES** |
| Aiken compiler | v1.1.21, **non-traced** (`aiken build`) |
| Deploy address (reference scripts) | `addr_test1qp69u6ka06zrxm0akqsfku6w862klmxx5gv8s2n5sv75nfxenku8xvgssv0852hyj36cpkzfs5p0pqpspt6qapm2rapqkayyvf` (spendable, reclaimable) |
| Protocol boot UTxO | `97f715b8c15e436bb063148a39116b4c41931ae53e0f9caece75a68bf9b6750b#0` |
| **Cosponsor hash (gADA policy)** | `d850ef2c64d86f4a258d69cf4f2e73f966a433f54116c7e5b391e53c` |
| CosponsorState hash / State NFT policy | `398105b2090c7f0773d3ffe37ca4951c2f34e7954516830d73dc96df` |
| AlwaysTrue hash | `def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea` |
| Deploy tx — CosponsorState | `a6ca10502cfe63ba9f5ea4035ad5e6ac7aabe824190008babf2867c0e57a546e` |
| Deploy tx — Cosponsor | `80e5b49040601ea834d49b3570c4c9e23a209d73c32a0822f1c7661711ea9390` |
| Register reward tx | `a1aaa44ce28e10ce1e3ceb4465daa73a1f3902d88018c4e72e30520d86b9d155` |
| Mint state NFT tx | `19c20601ad202fe2f2ef9bcdf22aaba75f38f59554f5a5888970142580f10e43` |

`Config.ts` default `PROTOCOL_BOOT_TRANSACTION_ID` now points here, and `BrowserConfig.ts` is patched
with these hashes/ref-script tx-ids (the redeploy step-5 auto-patch still fails on a stale-value regex —
patched manually; see fix note below).

### The two propose root causes — FIXED and confirmed

1. **WPropose (`withdraw` idx 0)** — replaced `metadata_validation`'s whole-tx-body CBOR
   reconstruction with a direct check against the Plutus V3 context:
   `list.has(transaction.proposal_procedures, cosponsored.procedure)`
   (`lib/calculation/cosponsor.ak`). Kills the non-deterministic input-ordering fragility entirely.
   NOTE: the context's `ProposalProcedure` drops the anchor, so the anchor is committed by the gADA
   token at deposit but not re-verified in WPropose — **mainnet gate: decide if anchor binding is required.**

2. **cosponsor_state `mpf_updated_correctly` (`spend` idx 2)** — a **fractional-slot bug in the SDK**,
   not the validator. `blaze.provider.unixToSlot(validUntil)` returns a *fractional* slot
   (e.g. `116444210.9`) when `validUntil` isn't slot-aligned. The state datum's `proposal_expiration`
   was derived from `slotToUnix(fractional)`, but the tx body's ttl (field 3) is the *floored integer*
   slot — so the datum baked in a sub-slot (~900 ms) offset that the on-chain `final_validity` (integer
   slot) could never reproduce → MPF root mismatch. **Fix:** `Math.floor(...)` the slot in
   `Propose.ts` so the datum expiration and the tx ttl pin to the same integer slot. Verified: the
   validator's independently-computed root then equals `blake2b(0xff‖blake2b(gADA)‖blake2b(cbor(exp)))`.

### Verification on Deployment #2 (2026-07-03)

- **Deposit** toward TEST_WITHDRAWAL_1 (TreasuryWithdrawal, 150 tADA): ✅ tx `b62ef01d8734f0559826ba22c9f7f4f5824f0aa04c5657ea9a7440dfd02bdf31`, gADA `d850ef2c…7cfd50c6…` at cosponsor addr.
- **Propose BUILD + on-chain EVALUATION** (authoritative, provider eval, TreasuryWithdrawal): ✅ **ACCEPTED**. All four redeemers pass — `spend` idx 0 (cosponsor Before), `spend` idx 2 (cosponsor_state MPF), `mint` idx 0 (AlwaysTrue), `withdraw` idx 0 (WPropose). Built tx id `2ad7a3640d3da569200039dafc4b1d7c3bcd7133124fa05d6608c87277e7837f` (**dry-run only — not submitted**).
- Same result was first confirmed on an interim traced deployment (`836309…`, boot `9560f8f3…`) via Ogmios v6 traces, which is how the fractional-slot bug was pinned.
- **Real submission attempt (TEST_WITHDRAWAL_1) — rejected by the Conway ledger, NOT by our scripts.** All CoSponsor scripts pass; the ledger rejected the *governance action* for protocol-level reasons: proposal deposit must be exactly `gov_action_deposit` = **1000 tADA** (not 150), TreasuryWithdrawal needs the guardrails script `fa24fb30…` witnessed, and the withdrawal return account must be registered. These are standard Conway requirements every proposal must meet. Submittable mock fixtures for **all 7 action types** (`SUBMIT_*` in `offchain/src/scripts/test-proposals.ts`) and the consolidated open-decision list are in **`PROPOSAL-SUBMISSION-DECISIONS.md`**. InfoAction/NicePoll is the only type with no extra blockers (just the 1000 tADA pool).

### ✅ FIRST REAL COSPONSOR GOVERNANCE ACTION SUBMITTED — InfoAction (2026-07-04)

Full pledge → propose → **submit** lifecycle exercised on preview via the `SUBMIT_INFO` fixture:
- **Pool deposit** (1000 tADA toward SUBMIT_INFO): tx `bd1f0b8279c5c44f0c847db14e4a8bc45a8826e741ea599f5638c8e422f34c38`.
- **Propose + submit** (WPropose, InfoAction): tx `4c02db3325f839ca6d6cf289b2eb6047434ca52ad68aab17acfb0fb9f64cdc96`.
- **On-chain governance action:** `gov_action1fspdkve9lquu5mtv72ym96mqgap5eff26692k9avlv8mnajvmjtqq76sz4h` — type `InfoAction`, deposit 1000 tADA, **return_address = the cosponsor reward account** (`stake_test17rv9pmevvnvx7j39345u7neww0ukdfpn74q3d3l9kwg720q8f7haz`), expires epoch **1379**.
- **Anchor:** url `https://cosponsor.app/proposals/preview-infoaction-test-1.jsonld`, dataHash `45b06b97…637e`. Metadata (CIP-108, carries the `[INFO]` "do not pass, testing" disclaimer) is committed at `proposal-metadata/preview-infoaction-test-1.jsonld` — **must be hosted at that URL** for voters to see the disclaimer (the ledger doesn't fetch it; hosting is for wallets/explorers).
- **Deposit-refund note:** on expiry the 1000 tADA refunds to the cosponsor *reward account* (as a withdrawable reward, not a UTxO), so reclaiming it exercises the withdraw/redeem path — which is the known redesign-blocked area. The test tADA is effectively committed until that path lands.

### ✅ MULTI-ENTRY MPF IMPLEMENTED — 2nd proposal on the SAME deployment (2026-07-05)

The `mpf-multi-entry` TODO is DONE — a deployment now holds unlimited proposals (no redeploy per
proposal). The on-chain `cosponsor_state` validator always supported real MPF proofs; only the SDK
lacked them. New module `offchain/src/utils/mpfReconstruct.ts`:
- **Trustless, self-verifying reconstruction.** The trie is insert-only (state inserts; redeem only
  does membership `has`; nothing deletes), and the state NFT is spent+recreated by every propose, so
  its tx history IS the ordered propose list. For each propose tx: `key = blake2b_256(cbor(cosponsored))`
  from a spent Before datum, `value = serialise(slotToUnix(ttl)+PROPOSAL_LIFETIME)`. The rebuilt root
  is asserted equal to the on-chain root before any proof is trusted — a mismatch throws (never builds
  a tx on a bad trie).
- **Proofs via `@aiken-lang/merkle-patricia-forestry`** (v1.3.1, lazily imported so it stays out of the
  browser bundle). Validated byte-for-byte: the library's single-leaf root equals the on-chain formula,
  and `proof.toCBOR()` is spliced into the state redeemer's `proof` field (Constr 0 [proof, anchorList]).
- Tests: `offchain/tests/mpf-reconstruct.test.ts` (locked to the real preview roots below); 139 SDK
  tests green.

**Compliant InfoAction submitted as the 2nd proposal** (the `df37068a…` CIP-108 metadata redo):
- deposit `4ea1779c…` (1000 tADA, was stranded — now used).
- propose+submit tx `277badabcf4a1aa5421c0314a7794b7381a4ac3f54c65c2d4b41f4ffd960cd74`, type `InfoAction`, expires epoch **1380**.
- State trie went 1-leaf (`5cad3508…`, key `ab663b88…`) → **2-leaf (`e30b8dbe…`**, added key `fc36a457…`). Reconstruction re-verified against the 2-leaf root offline.
- Both InfoActions are now live on preview (`4c02db33` non-compliant metadata; `277badab` compliant). Host each anchor file to surface titles: `preview-infoaction-test-1.jsonld` (45b06b97) for the 1st, `info-action.jsonld` (df37068a) for the 2nd.

### ✅ GUARDRAILS-WITNESSED TreasuryWithdrawal SUBMITTED — the product path (2026-07-06)

The last blocked product-path action type. `offchain/src/utils/guardrails.ts` +
Propose/BrowserPropose wiring: the constitution guardrails script `fa24fb30…` is referenced via
preview's long-lived reference UTxO `f3f61635…#0`, a Proposing-purpose unit redeemer is patched in
post-`complete()` each fixed-point pass, and body field 11 is recomputed via Blaze's
`computeScriptData` (self-checked against the pre-patch hash). Ancestors now resolve dynamically
(`utils/ancestors.ts`, Koios-backed) with a staleness guard on every `PROPOSE_SUBMIT=1`.
- Pool deposit (1000 tADA toward SUBMIT_TREASURY_WITHDRAWAL): tx `dce9a90041f59fc99ffcc4722ce5dddede159ec0b25b94e13a2f2b86fd1d2e3a`.
- Propose + submit: tx `3481a13f15dde994c1425d8d839af4dcb5f21a0932d6178625b53a9263d46e5c` →
  `gov_action1xjq6z0c4mh5efs2ztkxc8xh5mj6lyxsfxttp0p39k5afyc75dewqq965uvv`, type
  `TreasuryWithdrawals` (10 tADA to the registered cosponsor reward account), expires epoch **1381**.
- Eval showed all FIVE redeemers accepted, incl. the guardrails `propose` purpose
  (345,409 mem / 78,588,117 steps — inside the 1M/250M declared budget). State trie 4 → 5 leaves.

### ✅ ProtocolParameters (ParameterChange) SUBMITTED — 6 of 7 action types live (2026-07-06)

D7 resolved with full SDK support and NO contract change (post-WPropose-redesign the datum's stdlib
`ProposalProcedure` is compared structurally against the V3 context; the ChangedParameters Data
shape was reproduced from cardano-ledger's `ToPlutusData`: Map ascending by param id, ints as I,
intervals as List [I num, I den]). Change: **maxTxSize 16384 → 16400** (inert, inside guardrails
bounds). Guardrails redeemer actually bounds-checked it: 413,605 mem / 91,555,982 steps.
- Pool deposit: tx `781cf3befab4374c7fa9bdb6f9d48bfe203869fd2f7b05181e3f48918032f4a2`.
- Propose + submit: tx `8b5f096ad63618f1b73112d8ac46fb59519897cbfa318fdb9ffed2dfcee782e4` →
  `gov_action13d0sj6kkxcv0rde3ztv2c3hmt9ge397tlgcclkullmfdlnh8stjqqhs744v`, type `ParameterChange`
  (Koios decodes `{"max_tx_size": 16400}`), expires epoch **1381**. State trie 5 → 6 leaves.
- Remaining unposted types: HardFork (D4 version choice) and NewConstitution (SDK anchor plumbing,
  see PLAN-REMAINING-PROPOSAL-TYPES.md §2) — both deferred by choice, not blocked by the contracts.

### ✅ NewConstitution SDK support — EVAL-VERIFIED; HardFork creation disabled in UI (2026-07-06)

D6 implemented SDK-only: `INewConstitution.constitutionAnchor` (plain-text url + blake2b of the
constitution document) feeds ONLY the field-20 `new_constitution` encoder — invariance test locks
that it does NOT perturb the gADA (the V3 context drops the anchor, so the datum can't and needn't
commit it; the CIP-108 metadata's `references` declare the document by convention). Constitution
document: `cosponsor-ui/static/proposals/test-constitution.txt` (`18075c0b…`); metadata
`new-constitution.jsonld` updated (dataHash now `2ccb4c05…`).
- Pool deposit: tx `b0e3cb1605ac7e090fc8b4e044b2897a62d92825fdbedaf146c7247fc8cfe4be` (1000 tADA).
- Propose build + on-chain eval: ✅ ACCEPTED (correctly NO guardrails redeemer — only TW/PParams
  run it).
- **SUBMITTED 2026-07-06** after the UI deploy (`98368a1`) was verified serving BOTH anchor files
  hash-exact: tx `89d3a6272398582f7e3608e4048e5da8c3afe541c01914e0a2326bc351b216ed` →
  `gov_action138f6vfernpvz7l3kprjqfrja4rp6le2pcqv3fc9zxf4ux5djzmksqv4nzu3`, type `NewConstitution`,
  expires epoch **1381**. Every action type except HardFork (deliberately disabled) is now posted.
- UI: HardFork removed from `SUPPORTED_ACTION_TYPES` (new `DISABLED_ACTION_TYPES`, product
  decision) — parsing/display of existing HF proposals unaffected. SDK 0.0.7 packed + installed.

### Tooling fix folded in

- `BrowserConfig.ts` `scriptReferenceUtxos.cosponsorState.txHash` had held a 56-char **script hash**
  (not a 64-char tx hash), so the redeploy step-5 auto-patch regex `"[0-9a-fA-F]{64}"` matched 0 times
  and always aborted step 5. Now set to the real deploy tx hash; future redeploys should patch cleanly.

**Still NOT fixed / mainnet-gated** (unchanged from Deployment #1): redeem `#""`-bucket commingling,
aggregate datum guard, redeem expiry, state auth, deposit unbacked-After, WPropose anchor binding,
MPF multi-entry, testnet-only address tagging. This deployment validates the **propose leg only**.
