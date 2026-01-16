/**
 * Browser-compatible exports for the Cosponsor SDK
 *
 * This module provides all the functionality needed to use the Cosponsor
 * protocol in browser environments (React, Vue, etc.)
 */

// Browser configuration
export { BROWSER_CONFIG } from "./BrowserConfig.js";
export type { BrowserConfig } from "./BrowserConfig.js";

// Browser deposit/withdrawal functions
export { browserDeposit } from "./BrowserDeposit.js";
export { browserWithdraw, browserWithdrawLegacy } from "./BrowserWithdrawal.js";
export type { IWithdrawalPlan, IScriptUtxo } from "./BrowserWithdrawal.js";

// Wallet data fetching utilities
export {
  fetchWithdrawalPlan,
  selectUtxosForWithdrawal,
  fetchUserDeposits,
} from "./fetchUserDeposits.js";
export type {
  IUserGadaBalance,
  IUserDeposit,
} from "./fetchUserDeposits.js";

// Browser provider utilities
export {
  createProvider,
  createCIP30Wallet,
  createBlazeWithBrowserWallet,
  createOgmiosEvaluator,
} from "./blazeProvider.js";
export type { BrowserProviderOptions } from "./blazeProvider.js";

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
