import { Blaze, Core, Provider, Wallet } from "@blaze-cardano/sdk";

import { logger } from "../logger.js";

export interface IScriptReferenceConfig {
  /** Expected script hash (the value the provider/CBOR must match). */
  scriptHash: string;
  /** Bech32 address where the reference-script UTxO lives (Kupo+Ogmios path). */
  scriptReferenceAddress: string;
  /** Reference UTxO holding the script (Blockfrost fallback path). */
  referenceUtxo: { txHash: string; outputIndex: number };
  /** Pre-computed PlutusV3 script CBOR for the Blockfrost fallback. */
  fallbackCbor: string | undefined;
}

/**
 * Resolve the cosponsor reference-script UTxO, with a Blockfrost fallback.
 *
 * Shared by `browserDeposit` and `browserWithdraw` (audit H4) — the two used
 * to carry near-identical copies of this logic. Crucially, BOTH the provider
 * (Kupo+Ogmios) and the CBOR-fallback paths now verify the resolved script's
 * hash matches `scriptHash` before returning. Previously only the deposit flow
 * checked the provider path (AUDIT.md F26); the withdrawal copy skipped it and
 * would have failed opaquely on-chain if the deployed script and
 * `BROWSER_CONFIG` ever drifted. Unifying here closes that gap.
 */
export async function resolveCosponsorScriptReference(
  blaze: Blaze<Provider, Wallet>,
  config: IScriptReferenceConfig,
): Promise<Core.TransactionUnspentOutput> {
  const { scriptHash, scriptReferenceAddress, referenceUtxo, fallbackCbor } =
    config;

  const scriptAddress = Core.Address.fromBech32(scriptReferenceAddress);

  // Try to resolve the script reference via the provider (Kupo+Ogmios).
  const providerRef = await blaze.provider.resolveScriptRef(
    Core.Hash28ByteBase16(scriptHash),
    scriptAddress,
  );

  if (providerRef) {
    logger.debug("Script reference resolved via provider (Kupo+Ogmios)");

    // Defense-in-depth (AUDIT.md F26): verify the resolved ref still matches
    // the expected hash before attaching it as a reference input.
    const refScript = providerRef.output().scriptRef();
    if (!refScript) {
      throw new Error(
        "Resolved script reference UTxO has no attached script — refusing to proceed.",
      );
    }
    const refHash = refScript.hash();
    if (refHash !== scriptHash) {
      throw new Error(
        `Script reference hash mismatch on Kupo+Ogmios path!\n` +
          `Expected: ${scriptHash}\n` +
          `Got: ${refHash}\n\n` +
          `BROWSER_CONFIG.scripts.cosponsor.hash is out of sync with the ` +
          `deployed reference UTxO at ${scriptReferenceAddress}. ` +
          `Update the config or re-deploy.`,
      );
    }
    return providerRef;
  }

  logger.debug(
    "Provider could not resolve script reference, using Blockfrost fallback...",
  );

  // Blockfrost fallback: use the pre-computed script CBOR.
  if (!fallbackCbor) {
    throw new Error(
      "Cannot resolve script reference. Either:\n" +
        "1. Use Kupo + Ogmios provider (recommended), OR\n" +
        "2. Generate and add pre-computed script CBOR to BrowserConfig.ts\n\n" +
        "See SDK README for instructions.",
    );
  }

  const plutusScript = Core.PlutusV3Script.fromCbor(Core.HexBlob(fallbackCbor));
  const script = Core.Script.newPlutusV3Script(plutusScript);

  const computedHash = script.hash();
  if (computedHash !== scriptHash) {
    throw new Error(
      `Script hash mismatch!\n` +
        `Expected: ${scriptHash}\n` +
        `Got: ${computedHash}\n\n` +
        `The pre-computed CBOR in BrowserConfig.ts is outdated. ` +
        `Run 'bun run generate-script-cbor' in cosponsor-contracts to regenerate.`,
    );
  }

  // Resolve the reference UTxO and manually attach the script, mimicking what
  // provider.resolveScriptRef() would return.
  const txInput = new Core.TransactionInput(
    Core.TransactionId(referenceUtxo.txHash),
    BigInt(referenceUtxo.outputIndex),
  );

  const resolvedUtxos = await blaze.provider.resolveUnspentOutputs([txInput]);
  if (resolvedUtxos.length === 0) {
    throw new Error(
      `Could not resolve reference UTxO: ${referenceUtxo.txHash}#${referenceUtxo.outputIndex}`,
    );
  }

  const resolvedUtxo = resolvedUtxos[0];
  const originalOutput = resolvedUtxo.output();

  const outputWithScript = new Core.TransactionOutput(
    originalOutput.address(),
    originalOutput.amount(),
  );
  const datum = originalOutput.datum();
  if (datum) {
    outputWithScript.setDatum(datum);
  }
  outputWithScript.setScriptRef(script);

  logger.debug("Using pre-computed script CBOR with reference UTxO");
  return new Core.TransactionUnspentOutput(
    resolvedUtxo.input(),
    outputWithScript,
  );
}
