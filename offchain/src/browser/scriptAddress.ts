/**
 * Script-address helpers for the cosponsor protocol.
 *
 * Pre-audit code inlined the same `Core.addressFromCredential(...)` derivation
 * in three near-duplicate copies (`fetchUserDeposits.ts`, `BrowserDeposit.ts`,
 * `BrowserWithdrawal.ts`). See AUDIT.md F22. These helpers centralise the
 * derivation so consumers can resolve the addresses without inlining the
 * boilerplate (and without an unused `Cosponsor.new({...})` instance just to
 * read `.address()`).
 */

import { Core } from "@blaze-cardano/sdk";
import { BROWSER_CONFIG } from "./BrowserConfig.js";
import { scriptAddressFromHash } from "../utils/scriptAddress.js";

/**
 * Address of the cosponsor script — where all script UTxOs holding locked
 * ADA against gADA tokens live.
 */
export const getCosponsorScriptAddress = (
  network: Core.NetworkId,
  hash: string = BROWSER_CONFIG.scripts.cosponsor.hash,
): Core.Address => scriptAddressFromHash(network, hash);

/**
 * Address of the cosponsor-state script — the singleton NFT holder used to
 * carry protocol parameters.
 */
export const getStateScriptAddress = (
  network: Core.NetworkId,
  hash: string = BROWSER_CONFIG.scripts.cosponsorState.hash,
): Core.Address => scriptAddressFromHash(network, hash);
