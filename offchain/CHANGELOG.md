# Changelog

## 0.0.2

Pre-publish audit pass. Highlights below are grouped by what a consumer
(e.g. cosponsor-ui) needs to know.

### Consumer-visible / behavioral

- **Withdrawals are SDK-only now (C2).** The broken `src/scripts/withdrawal.ts`
  dev script — which referenced builders (`bulkWithdraw`/`multiTokenBulkWithdraw`)
  that no longer exist — was **deleted**, along with the `withdrawal` /
  `withdraw-all` entries in `package.json` scripts. Use the exported
  `withdraw({ blaze, deposits })`, which already handles single, same-proposal
  bulk, and multi-proposal bulk in one call.
- **`INewConstitution` realigned to the on-chain type (H2).** The on-chain
  `Constitution` carries only `guardrails: Option<ScriptHash>` (no document
  anchor), so:
  - Added `INewConstitution.guardrails?: string` (the real on-chain field; was
    hardcoded `None` and unsettable).
  - `constitutionHash` / `constitutionUrl` are now **optional** (were required)
    and **`@deprecated`** — they have no on-chain slot and were always ignored
    by the builder. **Not a breaking change:** the `None`-guardrails encoding is
    byte-identical to before, so existing NewConstitution proposals keep the
    **same gADA token hash**. Code that sets/reads these fields still compiles
    (`@deprecated` is a hint, not an error).
- **Fail-fast guards added:**
  - Browser withdrawal now verifies the provider-resolved script hash (H4) — it
    previously skipped the check the deposit path had (AUDIT F26). Throws early
    on a stale `BROWSER_CONFIG` instead of an opaque on-chain rejection.
  - Importing `@sundaeswap/cosponsor-sdk/browser` now self-checks that the
    pre-computed script CBOR matches its recorded hash (H9), throwing fast if the
    blob is stale.
- **`fetchAllSubmissions` (Node dev helper) (C1):** undecodable UTxOs are now
  surfaced as `malformed` and skipped, instead of grouped under a fabricated
  `unknown_*` proposal.

### Added

- New subpath exports: `./logger` and `./Config`
  (`import { logger } from "@sundaeswap/cosponsor-sdk/logger"`).
- `PENDING_TTL_MS` + a tunable `pendingUtxoTracker.ttlMs` (default 10 min); the
  tracker now self-expires stale entries (H7).
- `verifyCosponsorScriptCbor()` (H9), shared `resolveCosponsorScriptReference()`
  (H4), and `chunkUtf8` / `chunkCip25Text` in `utils/cip25` (H10).

### Fixed

- Correct gADA hash for TreasuryWithdrawal / ConstitutionalCommittee proposals
  in the submissions helper — was computed via a lossy rebuild (H1).
- Unified the three divergent inline-datum checks behind `extractInlineDatum`;
  the browser path no longer coerces a hash-only datum into PlutusData (H3).
- `BrowserConfig` protocol constants are single-sourced from `Config.ts`, so a
  redeploy can't leave the browser config stale (H8).
- Robust CIP-25 chunker that never splits a multibyte code point / surrogate
  pair, replacing two brittle copies (H10 / L10).
- Removed ~358 lines of dead `CborReader` fallback code (H6).
- Smaller fixes: preserve error `cause` in deposit metadata wrap (L1); skip
  datum-less state-NFT UTxOs (L3); Node `deposit()` logger checkpoints (L6);
  `package.json` `exports` map for the new subpaths (L9); emoji stripped from
  shipped-library logger output (L5); `peerDependencies` pin for
  `@blaze-cardano/sdk` (L4).
- Fixed 10 pre-existing TypeScript errors (incl. a latent bug in
  `inspect-deposit.ts` that assumed a nested multiasset shape).

### Docs / internal

- README rewritten: correct package name, **Browser usage** + **Node vs Browser
  API parity** sections, accurate completion flow and logging guidance (L8/L15).
- Test suite grew from 33 → **95** tests (12 new files covering datum
  round-trips for all 7 governance variants, the script-ref hash check, TTL
  sweeping, CIP-25 boundary chunking, CBOR integrity, and more).

### Deferred

- **L12** (table-driven governance-action dispatcher) — a hash-critical
  maintainability refactor, deferred to its own PR. The divergence it would
  guard against is already caught by the new round-trip tests.
