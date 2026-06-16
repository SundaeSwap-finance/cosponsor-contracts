# Cosponsor SDK — Audit-driven Changes (uncommitted, work-in-progress)

Running record of changes being made in response to `AUDIT.md`. Nothing here is committed yet — this doc is the source of truth for what's queued up. Once a section is approved it gets squashed into a commit and removed from this file.

Conventions:
- Each entry references its `AUDIT.md` finding ID (F1–F30).
- "Touched files" lists every file changed by the entry, so a commit can be staged precisely from this doc.
- "Validation" notes the test(s) that prove the change is correct.

---

## Already in working tree (pre-audit)

These two changes were in the working tree before this audit started; they remain in place because they're either prerequisites or correct as-is.

- **package.json rename** — `@dezons/cosponsor-sdk` → `@sundaeswap/cosponsor-sdk`. Matches the GitHub repo (`SundaeSwap-finance/cosponsor-contracts`) and the `author: "SundaeSwap Labs"` already on the file. Treat as production name.
- **F4 partial fix (in working tree)** — `CosponsorTypes.ts:118-125` added `{ ctor: 0n }` to the outer `{ Constitution: ... }` wrapper. Stops the immediate throw on NewConstitution but the inner Object still lacks ctor and the wrapper itself adds an extra Constr layer vs the manual builder. The full F4 fix below will subsume this.

---

## Change 1 — Test infrastructure (F22b kickoff)

**Status:** DONE — 17/17 passing.

Adds the first off-chain test scaffolding the SDK has ever had. Bun's built-in test runner is used (no new dependency); `bunfig.toml` already points `[test] root = "./tests"`.

**Touched files:**
- `offchain/package.json` — replaced `"test": "echo …"` with `"test": "bun test"` and added `"test:watch"`
- `offchain/tests/schema-probe.test.ts` — validates all schema-vs-builder claims and adds a 7-variant `gADA asset-name equivalence` suite that's now the hard invariant for any future SDK change.

**Validation:** `cd offchain && bun test` → `17 pass / 0 fail / 24 expect() calls`.

**Commit shape:** `Add bun:test scaffolding and schema/builder equivalence suite`

---

## Change 2 — `AUDIT.md` + `AUDIT_CHANGES.md`

**Status:** DONE locally — descriptive only.

**Touched files:**
- `offchain/AUDIT.md` (new) — full audit document, 30 findings, fix order, method.
- `offchain/AUDIT_CHANGES.md` (this file).

**Commit shape:** `Document SDK correctness audit and fix plan`

---

## Change 3 — F4 full fix: NewConstitution schema

**Status:** DONE & VERIFIED — convergence test green.

The pre-audit working-tree fix added `{ ctor: 0n }` to the outer `{ Constitution: ... }` wrapper, which stopped one throw but left an inner Object without a ctor AND introduced an extra Constr layer the Aiken validator never produces. Subsumed here with a collapse of the wrapper to match the manual builder exactly.

**Touched files:**
- `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:110-128` — schema now `constitution: Type.Object({ guardRails: Type.Optional(Type.String()) }, { ctor: 0n })`.
- `offchain/src/validators/Types/GovernanceAction.ts:269-284` — `ToContractType.NewConstitution` no longer emits the `{ Constitution: ... }` wrapper.
- `offchain/tests/schema-probe.test.ts` — flipped the F4 convergence test active.

**Validation:** `bun test` — `F4 FIXED: NewConstitution — schema serialize now matches manual builder` passes. `gADA asset-name equivalence > NewConstitution: ...` passes.

**Commit shape:** `Fix NewConstitution schema to match Aiken Constitution record (F4)`

---

## Change 4 — F3 fix: HardFork.newVersion schema

**Status:** DONE & VERIFIED.

Aiken `ProtocolVersion { major, minor }` is a plain ctor-0 record: `Constr(0, [major, minor])`. The schema had `newVersion: Type.Object({ ProtocolVersion: Type.Object({ major, minor }) }, { ctor: 0n })` — inner Object lacked ctor (throw site) and the wrapper added an extra Constr layer the on-chain encoding doesn't have.

**Touched files:**
- `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:60-77` — schema now `newVersion: Type.Object({ major: Type.BigInt(), minor: Type.BigInt() }, { ctor: 0n })`.
- `offchain/src/validators/Types/GovernanceAction.ts:208-221` — `ToContractType.HardFork` no longer emits the `{ ProtocolVersion: ... }` wrapper.
- `offchain/tests/schema-probe.test.ts` — flipped F3 convergence test active.

**Validation:** `bun test` — `F3 FIXED: HardFork — schema serialize now matches manual builder` passes. gADA equivalence test for HardFork passes.

**Commit shape:** `Fix HardFork.newVersion schema to match Aiken ProtocolVersion record (F3)`

---

## Change 5 — F1+F2 fix: ProtocolParameters.newParameters schema

**Status:** DONE & VERIFIED.

Aiken's `ProtocolParametersUpdate` is an **opaque** type — encoded as a bare CBOR Map (`Pairs<Int, Data>`), no Constr wrapper. The schema had a doubly-wrapped `{ ProtocolParametersUpdate: { inner: Array(Tuple([BigInt, Data])) } }` — both wrappers structurally fake, the array-of-tuple wrong for a CBOR Map. Now uses `Type.Record(Type.Integer(), TPlutusData)` which makes `@blaze-cardano/data` emit a bare `PlutusMap` via the `patternProperties` branch in `data/dist/index.mjs`.

**Important note:** Must be `Type.Integer()`, not `Type.BigInt()`. TypeBox's `Type.Record` dispatch only recognises `IsInteger`/`IsNumber` as numeric-keyed and falls through to `Never` for `BigInt`. Discovered live by the convergence test failing with `01` (int 1) in the schema CBOR vs `a0` (empty map) in the builder CBOR.

**Touched files:**
- `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:46-67` — schema now `newParameters: Type.Record(Type.Integer(), TPlutusData)`.
- `offchain/src/validators/Types/GovernanceAction.ts:191-205` — `ToContractType.ProtocolParameters` emits `newParameters: {}`.
- `offchain/tests/schema-probe.test.ts` — flipped F1/F2 convergence test active.

**Validation:** gADA equivalence test for ProtocolParameters passes.

**Commit shape:** `Fix ProtocolParameters opaque-type schema (F1, F2)`

---

## Change 6 — F5+F6 schema honesty: Pairs<Credential, V> as TPlutusData passthrough

**Status:** DONE — schema now honestly typed; bytes unchanged.

Aiken `Pairs<Credential, _>` is a CBOR Map with Constr-typed keys. `@blaze-cardano/data`'s `Type.Record` can only express numeric- or bytes-keyed Maps (per `patternProperties` in `data/dist/index.mjs`) — there's no native way to declare a Constr-keyed Map in the schema. The previous `Type.Array(Type.Tuple([Credential, BigInt]))` was a lie that worked only because `ToContractType` pre-built a `PlutusMap` and exploited `serialize()`'s `instanceof PlutusData` short-circuit.

This change makes the schema honestly declare these fields as `TPlutusData` passthrough. The runtime path stays identical (the `createBeneficiariesMap` helper still pre-builds the `PlutusMap`), but the schema no longer claims a CBOR shape it doesn't actually produce, and the `as any` casts disappear from `ToContractType`.

Full schema-native support requires either extending `@blaze-cardano/data` to handle Constr-keyed Maps, OR retiring the schema serializer in favour of manual builders (the F7 decision).

**Touched files:**
- `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:79-114` — `beneficiaries` and `addedMembers` are now `TPlutusData`.
- `offchain/src/validators/Types/GovernanceAction.ts:222-238, 248-264` — removed `as any` casts; `ToContractType` returns the `createBeneficiariesMap` result directly.

**Validation:** gADA equivalence tests for TreasuryWithdrawal and ConstitutionalCommittee pass (bytes are byte-identical to pre-change).

**Commit shape:** `Type Pairs<Credential, V> fields as TPlutusData passthrough (F5, F6)`

---

## F7 — Encoder convergence: locked down by tests, decision deferred

**Status:** TRACKED — both encoder paths now produce byte-identical output across all 7 governance-action variants, verified by `gADA asset-name equivalence` test suite.

The audit recommended either (a) retiring the manual builders in favour of the schema, or (b) retiring `Cosponsor.gAda()` schema usage in favour of the manual builders. Both are viable now that they agree. **Decision deferred** to a later session — the byte-equality tests catch any drift, so we can take the time to choose intentionally.

---

## Change 7 — F12 + F13 + F16: Datum decoder helpers return `null` on failure and are now exported

**Status:** DONE & VERIFIED — 9 new tests under `datum-decoder.test.ts`.

`computeProposalHashFromDatum`, `extractActionKindFromDatum`, and `extractAnchorFromDatum` previously returned empty-string / placeholder sentinels (`""`, `"Unknown"`, `{ url: "", hash: "" }`) on every failure mode — making "decode threw", "After-state datum", and "real empty anchor" indistinguishable. Now each returns `null` on After-state datums and on parse/serialize failures. The empty-string sentinels were the exact ambiguity Bug 2 exploited.

Also exported from `browser/index.ts` so consumers don't have to import the legacy `fetchUserDeposits` for its side effects (AUDIT.md F16).

**Touched files:**
- `offchain/src/browser/fetchUserDeposits.ts:381-540` — helper bodies rewritten with explicit null returns and clearer log messages.
- `offchain/src/browser/index.ts:17-32` — exported the three decoder helpers + the `IScriptUtxo` type.
- `offchain/tests/datum-decoder.test.ts` — new file. 9 tests covering Before / After / malformed datums for each helper.

**Validation:** `bun test` → 29 pass / 0 fail.

**Commit shape:** `Surface decoder failures as null and export the decoder helpers (F12, F13, F16)`

---

## Change 8 — F12 sister: `IScriptUtxo` gains `decodingFailed` and `hasDatum` diagnostics

**Status:** DONE — covered by schema-probe tests (no regression) and new datum-decoder tests.

`IScriptUtxo` previously stored empty strings for `proposalHash` / `actionKind` / `anchor` when the datum couldn't be decoded, indistinguishable from "decoded successfully but the field is naturally empty". Added two diagnostic fields:
- `decodingFailed: boolean` — set when any of the three decoder helpers returned `null` for a UTxO that DID have an inline datum.
- `hasDatum: boolean` — distinguishes "no datum at all" from "datum present but couldn't decode".

The string fields stay (for backwards compat) but are now defensible: empty means "no information available, check the diagnostic flags".

**Touched files:**
- `offchain/src/browser/fetchUserDeposits.ts:522-555` — `IScriptUtxo` interface, expanded fields with documentation.
- `offchain/src/browser/fetchUserDeposits.ts:628-693` — `fetchWithdrawalPlan` iteration rewritten to set the diagnostic flags from the decoder helpers' null/non-null returns.

**Commit shape:** `Tag IScriptUtxo decode failures with diagnostic flags (F12 follow-up)`

---

## Change 9 — F8: Remove the lying amount-based fallback in legacy `fetchUserDeposits`

**Status:** DONE — was Bug 2 itself.

When `fetchUserDeposits` couldn't match a user's gADA token to a decoded script UTxO, it fell back to amount-based UTxO selection and stamped that UTxO's `anchor` / `actionKind` onto the user's deposit (`fetchUserDeposits.ts:808-838` pre-change). UI labeled distinct deposits as the same proposal. Removed.

`IUserDeposit` gains an `unmatched: boolean` field. Unmatched deposits surface with empty anchor data, `action.kind = "Unknown"`, and `unmatched: true` — UI is expected to render an "unknown proposal" state rather than guess.

**Touched files:**
- `offchain/src/browser/fetchUserDeposits.ts:777-810` — `IUserDeposit` interface, added `unmatched`.
- `offchain/src/browser/fetchUserDeposits.ts:838-895` — match-or-surface-as-unmatched, no more `selectUtxosForWithdrawal` fallback for identity.

**Validation:** No behavioural regression in the SDK path (the test suite passes). The cosponsor-ui has its own workaround for Bug 2 (canonical `urlIdByProposalHash` map in `proposalTotals.ts`) so removing the fallback doesn't break UI behaviour — and once the UI picks up the new `unmatched` flag we can simplify on that side too.

**Commit shape:** `Stop attaching unrelated anchors to unmatched user deposits (F8 / Bug 2)`

---

## Change 10 — F9 + F10 + F11: `parseCosponsorDatum` overhaul

**Status:** DONE & VERIFIED — 3 dedicated tests in `datum-decoder.test.ts`.

Three related issues in one helper:
- **F9** — `} catch { return null; }` swallowed every error with no logging. Replaced with a discriminated `ParseCosponsorDatumResult = { ok: true, value } | { ok: false, reason: 'parse-threw' | 'unexpected-shape', error? }`. Callers now choose their policy explicitly.
- **F10** — `action: cosponsoredProposal.procedure?.governanceAction || { kind: "Unknown" }` was wrong when the action *was* present, because parse() returns `{TreasuryWithdrawal: {...}}` or string `"NicePoll"` — neither has a `.kind`. Added `fromContractType(parsed): TGovernanceAction` in `validators/Types/GovernanceAction.ts` as the proper inverse of `ToContractType`, and routed parseCosponsorDatum through it.
- **F11** — `if (datum === "After" || "After" in datum)` was inside a `typeof datum === "object"` guard so the first half was unreachable. Lifted the `=== "After"` check above the guard.

**Touched files:**
- `offchain/src/validators/Types/GovernanceAction.ts:298-393` — new `fromContractType` function with documentation about the `Pairs<Credential, V>` placeholder caveat (callers re-serializing should use `rawCosponsoredProposal` directly).
- `offchain/src/helpers/parseCosponsorDatum.ts` — rewritten end to end with the discriminated result shape and reachability fix.
- `offchain/src/helpers/depositIndexer.ts:117-160` — updated caller to use `result.ok` / `result.value` pattern; also added the missing `CosponsorTypes` import (AUDIT.md F18) and renamed the misleading `proposalHash: anchor.hash` to `anchorContentHash` (AUDIT.md F19).
- `offchain/src/helpers/fetch-submissions.ts:186-218` — updated caller; `getProposalHash` no longer fabricates a synthetic key on failure (AUDIT.md F14 — fix below).
- `offchain/types/deposit.ts` — `DepositInfo` gained `anchorContentHash` and clearer doc-comments.

**Validation:** 12 datum-decoder tests cover the new behaviour. All 29 tests pass.

**Commit shape:** `Discriminated parse result, inverse fromContractType, reachable After branch (F9, F10, F11)`

---

## Change 11 — F14: `getProposalHash` throws instead of fabricating a hash

**Status:** DONE.

Pre-audit `getProposalHash` in `fetch-submissions.ts` returned `${proposal.deposit}_${proposal.anchor.hash.slice(0, 8)}` on failure — a synthetic string that collides across distinct proposals and is not a valid token-asset-name format. Removed; lets the error propagate. Callers in `fetch-submissions.ts` now catch the throw and store a sentinel that's clearly labelled `"uncomputed_<txid>"` (vs the old behaviour of looking like a real hash).

**Touched files:**
- `offchain/src/helpers/fetch-submissions.ts:99-115` — fallback deleted from helper.
- `offchain/src/helpers/fetch-submissions.ts:186-218` — caller catches and labels explicitly.

**Commit shape:** `Throw instead of fabricating a collidable proposal hash (F14)`

---

## Change 12 — F18 + F19: `depositIndexer.ts` fixes

**Status:** DONE.

`depositIndexer.ts:128` referenced `CosponsorTypes.CosponsoredProposalProcedure` but never imported `CosponsorTypes` — pure `ReferenceError` waiting to fire. Also stored the off-chain metadata anchor's content hash as `proposalHash`, silently breaking any caller using `proposalHash` as the gADA asset-name identifier.

Folded into the parseCosponsorDatum cascade above (Change 10) so the import + field rename land in the same commit as the type changes that justified them.

---

## Queued — broken scripts (F20, F21)

`scripts/withdrawal.ts` is full of undefined symbol references (`TGovernanceAction`, `CosponsorTypes`, `bulkWithdraw`, `multiTokenBulkWithdraw`, `withdraw`) and uses a `mockProposal` substitution on parse failure. The audit flagged this as "probably aspirational" — recommend **deletion** pending confirmation. Will tackle next or skip per your call.

---

## Change 13 — F17 + F22 + F23: API exports

**Status:** DONE & VERIFIED — 7 extra assertions in `gADA asset-name equivalence` cover the standalone helper.

- **F17** — `computeProposalAssetName(proposal, cosponsorScriptHash): string` added in `validators/Types/GovernanceAction.ts`. Independent of the `Cosponsor` class; uses the manual builders (byte-equivalent to the schema path per F7 tests).
- **F22** — New `browser/scriptAddress.ts` exposes `getCosponsorScriptAddress(network, hash?)` and `getStateScriptAddress(network, hash?)`. Hashes default to `BROWSER_CONFIG`. Three inlined copies in `fetchUserDeposits.ts`, `BrowserDeposit.ts`, `BrowserWithdrawal.ts` can switch to the helper in a follow-up.
- **F23** — `fromContractType` (added in Change 10) is now re-exported from `browser/index.ts`.

**Touched files:**
- `offchain/src/validators/Types/GovernanceAction.ts` — added `computeProposalAssetName`.
- `offchain/src/browser/scriptAddress.ts` — new file.
- `offchain/src/browser/index.ts` — re-exports `getCosponsorScriptAddress`, `getStateScriptAddress`, `computeProposalAssetName`, `fromContractType`.
- `offchain/tests/schema-probe.test.ts` — added `computeProposalAssetName` byte-equality assertions inside the gADA equivalence loop.

**Commit shape:** `Expose computeProposalAssetName, script-address helpers, fromContractType (F17, F22, F23)`

---

## Change 14 — F26: Script-ref hash verification on Kupo+Ogmios path

**Status:** DONE.

`BrowserDeposit.ts` previously only verified `script.hash() === cosponsorHash` on the Blockfrost fallback. The primary Kupo+Ogmios path used whatever `resolveScriptRef` returned without checking. Added the same verification (plus a "no script attached" guard) before attaching the reference input.

**Touched files:**
- `offchain/src/browser/BrowserDeposit.ts:66-95` — verify-then-use on the success branch.

**Commit shape:** `Verify script-ref hash on the Kupo+Ogmios deposit path (F26)`

---

## Queued — Hardening (F30, F24, F25, F15)

- F30 — hardcoded `gAdaPolicyId` in `scripts/withdrawal.ts` (deferred along with F20/F21).
- F24 — `BrowserWithdrawal` multi-proposal change-output mislabeling.
- F25 — `UnifiedWithdrawal` proposal grouping by `${kind}-${url}` instead of the gADA hash.
- F15 — Split `fetchWithdrawalPlan` into wallet-less / wallet-bound halves.

---

## Queued — Wallet split (F15)

Split `fetchWithdrawalPlan` into a wallet-less `fetchScriptUtxos(provider)` and a wallet-bound `fetchUserGadaTokens(wallet, policyId)`; recompose. Enables the cosponsor-ui to drop its read-only stub-Blaze workaround.

---

## Queued — Dependency pinning (F23b)

Exact pins for `@blaze-cardano/*`. Document tested versions in README.

---

## Queued — Cosmetic (F27, F28)

Rename `guardRails` → `guardrails`, reorder `OutputReference` TS interface to match schema.

