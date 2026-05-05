/**
 * Address Parsing Utilities
 *
 * Utilities for parsing Cardano addresses and extracting credentials.
 * Used for building governance action transactions that require credential data.
 */

import { Core } from "@blaze-cardano/sdk";
import { TCredential } from "@validators/Types/Credential.js";

/**
 * Parse a Cardano bech32 address and extract the payment credential
 *
 * @param bech32Address - A bech32-encoded Cardano address (addr1... or addr_test1...)
 * @returns The payment credential in TCredential format ({ vkey: string } or { script: string })
 * @throws Error if address cannot be parsed or has no payment credential
 */
export function parseAddressToCredential(bech32Address: string): TCredential {
  try {
    // Parse the bech32 address using Blaze
    const address = Core.Address.fromBech32(bech32Address);

    // Get the address type to determine how to extract the credential
    const addressType = address.getType();

    // Extract the payment credential based on address type
    // Types 0-5 are base addresses with payment + stake credentials
    // Types 6-7 are enterprise addresses with only payment credential
    // Types 14-15 are reward addresses (stake only)

    // Get the payment part from the address
    const paymentCred = address.getProps().paymentPart;

    if (!paymentCred) {
      throw new Error(
        `Address type ${addressType} does not have a payment credential`,
      );
    }

    // Check the credential type
    if (paymentCred.type === Core.CredentialType.KeyHash) {
      // Verification key hash (normal user address)
      return { vkey: paymentCred.hash };
    } else if (paymentCred.type === Core.CredentialType.ScriptHash) {
      // Script hash (smart contract address)
      return { script: paymentCred.hash };
    } else {
      throw new Error(`Unknown credential type: ${paymentCred.type}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to parse address '${bech32Address}': ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Check if a string is a valid Cardano bech32 address
 *
 * @param address - String to check
 * @returns true if valid Cardano address, false otherwise
 */
export function isValidCardanoAddress(address: string): boolean {
  try {
    // Attempt to parse the address
    Core.Address.fromBech32(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the payment credential hash from a bech32 address
 *
 * @param bech32Address - A bech32-encoded Cardano address
 * @returns The 56-character hex hash of the payment credential
 * @throws Error if address cannot be parsed or has no payment credential
 */
export function getPaymentCredentialHash(bech32Address: string): string {
  const credential = parseAddressToCredential(bech32Address);
  return "vkey" in credential ? credential.vkey : credential.script;
}
