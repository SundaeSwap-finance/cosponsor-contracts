/**
 * Browser-compatible Propose function.
 *
 * Thin wrapper over the shared builder in `transactions/Propose.ts`: the
 * two-pass fixed point, body-field extraction and field-20 splice are all
 * environment-neutral, so — unlike deposit/withdraw, which re-implement
 * their flows — only the script CONTEXT differs here:
 *
 * - script hashes come from `BROWSER_CONFIG` (browsers cannot apply script
 *   parameters at runtime, so the parameterized validator classes are
 *   avoided);
 * - the proposal hash + `Before` datum are built with the raw PlutusData
 *   builders (sidesteps `serialize()`'s `instanceof PlutusData` issue under
 *   Vite module duplication — same trick as BrowserDeposit);
 * - script references resolve through `resolveCosponsorScriptReference`
 *   (Kupo+Ogmios native, Blockfrost pre-computed-CBOR fallback).
 *
 * ── SIGNING CONTRACT (same as transactions/Propose.ts) ──────────────────
 * Sign the EXACT returned CBOR: `wallet.signTx(tx.toCbor(), true)`, then
 * submit witness + original CBOR. Any re-serialization of the body changes
 * the transaction id and guarantees an on-chain rejection.
 */

import { Blaze, Core, Provider, Wallet } from "@blaze-cardano/sdk";
import { ICosponsoredProposal } from "@validators/Cosponsor.js";
import { AlwaysTrue } from "@validators/AlwaysTrue.js";
import {
  buildGovernanceActionAsPlutusData,
  buildCosponsoredProposalProcedureAsPlutusData,
  ConstrPlutusData,
  PlutusData,
  PlutusList,
} from "@validators/Types/GovernanceAction.js";
import {
  proposeWithScriptContext,
  type IProposeScriptContext,
} from "../transactions/Propose.js";
import {
  actionNeedsGuardrails,
  resolveGuardrailsReference,
} from "@/utils/guardrails.js";
import { BROWSER_CONFIG } from "./BrowserConfig.js";
import { resolveCosponsorScriptReference } from "./scriptRefResolver.js";
import { logger } from "../logger.js";

export const browserPropose = async ({
  blaze,
  cosponsoredProposal,
  debugMode = false,
  validUntilUnixMs,
}: {
  blaze: Blaze<Provider, Wallet>;
  cosponsoredProposal: ICosponsoredProposal;
  debugMode?: boolean;
  validUntilUnixMs?: number;
}): Promise<Core.Transaction> => {
  logger.debug("=== browserPropose START ===");

  const cosponsorHash = BROWSER_CONFIG.scripts.cosponsor.hash;
  const statePolicyId = BROWSER_CONFIG.scripts.cosponsorState.hash;
  const alwaysTruePolicyId = BROWSER_CONFIG.scripts.alwaysTrue.hash;

  // Proposal hash + Before datum via the raw PlutusData builders (identical
  // bytes to serialize(); see BrowserDeposit for the rationale).
  const governanceActionData = buildGovernanceActionAsPlutusData(
    cosponsoredProposal.action,
  );
  const cosponsoredProcedureData =
    buildCosponsoredProposalProcedureAsPlutusData(governanceActionData, {
      deposit: cosponsoredProposal.deposit,
      returnAddress: { ScriptCredential: [cosponsorHash] as [string] },
      anchor: {
        url: cosponsoredProposal.anchor.url,
        hash: cosponsoredProposal.anchor.hash,
      },
    });
  const proposalHash = cosponsoredProcedureData.hash().toString();

  const beforeDatumFields = new PlutusList();
  beforeDatumFields.add(cosponsoredProcedureData);
  const beforeDatum = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, beforeDatumFields),
  );

  // Resolve the three script references. Cosponsor + state carry the
  // Blockfrost CBOR fallback path; AlwaysTrue is parameterless, so the
  // locally compiled script doubles as the witness fallback.
  const cosponsorReference = await resolveCosponsorScriptReference(blaze, {
    scriptHash: cosponsorHash,
    scriptReferenceAddress: BROWSER_CONFIG.scriptReferenceAddress,
    referenceUtxo: BROWSER_CONFIG.scriptReferenceUtxos.cosponsor,
    fallbackCbor: BROWSER_CONFIG.scripts.cosponsor.cbor,
  });
  const stateReference = await resolveCosponsorScriptReference(blaze, {
    scriptHash: statePolicyId,
    scriptReferenceAddress: BROWSER_CONFIG.scriptReferenceAddress,
    referenceUtxo: BROWSER_CONFIG.scriptReferenceUtxos.cosponsorState,
    fallbackCbor: undefined,
  });

  let alwaysTrueReference: Core.TransactionUnspentOutput | undefined;
  let alwaysTrueScript: Core.Script | undefined;
  try {
    alwaysTrueReference =
      (await blaze.provider.resolveScriptRef(
        Core.Hash28ByteBase16(alwaysTruePolicyId),
        Core.Address.fromBech32(BROWSER_CONFIG.scriptReferenceAddress),
      )) ?? undefined;
  } catch (error) {
    logger.debug("browserPropose: AlwaysTrue reference lookup failed", error);
  }
  if (!alwaysTrueReference) {
    // Parameterless script — compiling it locally involves no runtime
    // parameter application, so this is safe in browsers too.
    alwaysTrueScript = Core.Script.newPlutusV3Script(AlwaysTrue.script());
  }

  // Guardrails reference for TreasuryWithdrawal / ProtocolParameters (the
  // ledger runs the constitution guardrails script at the Proposing purpose).
  // No env vars in browsers: the known per-network reference UTxO (or a
  // BROWSER_CONFIG override, if one is added later) is resolved here.
  let guardrailsReference: Core.TransactionUnspentOutput | undefined;
  if (actionNeedsGuardrails(cosponsoredProposal.action)) {
    const expectedHash =
      "guardRails" in cosponsoredProposal.action
        ? cosponsoredProposal.action.guardRails
        : undefined;
    guardrailsReference = await resolveGuardrailsReference(
      blaze.provider,
      expectedHash,
    );
  }

  const context: IProposeScriptContext = {
    cosponsorHash,
    statePolicyId,
    alwaysTruePolicyId,
    proposalHash,
    beforeDatum,
    cosponsorReference,
    stateReference,
    alwaysTrueReference,
    alwaysTrueScript,
    guardrailsReference,
  };

  return proposeWithScriptContext(
    { blaze, cosponsoredProposal, debugMode, validUntilUnixMs },
    context,
  );
};
