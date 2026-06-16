import { Core } from "@blaze-cardano/sdk";

/**
 * Derive the address of a script from its hash on a given network.
 *
 * The single shared implementation of the
 * `Core.addressFromCredential(network, Credential(hash, ScriptHash))`
 * derivation. Environment-neutral (no config dependency) so both the Node
 * side (`Cosponsor.address()`, CLI helpers) and the browser side
 * (`browser/scriptAddress.ts`, which layers `BROWSER_CONFIG` defaults on
 * top) share one definition. (audit F22 follow-up)
 */
export const scriptAddressFromHash = (
  network: Core.NetworkId,
  hash: string,
): Core.Address =>
  Core.addressFromCredential(
    network,
    Core.Credential.fromCore({
      hash: Core.Hash28ByteBase16(hash),
      type: Core.CredentialType.ScriptHash,
    }),
  );
