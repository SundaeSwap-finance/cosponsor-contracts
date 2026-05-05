# Cosponsor Contracts - Codebase Cleanup Analysis

Generated: 2026-01-09

## Summary

| Category | Count | Severity | Files Affected |
|----------|-------|----------|-----------------|
| Console.log statements | 100+ | Medium | 5 files |
| `any` type usage | 40+ | High | 7 files |
| Unused imports | 3 | Medium | 1 file |
| Dead code modules | 3 | High | 1 file |
| Duplicate functions | 3 | Medium | 3 files |
| Hardcoded values | 7+ | Medium | 4+ files |
| TODO/FIXME comments | 2 | Low-Medium | 2 files |
| Test files (not integrated) | 4 | Low | Root directory |
| Mock data repeated | 4+ | Low | 4+ files |

---

## 1. Dead Code: Missing/Unused Transaction Modules

### `offchain/src/scripts/withdrawal.ts` (lines 3-5)
**Issue:** Imports three non-existent transaction modules:
```typescript
import { withdraw } from '../transactions/Withdrawal'
import { bulkWithdraw } from '../transactions/BulkWithdrawal'
import { multiTokenBulkWithdraw } from '../transactions/MultiTokenBulkWithdrawal'
```

**Status:** The transaction directory only contains: `Deposit.ts`, `UnifiedWithdrawal.ts`, and `index.ts`

**Fix:** Remove unused imports or create/export the missing modules if needed. The new unified withdrawal system should replace these old modules.

---

## 2. Console.log Statements

### `offchain/src/helpers/checkEnvVars.ts` (lines 4-11)
- **Issue:** Utility script with hardcoded console logging and artificial delay
- **Fix:** Convert to structured logging or reduce to essential validation only

### `offchain/src/helpers/depositIndexer.ts`
- **Count:** 25+ console.log statements
- **Lines:** 71, 101-103, 111, 139, 143, 155-195, 209-211, 222, 239, 256-273
- **Fix:** Implement proper logger with log levels

### `offchain/src/helpers/fetch-submissions.ts`
- **Count:** 40+ console.log statements with emoji characters
- **Lines:** 112, 172, 189, 193-270, 273, 281-297, 382-450
- **Fix:** Implement structured logging; emoji-heavy output not suitable for SDK

### `offchain/src/helpers/inspect-deposit.ts`
- **Count:** 20+ console.log statements
- **Lines:** 28-29, 51-56, 58, 74-80, 86, 107-112, 157-161
- **Fix:** Use conditional debug logging

### `offchain/src/scripts/generate-script-cbor.ts`
- **Count:** 9 console.log statements
- **Lines:** 9, 11-14, 17, 18, 26, 36, 38, 41-51
- **Fix:** Convert to optional verbose mode

---

## 3. TODO/FIXME Comments

### `offchain/src/Config.ts` (line 1)
```typescript
// TODO: Make these values environment variables
```
- **Current values:**
  - `PROTOCOL_BOOT_TRANSACTION_ID`
  - `PROTOCOL_BOOT_TRANSACTION_INDEX`
  - `PROPOSAL_LIFETIME`
- **Fix:** Move to `.env` configuration with defaults fallback

### `validators/cosponsor.ak` (line 14)
```aiken
//TODO: Add logic to prevent adding tokens to cosponsor utxos
```
- **Issue:** Missing validation in smart contract
- **Fix:** Implement token validation logic in the spend entrypoint

---

## 4. Type Issues: `any` Type Usage

### `offchain/src/utils/provider.ts`
- **Lines:** 47, 54, 129, 152-153, 156, 162, 170, 257, 271, 326, 329
- **Count:** 11 instances
- **Examples:**
  - Line 47: `private blaze!: Blaze<any, HotWallet>;`
  - Line 129: `(this.config as any).type`
  - Line 170: `(wallet as any).provider = this.provider;`
- **Fix:** Create proper type definitions for Blaze generic parameters

### `offchain/src/utils/wallet.ts`
- **Lines:** 14-15, 17, 40
- **Issue:** Buffer.from and HotWallet.fromMasterkey use `any` type assertions
- **Fix:** Create proper type definitions or use BufferLike type

### `offchain/src/utils/ogmiosSubmission.ts`
- **Lines:** 19, 26-27, 188
- **Count:** 5 instances
- **Examples:**
  - Line 19: `log(...args: any[])`
  - Line 26-27: `builtTx: any, witnessSet: any`
- **Fix:** Define proper interfaces for transaction types

### `offchain/src/helpers/depositIndexer.ts`
- **Lines:** 22, 25
- **Issue:** `datumData: any` in parseCosponsorDatum
- **Fix:** Use proper Plutus data type

### `offchain/src/helpers/fetch-submissions.ts`
- **Lines:** 26, 50, 68, 103, 119, 223, 317
- **Count:** 7 instances
- **Fix:** Create proper datum and submission type interfaces

### `offchain/src/transactions/UnifiedWithdrawal.ts`
- **Lines:** 48, 103, 246
- **Count:** 3 instances

### `offchain/src/scripts/withdrawal.ts`
- **Lines:** 41, 44, 457, 619, 631
- **Count:** 5 instances

### `offchain/src/scripts/deploy.ts`
- **Lines:** 14, 97
- **Issue:** Script interface and UTXO filtering use `any`

**Total: 40+ `any` type occurrences**

---

## 5. Debug/Development Artifacts: Test Files

Four test files in offchain root directory:
- `offchain/test-clean-withdrawal.ts`
- `offchain/test-exact-withdrawal.ts`
- `offchain/test-simple-bulk.ts`
- `offchain/test-specified-withdrawal.ts`

**Issues:**
- Not integrated with any test runner
- `package.json` has `"test": "echo \"Error: no test specified\""`
- Mixed with production code
- Contain hardcoded transaction hashes and test scenarios

**Fix:** Move to proper `tests/` directory with test framework, or remove if no longer needed

---

## 6. Duplicate Code

### `parseCosponsorDatum` function
Appears in multiple files:
- `offchain/src/helpers/depositIndexer.ts` (lines 21-56)
- `offchain/src/helpers/fetch-submissions.ts` (lines 67-115)
- `offchain/src/scripts/withdrawal.ts` (lines 40-73)

**Fix:** Extract to shared utility in `src/helpers/` and import everywhere

### `mockProposal` object
Recreated multiple times:
- `depositIndexer.ts` (lines 122-129)
- `inspect-deposit.ts` (lines 16-25)
- `deposit.ts`
- `withdrawal.ts` (multiple locations)

**Fix:** Create a factory function or export from Config.ts

### CardanoProvider initialization
Similar logic repeated in multiple scripts:
- Lines 262-290 in depositIndexer.ts
- Similar patterns in fetch-submissions.ts, inspect-deposit.ts

**Fix:** Use `CardanoProvider.fromEnv()` pattern consistently

---

## 7. Hardcoded Values

### Mock proposal data
- `offchain/src/helpers/depositIndexer.ts` (lines 122-129)
- `offchain/src/helpers/inspect-deposit.ts` (lines 16-25)
- `offchain/src/scripts/deposit.ts`

**Fix:** Use factory function with configurable parameters

### Hardcoded script address
- `offchain/src/transactions/Deposit.ts` (lines 41-43)
- `offchain/src/transactions/UnifiedWithdrawal.ts` (lines 69-71)
- Address: `addr_test1qp69u6ka06zrxm0akqsfku6w862klmxx5gv8s2n5sv75nfxenku8xvgssv0852hyj36cpkzfs5p0pqpspt6qapm2rapqkayyvf`

**Fix:** Make configurable or derive from validator script

### Hardcoded balance minimums
- `offchain/src/scripts/configure.ts` (line 24): `10_000_000n`
- `offchain/src/scripts/mint-state-nft.ts` (line 35): `10_000_000n`
- `offchain/src/utils/provider.ts` (line 223): `5_000_000n`

**Fix:** Define constants in Config.ts

---

## 8. Inconsistent Patterns

### Error handling approaches
- Some files use try-catch with silent failures:
  - `depositIndexer.ts` line 53-55: Returns null on error
  - `fetch-submissions.ts` line 111-113: Logs error and returns null
- Others throw errors:
  - `wallet.ts` line 23-26: Throws error on address mismatch
- Some don't validate at all

**Fix:** Establish consistent error handling pattern across SDK

---

## 9. Unnecessary Utilities

### `offchain/src/helpers/checkEnvVars.ts`
- **Issue:** Simple env check script with artificial timeout
- Line 9-11: `setTimeout(() => { process.exit(0); }, 1000);` - Why 1-second delay?
- **Fix:** Remove unnecessary script or repurpose as pre-deployment validator

---

## 10. SDK Packaging Issues

### `offchain/src/transactions/index.ts`
- **Issue:** Only exports Deposit and UnifiedWithdrawal, but scripts import old withdrawal functions
- **Fix:** Update exports to include all necessary transaction builders or refactor scripts

---

## Recommended Cleanup Priority

### Phase 1 (High Priority)
1. Remove/replace unused imports in `withdrawal.ts` or provide missing modules
2. Replace 40+ `any` types with proper type definitions
3. Remove or integrate test files from root directory

### Phase 2 (Medium Priority)
4. Consolidate duplicate `parseCosponsorDatum` function
5. Consolidate mock proposal creation logic
6. Implement proper logger instead of console.log

### Phase 3 (Low Priority)
7. Externalize hardcoded configuration values
8. Add test framework integration
9. Resolve TODO comments in Config.ts and cosponsor.ak
