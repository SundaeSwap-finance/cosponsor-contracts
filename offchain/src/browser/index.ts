/**
 * Browser-compatible exports for the Cosponsor SDK
 *
 * This module provides all the functionality needed to use the Cosponsor
 * protocol in browser environments (React, Vue, etc.)
 */

// Browser configuration
export { BROWSER_CONFIG } from "./BrowserConfig.js";
export type { BrowserConfig } from "./BrowserConfig.js";

// Fail fast at load if the pre-computed script CBOR no longer matches its
// recorded hash (stale blob) — see audit H9.
import { verifyCosponsorScriptCbor } from "./BrowserConfig.js";
verifyCosponsorScriptCbor();

// Browser deposit/withdrawal/propose functions
export { browserDeposit } from "./BrowserDeposit.js";
export { browserWithdraw, browserWithdrawLegacy } from "./BrowserWithdrawal.js";
export type { IWithdrawalPlan, IScriptUtxo } from "./BrowserWithdrawal.js";
export { browserPropose } from "./BrowserPropose.js";

// Wallet data fetching utilities
export {
  fetchWithdrawalPlan,
  selectUtxosForWithdrawal,
  fetchUserDeposits,
  // Datum decoders — return `null` on failure or After-state datums. The
  // same primitives `fetchWithdrawalPlan` uses internally; exposed so
  // consumers can identify proposals without standing up the full plan.
  // See AUDIT.md F12 / F13 / F16.
  computeProposalHashFromDatum,
  extractActionKindFromDatum,
  extractAnchorFromDatum,
} from "./fetchUserDeposits.js";
export type { IUserGadaBalance, IUserDeposit } from "./fetchUserDeposits.js";

// Browser provider utilities
export {
  createProvider,
  createCIP30Wallet,
  createBlazeWithBrowserWallet,
  createOgmiosEvaluator,
} from "./blazeProvider.js";
export type { BrowserProviderOptions } from "./blazeProvider.js";

// Chained-tx evaluator wrapper + deposit guard (refuse a deposit that spends a
// Cosponsor script UTxO; the validator enforces cosponsor_inputs == 0).
export {
  wrapEvaluatorWithWalletUtxos,
  buildChainedTxEvaluator,
} from "./chainedTxEvaluator.js";
export type { IEvaluatorGuardOptions } from "./chainedTxEvaluator.js";

// Address utilities
export {
  parseAddressToCredential,
  isValidCardanoAddress,
  getPaymentCredentialHash,
} from "./addressUtils.js";

// UTxO tracking for transaction chaining
export {
  pendingUtxoTracker,
  extractTransactionEffects,
} from "./utxoTracker.js";

// CIP-25 metadata utilities
export { chunkCip25Text } from "./metadataUtils.js";

// Script address helpers — replaces the inlined Core.addressFromCredential
// boilerplate that used to live in three near-duplicate copies. See
// AUDIT.md F22.
export {
  getCosponsorScriptAddress,
  getStateScriptAddress,
} from "./scriptAddress.js";

// Canonical proposal-identity helper and inverse-of-ToContractType. See
// AUDIT.md F17 / F23. Both work without instantiating the Cosponsor class.
export {
  computeProposalAssetName,
  fromContractType,
} from "../validators/Types/GovernanceAction.js";

// Re-export the Blockfrost class identity from this SDK's own
// `@blaze-cardano/sdk` copy. Consumers (e.g. the cosponsor-ui app) that
// monkey-patch `Blockfrost.prototype.evaluateTransaction` to work around
// upstream Blockfrost provider bugs need access to *this* prototype — the
// one `createProvider`/`createBlazeWithBrowserWallet` actually instantiate
// from — not the one in their own node_modules. Without this re-export
// the patch only covers the consumer's tree and the SDK-constructed
// provider keeps the unpatched upstream evaluator.
export { Blockfrost } from "@blaze-cardano/sdk";
