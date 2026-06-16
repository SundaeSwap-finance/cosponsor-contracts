# Cosponsor SDK — Correctness Audit (2026-05-23)

Tracking document for a multi-pass SDK audit triggered by two field bugs:

- **Bug 1** — `NewConstitution.constitution` schema in `CosponsorTypes.ts` was missing `{ ctor: 0n }`, throwing `Enum variant must have a constructor index` on serialize/parse and breaking every flow that touched a NewConstitution datum.
- **Bug 2** — When `fetchUserDeposits` / `fetchWithdrawalPlan` couldn't decode a script UTxO's datum (Bug 1 was a trigger), the code fell back to amount-based UTxO selection and stamped that UTxO's `anchor` / `actionKind` onto the user's deposit. The UI then labeled distinct deposits as the same proposal.

Audit method: **3 full-scope independent audit passes + 2 independent cross-check verifications**, run against `offchain/src/` HEAD. 28 of 30 numbered claims confirmed by both verifiers. One claim partially refuted on its specific mechanism but the underlying data-quality concern was confirmed. One claim outright refuted.

The audit established that the dominant problem is **a single root cause expressed in many places**: `CosponsorTypes.ts` was generated without correctly encoding Aiken's `Pairs<K,V>` (CBOR Map), opaque types (no Constr wrapper), and single-Constr record fields. The off-chain stack works around this inconsistently — some sites bypass the schema with manual `buildXAsPlutusData` builders, others walk through `serialize(CosponsorTypes.X, …)` and hit either runtime throws or silently-wrong CBOR. Today the system is effectively only viable for `NicePoll`-shaped proposals.

---

## How to read this document

- Each finding has a stable ID (`F1`–`F30`, plus the two meta findings `F22b`/`F23b`).
- Severity reflects the worst observable impact, not the most pessimistic theoretical risk.
- Status tracks remediation: `OPEN` → `IN PROGRESS` → `FIXED` → `VERIFIED` (test added, regression-proof).
- "Verified by both" means both cross-check agents independently confirmed the claim against the actual code; reproduce locally before believing.

---

## Progress at a glance

Last update: 2026-05-26. Test status: `bun test` → 29 pass / 0 fail / 49 expect() calls across 2 files.

| Status                                                                | Count | Findings                                                                                        |
| --------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| FIXED & VERIFIED (tests prove correctness)                            | 11    | F1, F2, F3, F4, F9, F10, F11, F12, F13, F17, F22b (partial — test infra in, more tests welcome) |
| FIXED (no regression, dedicated test optional)                        | 7     | F8, F14, F16, F18, F19, F22, F23, F26                                                           |
| PARTIAL (cleaned up but the deeper fix is gated on F7)                | 2     | F5, F6                                                                                          |
| TRACKED & GREEN (byte-equality lock by tests; arch decision deferred) | 1     | F7                                                                                              |
| OPEN                                                                  | 9     | F15, F20, F21, F23b, F24, F25, F27, F28, F30                                                    |
| WONTFIX (refuted by verifier)                                         | 1     | F29                                                                                             |

**Open priorities (suggested order):**

1. **F15** — Split `fetchWithdrawalPlan` so the script-side scan doesn't require a wallet. Unblocks the cosponsor-ui's read-only-Blaze workaround.
2. **F24** — `BrowserWithdrawal` multi-proposal change output uses only the first UTxO's datum (bookkeeping ambiguity).
3. **F25** — `UnifiedWithdrawal` groups proposals by `${kind}-${anchor.url}` instead of the gADA hash.
4. **F23b** — Pin `@blaze-cardano/*` exact versions to stop minor-bump drift from re-introducing F1-family issues.
5. **F20 / F21 / F30** — `scripts/withdrawal.ts` rewrite or delete (likely delete; the file has so many undefined references it's clearly aspirational and never worked end-to-end).
6. **F27 / F28** — Cosmetic; fold into a sweep commit.

---

## CRITICAL — schema / encoder family (F1–F7)

These should be fixed together. They are the same root cause expressed across five governance-action variants, plus the dual-encoder architecture that lets the bug hide in some paths.

### F1 — `ProtocolParameters.newParameters` has no `ctor` on either Object

- **Status:** FIXED & VERIFIED (Change 5)
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:50-54`
- **What:** `newParameters: Type.Object({ ProtocolParametersUpdate: Type.Object({ inner: Type.Array(...) }) })` — neither outer nor inner has `ctor`. Calling `serialize()` on any datum containing a `ProtocolParameters` governance action throws `Enum variant must have a constructor index` from `extractCtor` in `@blaze-cardano/data/dist/index.mjs`.
- **Impact:** `computeProposalHashFromDatum` / `parseCosponsorDatum` / every code path that round-trips through `parse(CosponsorDatum, ...)` and re-serializes throws on this variant. Triggers Bug 2's silent fallback. **Throws today** — verified by both.
- **Fix:** See F2 (the structural problem is deeper than just adding a ctor).

### F2 — `ProtocolParametersUpdate` is opaque in Aiken; schema's nested wrapper has no on-chain counterpart

- **Status:** FIXED & VERIFIED (Change 5)
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:50-54`
- **What:** Aiken `pub opaque type ProtocolParametersUpdate { inner: Pairs<Int, Data> }` (per `build/packages/aiken-lang-stdlib/lib/cardano/governance/protocol_parameters.ak:4-6`) — opaque types erase the Constr wrapper; on-chain CBOR is a bare Map. The schema's two-level wrapper `{ProtocolParametersUpdate: {inner: [...]}}` produces extra Constr layers that don't exist on-chain, even after fixing ctors. The manual builder at `GovernanceAction.ts:671` already gets this right with a bare `PlutusMap`.
- **Impact:** Even if F1's ctor is added, schema serialize would still produce CBOR that doesn't hash to the on-chain proposal hash. Schema-side and manual-builder side produce different bytes.
- **Fix:** Replace with `newParameters: Type.Map(Type.BigInt(), TPlutusData)` (or whatever the data-lib's "bare Map" type alias is) — no wrapper layers.

### F3 — `HardFork.newVersion.ProtocolVersion` inner Object lacks ctor; outer wrapper is structurally extra

- **Status:** FIXED & VERIFIED (Change 4)
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:64-72`
- **What:** Outer `newVersion` has `{ ctor: 0n }`, but inner `ProtocolVersion: Type.Object({ major, minor })` has no `ctor`. Aiken `ProtocolVersion { major, minor }` (per `governance.ak:91-94`) is a plain record encoded as `Constr(0, [major, minor])` — one Constr layer. The schema's `{ProtocolVersion: {…}}` wrapper would add a second layer that doesn't exist on-chain (and the missing inner ctor would throw before we get that far).
- **Impact:** **Throws today** for any HardFork datum (`extractCtor` fails on the inner ProtocolVersion).
- **Fix:** Collapse the wrapper:
  ```ts
  newVersion: Type.Object(
    { major: Type.BigInt(), minor: Type.BigInt() },
    { ctor: 0n },
  ),
  ```
  Update `ToContractType` (`GovernanceAction.ts:212-221`) to remove the `{ProtocolVersion: …}` indirection.

### F4 — `NewConstitution.constitution` partial fix landed; inner Object still lacks ctor; extra Constr layer

- **Status:** FIXED & VERIFIED (Change 3)
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:118-125`
- **What:** Recent fix added `{ ctor: 0n }` to outer `{ Constitution: ... }` wrapper. Inner `Constitution: Type.Object({ guardRails: Type.Optional(Type.String()) })` still lacks `ctor`. Aiken `Constitution { guardrails }` (per `governance.ak:97`) encodes as `Constr(0, [opt_guardrails])` — one Constr layer. The manual builder at `GovernanceAction.ts:546-550` confirms one-layer shape.
- **Impact:** Round-trip will still throw at the inner level, OR (if ctor were added) produce an extra Constr layer that doesn't match the manual builder's bytes — same family as F3.
- **Fix:** Mirror the manual builder by collapsing the wrapper:
  ```ts
  constitution: Type.Object(
    { guardRails: Type.Optional(Type.String()) },
    { ctor: 0n },
  ),
  ```
  Update `ToContractType` accordingly. (See F27 for the cosmetic `guardRails`/`guardrails` rename.)

### F5 — `TreasuryWithdrawal.beneficiaries` is `Array(Tuple)` but Aiken `Pairs<K,V>` is a CBOR Map

- **Status:** PARTIAL — schema is now honest (`TPlutusData` passthrough); bytes unchanged via existing `createBeneficiariesMap` workaround (Change 6). Schema-native `Pairs<Credential, V>` support requires extending `@blaze-cardano/data` OR the F7 architectural decision.
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:80-82`
- **What:** `beneficiaries: Type.Array(Type.Tuple([Credential, BigInt]))` produces a CBOR List of Constr-tuples. Aiken `Pairs<Credential, Lovelace>` (per `governance.ak:42`) is a CBOR Map. The repo already knows: the comment at `GovernanceAction.ts:115-126` ("CRITICAL: Aiken's Pairs<k,v> is encoded as a CBOR Map, NOT a list of tuples!") describes the workaround — `ToContractType` pre-builds a `PlutusMap` and passes it through `serialize()` via the `instanceof PlutusData` short-circuit. The schema itself remains wrong.
- **Impact:** Silently masked at runtime by the manual workaround **for TW**. But any caller passing a raw JS array (the schema's declared shape) gets wrong bytes. `parse()` on a real on-chain TW datum cannot decode a CBOR Map into `Array(Tuple)` — throws or silently truncates → Bug 2 fallback.
- **Fix:** Replace with `Type.Map(Type.Ref("Credential"), Type.BigInt())` (or `Type.Record(...)` — verify against `@blaze-cardano/data`'s Map-supporting type). Delete the `createBeneficiariesMap` workaround in `GovernanceAction.ts:228-234`.

### F6 — `ConstitutionalCommittee.addedMembers` — same Array/Tuple vs Pairs/Map mistake

- **Status:** PARTIAL — same treatment as F5 (Change 6).
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:101-103`
- **What:** Identical to F5 but for `addedMembers: Pairs<Credential, Mandate>` (Mandate = Int per `governance.ak:61`). Manual builder at `GovernanceAction.ts:736-750` uses `PlutusMap` correctly.
- **Impact:** Same as F5, scoped to ConstitutionalCommittee.
- **Fix:** Same — `Type.Map(Type.Ref("Credential"), Type.BigInt())`.

### F7 — Dual encoder paths (`Cosponsor.gAda()` schema-walk vs `buildXAsPlutusData` manual) produce different bytes

- **Status:** TRACKED & GREEN — both paths now produce byte-identical output for all 7 governance-action variants, locked down by `gADA asset-name equivalence` test suite. The architectural "retire one path" decision is deferred; the byte-equality tests catch any drift.
- **Files:** `offchain/src/validators/Cosponsor.ts:41-50` (`gAda()`), `offchain/src/transactions/Deposit.ts:82,199-205` vs `offchain/src/browser/BrowserDeposit.ts:165-189`
- **What:** Two mint paths exist in the SDK:
  - **Node SDK** (`Deposit.ts`) uses `cosponsor.gAda()` → `serialize(CosponsorTypes.CosponsoredProposalProcedure, ...).hash()` (schema-walk).
  - **Browser SDK** (`BrowserDeposit.ts`) uses `buildCosponsoredProposalProcedureAsPlutusData(...).hash()` (manual raw PlutusData).

  Failure modes by variant:
  - **HardFork / ProtocolParameters / NewConstitution:** Schema-walk throws at `extractCtor` (F1, F3, F4). Manual-builder works.
  - **TreasuryWithdrawal / ConstitutionalCommittee:** Schema-walk _appears_ to work because `ToContractType` pre-builds the `Pairs`-typed fields as `PlutusMap`s and `serialize()`'s `instanceof PlutusData` short-circuit forwards them unchanged. But any caller bypassing `ToContractType` gets wrong bytes.
  - **NicePoll / NoConfidence:** Bytes happen to coincide between the two paths.

- **Impact:** A deposit minted server-side (Node SDK) cannot be looked up later by browser code (and vice versa) for HardFork/PP/NewConstitution because they hash to different asset names. Even today's tests passing for TW/CC is accidental.
- **Fix:** Pick one canonical encoder. Recommended: make the schema correct (F1–F6) so it matches Aiken, then retire the manual `buildXAsPlutusData` builders OR delete `Cosponsor.gAda()`'s schema use in favor of the builders. Shipping both encoders is the permanent footgun.

---

## HIGH — silent fallback / error-swallowing (F8–F14)

These produce plausible-but-wrong data that downstream code treats as authoritative.

### F8 — Bug 2: `fetchUserDeposits` falls back to amount-based selection and attaches an unrelated UTxO's anchor

- **Status:** FIXED (Change 9). Fallback removed; unmatched user tokens surface as `IUserDeposit { unmatched: true, anchor: { url: "", hash: "" }, action: { kind: "Unknown" }, ... }`.
- **File:** `offchain/src/browser/fetchUserDeposits.ts:808-838`
- **What:** When `utxoByProposalHash.get(token.tokenAssetName)` returns undefined, the code calls `selectUtxosForWithdrawal(plan.scriptUtxos, token.tokenAmount)` and stamps `firstUtxo.anchor` / `firstUtxo.actionKind` onto the user's distinct deposit.
- **Impact:** UI mislabels distinct deposits as the same proposal. The amount heuristic is a coincidence detector, not a correctness invariant.
- **Fix:** Remove the fallback. If no hash match, return the deposit with `anchor: { url: "", hash: "" }`, `actionKind: "Unknown"`, and a `decodingFailed: true` flag so the UI can render that as an error state rather than a confident wrong label.

### F9 — `parseCosponsorDatum` swallows every error and returns `null`

- **Status:** FIXED & VERIFIED (Change 10). Returns discriminated `{ ok: true, value } | { ok: false, reason, error? }`.
- **File:** `offchain/src/helpers/parseCosponsorDatum.ts:67-69`
- **What:** `} catch { return null; }` — no logging, no error context. Callers cannot tell "absent" from "schema bug".
- **Impact:** A schema regression in `CosponsorTypes` would silently misclassify every UTxO as "no datum", with no signal in logs.
- **Fix:** Throw with context OR return a discriminated `{ ok: true, value } | { ok: false, reason, error }`. Add a single warn-level log when parsing fails on a datum that _was_ present.

### F10 — `parseCosponsorDatum` returns a malformed `proposal.action` cast as `TGovernanceAction`

- **Status:** FIXED & VERIFIED (Change 10). Added `fromContractType` inverse helper in `validators/Types/GovernanceAction.ts`; `parseCosponsorDatum` routes through it.
- **File:** `offchain/src/helpers/parseCosponsorDatum.ts:41-43`
- **What:** `action: cosponsoredProposal.procedure?.governanceAction || { kind: "Unknown" } as TGovernanceAction`. When parsing succeeds, `governanceAction` is the schema's union shape (e.g., `{TreasuryWithdrawal: {...}}` or the literal string `"NicePoll"`) — **neither has a `.kind` field**. Even the "good" NicePoll case produces a bare string, not the expected `{kind: "NicePoll"}` shape.
- **Impact:** Callers reading `.action.kind` get `undefined`. Callers passing this back through `Cosponsor.new(...)` trip `ToContractType`'s `switch (ga.kind)` default and throw `Unknown governance action kind: undefined`.
- **Fix:** Write a real inverse `fromContractType(parsed): TGovernanceAction` that maps `{TreasuryWithdrawal: {...}}` → `{kind: "TreasuryWithdrawal", beneficiaries: ..., guardRails: ...}` and bare strings → `{kind: <string>}`. Export it from the public surface (see F17).

### F11 — `parseCosponsorDatum` has an unreachable `"After"` string check

- **Status:** FIXED & VERIFIED (Change 10). After check moved above the `typeof === "object"` guard.
- **File:** `offchain/src/helpers/parseCosponsorDatum.ts:30, 54`
- **What:** `if (datum && typeof datum === "object")` at line 30 narrows `datum` to an object. Inside that block, line 54's `if (datum === "After" || "After" in datum)` has an unreachable first half. The `"After" in datum` half is also dubious because the schema returns the literal string `"After"`, not an object.
- **Impact:** `After`-state datums slip through and `parseCosponsorDatum` returns `null` for them. Note this is local to this file; `fetchUserDeposits.ts:399-402` orders the check correctly.
- **Fix:** Lift the `datum === "After"` check above the `typeof === "object"` guard.

### F12 — `computeProposalHashFromDatum` returns `""` on error

- **Status:** FIXED & VERIFIED (Change 7). Returns `null` on After-state and on failure. `IScriptUtxo` also gains `decodingFailed` + `hasDatum` diagnostic flags (Change 8).
- **File:** `offchain/src/browser/fetchUserDeposits.ts:433-436`
- **What:** `catch (error) { logger.warn(...); return ""; }`. Empty string then flows into `IScriptUtxo.proposalHash`.
- **Impact:** The `if (utxo.proposalHash)` guard at line 755-757 prevents the empty string from entering the Map (so no Map-key _collision_), but the empty string still propagates downstream in the `IScriptUtxo` array and the fallback path picks it as the "first UTxO" candidate for F8.
- **Fix:** Return `null` on failure, skip the map-insert, and tag the UTxO as `decodingFailed: true` so the fallback path refuses to use it as an anchor source.

### F13 — `extractAnchorFromDatum` returns `{url:"", hash:""}` on error

- **Status:** FIXED & VERIFIED (Change 7). Returns `null` on After-state and on failure.
- **File:** `offchain/src/browser/fetchUserDeposits.ts:486-513`
- **What:** Both the shape-mismatch branch and the catch branch return `{ url: "", hash: "" }` — indistinguishable from a real empty anchor.
- **Fix:** Return `null` on failure and surface that to `IScriptUtxo` as `anchor: { url, hash } | null`. UI should special-case null.

### F14 — `getProposalHash` falls back to a synthetic collidable hash

- **Status:** FIXED (Change 11). Throws on failure; caller in `fetch-submissions.ts` catches and labels explicitly as `uncomputed_<txid>`.
- **File:** `offchain/src/helpers/fetch-submissions.ts:99-118`
- **What:** On failure, returns `` `${proposal.deposit}_${proposal.anchor.hash.slice(0, 8)}` ``. Two proposals with same deposit + same first 8 chars of anchor.hash collide. Not a valid token-asset-name format either.
- **Fix:** Throw. Don't manufacture a fake hash to satisfy a return type.

---

## HIGH — runtime-broken shipped scripts (F18–F21)

These would have been caught by any test that exercised them. They are not on the published-SDK consumer path, but they're shipped as `bun run …` scripts in `package.json`.

### F18 — `depositIndexer.ts` references `CosponsorTypes` without importing it

- **Status:** FIXED (Change 10/12). Added `import { CosponsorTypes } from "@validators/GeneratedTypes";`.
- **File:** `offchain/src/helpers/depositIndexer.ts:128`
- **What:** Uses `CosponsorTypes.CosponsoredProposalProcedure` but no `import { CosponsorTypes } …` in the file.
- **Impact:** `ReferenceError: CosponsorTypes is not defined` on the first script UTxO with a parseable datum. The npm script `index-deposits` (`package.json:84`) crashes immediately.
- **Fix:** Add `import { CosponsorTypes } from "@validators/index"` (verify path alias).

### F19 — `depositIndexer.ts` mislabels `proposalHash` as the anchor's content hash

- **Status:** FIXED (Change 10/12). Renamed misleading field to `anchorContentHash`; the real proposal-procedure hash now stored in `proposalHash`. `DepositInfo` type updated.
- **File:** `offchain/src/helpers/depositIndexer.ts:137-146`
- **What:** Pushes `proposalHash: parsedResult.proposal.anchor.hash` — that's the off-chain metadata anchor's content hash (SHA-256 of metadata JSON per CIP-100/108), not the blake2b-256 of the serialized `CosponsoredProposalProcedure` (which is what the gADA token asset name actually equals). The real value is computed locally as `expectedTokenAssetName` and stored under `tokenAssetName`.
- **Impact:** Any caller indexing by `proposalHash` sorts by metadata-hash, not asset-name-hash. The two are SHAs of completely different inputs.
- **Fix:** Rename the misleading field to `anchorContentHash`, add a separate `proposalHash: expectedTokenAssetName`.

### F20 — `scripts/withdrawal.ts` references many undefined symbols

- **Status:** OPEN (consider deletion)
- **File:** `offchain/src/scripts/withdrawal.ts:48, 282, 510, 524, 723, 744, 887, 944`
- **What:** References `TGovernanceAction`, `CosponsorTypes`, `bulkWithdraw`, `multiTokenBulkWithdraw`, `withdraw` without top-level imports. One site has a dynamic `await import("@validators/GeneratedTypes")` (lines 98-100), masking the issue locally, but most don't.
- **Impact:** Anyone running `bun run withdrawal` gets `ReferenceError` at the first uncaught call.
- **Fix:** Either (a) delete this file (probably aspirational / never-completed) or (b) fully fix imports and remove the `mockProposal` patterns (F21).

### F21 — `scripts/withdrawal.ts` substitutes a `mockProposal` on parse failure and proceeds

- **Status:** OPEN
- **File:** `offchain/src/scripts/withdrawal.ts:40-49, 130-153`
- **What:** On datum parse failure, the script falls back to a module-level `mockProposal: ICosponsoredProposal` (NicePoll, fake anchor) and continues into `withdraw(...)`. Submission will fail, but only after misleading "✓ extracted" / "using mock proposal" log noise.
- **Fix:** Abort with an explicit error. Never substitute fake proposal data into a real submission path.

---

## HIGH — API surface gaps (F16, F17, F22, F23)

### F16 — `computeProposalHashFromDatum`, `extractActionKindFromDatum`, `extractAnchorFromDatum` not exported

- **Status:** FIXED (Change 7). All three exported from `browser/index.ts`.
- **Files:** `offchain/src/browser/fetchUserDeposits.ts:388, 442, 486` (defined, private)
- **What:** All are module-private `const`s; not in `offchain/src/browser/index.ts`. UI consumers are forced to either re-implement CBOR parsing or import the legacy `fetchUserDeposits` for its side effects.
- **Fix:** Export from `fetchUserDeposits.ts` and re-export from `browser/index.ts`.

### F17 — No standalone `computeProposalAssetName(proposal)` helper

- **Status:** FIXED & VERIFIED (Change 13). Added to `validators/Types/GovernanceAction.ts`, re-exported from `browser/index.ts`. Tests assert byte equality with the existing `gADA()` and manual-builder paths.
- **What:** To get a gADA asset name from a JS-side proposal, consumers must instantiate `Cosponsor.new({statePolicyId, cosponsoredProposal}).gAda()`. The asset name depends only on the cosponsored proposal, not on the script parameterization — but the API forces both.
- **Fix:** Export `computeProposalAssetName(proposal: ICosponsoredProposal): string` as a free function. Internally use the manual builders (until F7 is resolved).

### F22 — No exported `cosponsorScriptAddress(network)` helper

- **Status:** FIXED (Change 13). Added `getCosponsorScriptAddress(network, hash?)` and `getStateScriptAddress(network, hash?)` in `browser/scriptAddress.ts`. Default args use `BROWSER_CONFIG`. The three inlined copies in `fetchUserDeposits.ts`, `BrowserDeposit.ts`, `BrowserWithdrawal.ts` can be replaced in a follow-up.
- **What:** The browser bundle has to inline the same `addressFromCredential(network, Credential.fromCore({hash, type: ScriptHash}))` derivation in three places: `fetchUserDeposits.ts:566-572`, `BrowserDeposit.ts:286-292`, `BrowserWithdrawal.ts:284-290`.
- **Fix:** Export `getCosponsorScriptAddress(network, hash): Core.Address` and `getStateScriptAddress(network)`. Use throughout.

### F23 — No inverse `fromContractType(parsed): TGovernanceAction`

- **Status:** FIXED (Change 10 + 13). Added in `validators/Types/GovernanceAction.ts` and re-exported from `browser/index.ts`.
- **What:** SDK has `ToContractType` (UI-shape → contract-shape) but no inverse. Every consumer hand-rolls the conversion incorrectly (the trigger for F10).
- **Fix:** Add the inverse and export it.

---

## MEDIUM (F15, F24, F25, F26, F30)

### F15 — `fetchWithdrawalPlan` requires `Wallet` for the script-side scan

- **Status:** OPEN
- **File:** `offchain/src/browser/fetchUserDeposits.ts:558-559`
- **What:** Signature `Blaze<Provider, Wallet>` but the wallet is used only at line 576 (`blaze.wallet.getUnspentOutputs()`) for user-token enumeration. Script-side scan at line 618 only needs `provider`.
- **Impact:** UIs that want a "browse proposals" or public dashboard cannot do so without a connected wallet. The cosponsor-ui already works around this with a stub-wallet read-only Blaze instance.
- **Fix:** Split into `fetchScriptUtxos(provider)` and `fetchUserGadaTokens(wallet, policyId)`. Compose them inside `fetchWithdrawalPlan`.

### F24 — `BrowserWithdrawal` multi-proposal change output uses only the first UTxO's datum

- **Status:** OPEN
- **File:** `offchain/src/browser/BrowserWithdrawal.ts:152-156, 293-305`
- **What:** `selectUtxosForWithdrawal` selects biggest-first across ALL script UTxOs (no proposal grouping). The single change output reuses `selectedUtxos[0].utxo.output().datum()`. If A+B+C UTxOs are combined, the change UTxO is labeled as A. The comment "they all have the same proposal key" is unfounded.
- **Impact:** Bookkeeping ambiguity that prevents per-proposal accounting from working.
- **Fix:** Either return one excess output per proposal group (each with its own datum), or only allow withdrawing UTxOs that share one proposal and validate in code.

### F25 — `UnifiedWithdrawal` groups proposals by `${kind}-${anchor.url}` string

- **Status:** OPEN
- **File:** `offchain/src/transactions/UnifiedWithdrawal.ts:84`
- **What:** `const proposalKey = \`${deposit.cosponsoredProposal.action.kind}-${deposit.cosponsoredProposal.anchor.url}\`;`. Two distinct proposals sharing kind + anchor URL collide. Plausible when many proposals point at identical IPFS/HTTP URLs for templates.
- **Fix:** Key by the `proposal_procedure_hash` (the actual on-chain token asset name).

### F26 — Browser deposit script-ref hash verification only on the Blockfrost fallback path

- **Status:** FIXED (Change 14). Kupo+Ogmios primary path now verifies `cosponsorReference.output().scriptRef()?.hash() === cosponsorHash` and throws with a clear "config out of sync" message on mismatch.
- **File:** `offchain/src/browser/BrowserDeposit.ts:60-99`
- **What:** Kupo+Ogmios primary path calls `blaze.provider.resolveScriptRef(...)` and skips ahead with no hash verification. Blockfrost fallback verifies `script.hash() === cosponsorHash` and throws on mismatch.
- **Impact:** Stale script-reference UTxO (e.g., redeployed but config not updated) produces a tx that references the wrong script — fails opaquely on-chain.
- **Fix:** After `resolveScriptRef` in the primary path, also verify `cosponsorReference.output().scriptRef()?.hash() === cosponsorHash`.

### F30 — Hardcoded `gAdaPolicyId` in `scripts/withdrawal.ts`

- **Status:** OPEN
- **File:** `offchain/src/scripts/withdrawal.ts:386-387`
- **What:** `const gAdaPolicyId = "87264e48...";` inside `createWithdrawalSpecification`. If the script is redeployed (any parameter changes), this silently scans for tokens that don't exist and reports zero balance.
- **Fix:** Derive from `cosponsor.script().hash()` like the rest of the file does.

---

## CRITICAL — meta

### F22b — Zero off-chain tests

- **Status:** PARTIAL (Change 1). `bun test` scaffolding in; 29 tests covering schema/builder equivalence (per governance-action variant), the gADA asset-name invariant, and the new decoder/parse failure paths. Round-trip `parse(serialize(x)) === x` tests for non-action types and golden-fixture tests against real on-chain CBOR are still missing.
- **File:** `offchain/package.json:71`
- **What:** `"test": "echo \"Error: no test specified\" && exit 1"`. No `*.test.ts` / `*.spec.ts` files anywhere in `offchain/src/`. The Aiken validators have property-based tests in `validators/tests/*.ak`; the off-chain TypeScript SDK has none.
- **Impact:** Every Category 1 and 2 finding is detectable with a 5-line round-trip test. Both bugs that motivated this audit would have been caught in CI. Without tests, every fix from this audit is one Blaze minor bump away from regressing.
- **Fix:** Add a minimum-viable test suite:
  - Per governance-action variant: round-trip CBOR equality between the schema serializer and the manual builder.
  - `parse(serialize(x)) === x` for every type in `CosponsorTypes` (Datum, Procedure, every variant of `GovernanceAction`, redeemers).
  - Golden-fixture tests against known on-chain UTxO CBOR for at least one mainnet/preview deposit per variant.
  - Use `bun test` (no extra dependency — already a devDep).

### F23b — Wide caret ranges on pre-1.0 Blaze packages

- **Status:** OPEN
- **File:** `offchain/package.json:99-103`
- **What:** `@blaze-cardano/core: ^0.7.0`, `@blaze-cardano/data: ^0.6.4`, `@blaze-cardano/sdk: ^0.2.43`, `@blaze-cardano/uplc: ^0.3.2`. Caret allows any `0.x.*` patch but in pre-1.0 these regularly break each other. The cosponsor-ui repo has had to add npm overrides to dedupe transitive copies (commits `f241097`, `1010799`).
- **Impact:** Bug 1 itself materialized only when `@blaze-cardano/data` was bumped. Any of F1–F6 could become a hard crash on the next bump.
- **Fix:** Pin to exact versions (drop `^`) and document tested versions in README. Add a CI step that re-runs the full test suite on every dependency update.

---

## LOW / cosmetic (F27, F28) and REFUTED (F29)

### F27 — `guardRails` (capital R) vs Aiken `guardrails` (lowercase) — cosmetic

- **Status:** OPEN — fix when touching the NewConstitution schema for F4.
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:121`, `validators/Types/GovernanceAction.ts:235, 280`.
- **Note:** CBOR is positional — the TS field name is irrelevant to encoding. Cosmetic only.

### F28 — `OutputReference` TS interface field order doesn't match the schema — cosmetic

- **Status:** OPEN
- **File:** `offchain/src/validators/GeneratedTypes/CosponsorTypes.ts:12`
- **Note:** Schema-defined `properties` ordering drives CBOR. The exported TS type just `output_index` first — confusing for callers constructing object literals, but harmless to encoding.

### F29 — `chunkCip25Text` cannot infinite-loop — REFUTED

- **Status:** WONTFIX
- **File:** `offchain/src/browser/metadataUtils.ts:14-32`
- **Verifier note:** UTF-8 caps any single char at 4 bytes, so `shrink ≤ 3` per iteration (the loop only shrinks until the byte length fits in 64). Net advance per outer iteration is ≥ 61 characters even in degenerate cases. The pattern is unusual but safe.

---

## Fix order (sensible, regression-aware)

Lock down current behavior with tests **before** changing code, so regressions are caught immediately. Each schema fix gets its own commit, gated by its own test.

1. **Test infrastructure** (F22b kickoff): add `bun test` config, write the round-trip + golden-fixture skeleton. **Some tests will fail today** — that's the point; they encode the spec.
2. **Schema fixes one variant at a time** (F1–F6): each commit fixes one variant + its test passes. Update `ToContractType` to match the new schema shape per variant. Verify nothing else regresses.
3. **Encoder convergence** (F7): once schemas match Aiken, retire the manual `buildXAsPlutusData` builders OR delete `Cosponsor.gAda()`'s schema use. Add a test asserting byte equality between Node and browser mint paths.
4. **Kill silent fallbacks** (F8, F9, F10, F12, F13, F14): each gets a discriminated-result return type. Update UI-facing callers in cosponsor-ui in the next session.
5. **Fix broken scripts** (F18, F19, F20, F21) — fix imports, drop the `mockProposal` fallback in withdrawal.ts.
6. **API surface** (F16, F17, F22, F23): export the helpers consumers need.
7. **Multi-proposal withdrawal correctness** (F24, F25): per-proposal change outputs + hash-based grouping key.
8. **Wallet-less script scan** (F15): split `fetchScriptUtxos` from the user-token side.
9. **Hardening** (F26, F30, F11): missing script-hash check, hardcoded policy id, unreachable check.
10. **Pin Blaze versions** (F23b): exact pins on `@blaze-cardano/*`.
11. **Cosmetic cleanup** (F27, F28).

## Audit method (for reproducibility)

- Pass 1, 2, 3 — three independent general-purpose agents, identical full-scope prompt, no agent-to-agent communication. Each walked `offchain/src/` + relevant Aiken (`lib/`, `validators/`, `build/packages/`) and produced its own findings.
- Cross-check A, B — two independent verifier agents took the consolidated 30-claim list and verified each against the actual code, returning CONFIRMED / REFUTED / PARTIALLY CONFIRMED / CANNOT VERIFY with quoted line evidence.
- Consensus: 28 confirmed by both; F12 partially confirmed (data-quality issue real, specific Map-collision mechanism doesn't apply because of a guard); F29 refuted.

This document and the test suite that goes with it become the regression baseline for any future SDK work.
