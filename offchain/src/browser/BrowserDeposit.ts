import { Core, makeValue, Blaze, Provider, Wallet } from "@blaze-cardano/sdk";
import { serialize } from "@blaze-cardano/data";
import { CosponsorTypes } from "@validators/GeneratedTypes/index.js";
import { ICosponsoredProposal } from "@validators/Cosponsor.js";
import { BROWSER_CONFIG } from "./BrowserConfig.js";
import {
  buildGovernanceActionAsPlutusData,
  buildCosponsoredProposalProcedureAsPlutusData,
  PlutusList,
  ConstrPlutusData,
  PlutusData,
} from "@validators/Types/GovernanceAction.js";
import { chunkCip25Text } from "./metadataUtils.js";
import { resolveCosponsorScriptReference } from "./scriptRefResolver.js";
import { getCosponsorScriptAddress } from "./scriptAddress.js";

import { logger } from "../logger.js";
/**
 * Browser-compatible deposit function
 *
 * Supports two provider modes:
 * 1. Kupo + Ogmios: Native reference script resolution (recommended)
 * 2. Blockfrost: Requires pre-computed script CBOR in config
 */
export const browserDeposit = async ({
  blaze,
  cosponsoredProposal,
  depositAmount,
}: {
  blaze: Blaze<Provider, Wallet>;
  cosponsoredProposal: ICosponsoredProposal;
  depositAmount: bigint;
}) => {
  logger.debug("=== browserDeposit START ===");
  logger.debug("Action kind:", cosponsoredProposal.action.kind);
  logger.debug(
    "Action data:",
    JSON.stringify(
      cosponsoredProposal.action,
      (_, v) =>
        typeof v === "bigint"
          ? v.toString()
          : v instanceof Map
            ? Array.from(v.entries())
            : v,
      2,
    ),
  );

  let tx = blaze.newTransaction();

  const cosponsorHash = BROWSER_CONFIG.scripts.cosponsor.hash;

  logger.debug("Building browser deposit transaction...");
  logger.debug("Cosponsor hash:", cosponsorHash);

  // Resolve the script reference (Kupo+Ogmios, with Blockfrost CBOR fallback).
  // Shared with browserWithdraw — see scriptRefResolver.ts (audit H4).
  const cosponsorReference = await resolveCosponsorScriptReference(blaze, {
    scriptHash: cosponsorHash,
    scriptReferenceAddress: BROWSER_CONFIG.scriptReferenceAddress,
    referenceUtxo: BROWSER_CONFIG.scriptReferenceUtxos.cosponsor,
    fallbackCbor: BROWSER_CONFIG.scripts.cosponsor.cbor,
  });

  // Add reference input for on-chain validation
  tx = tx.addReferenceInput(cosponsorReference);

  // Create the MDeposit redeemer
  const mintRedeemer = serialize(
    CosponsorTypes.CosponsorMintRedeemer,
    "MDeposit",
  );

  // Extract proposal information for metadata
  const proposalUrlDecoded = Buffer.from(
    cosponsoredProposal.anchor.url,
    "hex",
  ).toString();
  let proposalName = proposalUrlDecoded.includes("proposal")
    ? proposalUrlDecoded.split("/").pop()?.replace(".json", "") || "Unknown"
    : "Custom Proposal";
  // Truncate to fit CIP-25 metadata limit (64 bytes max, minus "Governance ADA - " prefix = 47 chars)
  if (proposalName.length > 47) {
    proposalName = `${proposalName.slice(0, 44)}...`;
  }

  // Create CIP-25 compliant metadata
  // Token asset name is the hash of the cosponsored proposal
  // We use raw PlutusData builders to avoid serialize() instanceof issues
  const governanceActionData = buildGovernanceActionAsPlutusData(
    cosponsoredProposal.action,
  );
  logger.debug(
    "Governance action PlutusData CBOR:",
    governanceActionData.toCbor(),
  );

  const cosponsoredProposalProcedureData =
    buildCosponsoredProposalProcedureAsPlutusData(governanceActionData, {
      deposit: cosponsoredProposal.deposit,
      returnAddress: {
        ScriptCredential: [cosponsorHash] as [string],
      },
      anchor: {
        url: cosponsoredProposal.anchor.url,
        hash: cosponsoredProposal.anchor.hash,
      },
    });
  logger.debug(
    "CosponsoredProposalProcedure PlutusData CBOR:",
    cosponsoredProposalProcedureData.toCbor(),
  );
  const tokenAssetName = cosponsoredProposalProcedureData.hash();
  logger.debug("Token asset name hash:", tokenAssetName);
  const policyId = Core.PolicyId(cosponsorHash);

  try {
    const tokenMetadataMap = new Core.MetadatumMap();
    tokenMetadataMap.insert(
      Core.Metadatum.newText("name"),
      Core.Metadatum.newText(`Governance ADA - ${proposalName}`),
    );

    // SVG image
    const svgImage = `data:image/svg+xml;base64,${Buffer.from(
      `
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
        <rect width="100" height="100" fill="#1e40af"/>
        <text x="50" y="30" font-family="Arial" font-size="12" fill="white" text-anchor="middle">gADA</text>
        <text x="50" y="50" font-family="Arial" font-size="10" fill="#93c5fd" text-anchor="middle">${depositAmount / 1000000n} ADA</text>
        <text x="50" y="70" font-family="Arial" font-size="8" fill="#dbeafe" text-anchor="middle">Governance</text>
        <text x="50" y="85" font-family="Arial" font-size="8" fill="#dbeafe" text-anchor="middle">Token</text>
      </svg>
    `,
    ).toString("base64")}`;

    tokenMetadataMap.insert(
      Core.Metadatum.newText("image"),
      chunkCip25Text(svgImage),
    );
    const description = `gADA: ${depositAmount / 1000000n} ADA for ${proposalName}`;
    tokenMetadataMap.insert(
      Core.Metadatum.newText("description"),
      chunkCip25Text(description),
    );
    tokenMetadataMap.insert(
      Core.Metadatum.newText("ticker"),
      Core.Metadatum.newText("gADA"),
    );
    tokenMetadataMap.insert(
      Core.Metadatum.newText("decimals"),
      Core.Metadatum.newInteger(6n),
    );
    tokenMetadataMap.insert(
      Core.Metadatum.newText("lovelace"),
      Core.Metadatum.newInteger(depositAmount),
    );
    tokenMetadataMap.insert(
      Core.Metadatum.newText("proposal_url"),
      chunkCip25Text(proposalUrlDecoded),
    );
    tokenMetadataMap.insert(
      Core.Metadatum.newText("governance_action"),
      Core.Metadatum.newText(cosponsoredProposal.action.kind),
    );

    // Create CIP-25 structure
    const policyMap = new Core.MetadatumMap();
    policyMap.insert(
      Core.Metadatum.newText(tokenAssetName.toString()),
      Core.Metadatum.newMap(tokenMetadataMap),
    );

    const cip25Map = new Core.MetadatumMap();
    cip25Map.insert(
      Core.Metadatum.newText(policyId.toString()),
      Core.Metadatum.newMap(policyMap),
    );

    const metadataMap = new Map();
    metadataMap.set(721n, Core.Metadatum.newMap(cip25Map));

    const metadata = new Core.Metadata(metadataMap);

    // Add metadata to transaction using setAuxiliaryData (browser version of Blaze)
    // Note: Node.js version has setMetadata(), browser version uses setAuxiliaryData()
    logger.debug("Adding CIP-25 metadata to transaction");
    const auxiliaryData = new Core.AuxiliaryData();
    auxiliaryData.setMetadata(metadata);
    tx = tx.setAuxiliaryData(auxiliaryData);
  } catch (metadataError) {
    const errorMessage =
      metadataError instanceof Error
        ? metadataError.message
        : String(metadataError);
    // Preserve the original error via `cause` so the stack/context isn't lost
    // when this surfaces to the caller (audit L1).
    throw new Error(
      `Deposit failed: Could not add CIP-25 metadata - ${errorMessage}`,
      { cause: metadataError },
    );
  }

  // Add minting using the reference script
  // The script reference was already added as a reference input above
  // Blaze will use the reference input for evaluation
  // TxBuilder is immutable - reassign after each operation

  tx = tx.addMint(
    policyId,
    new Map([[Core.AssetName(tokenAssetName.toString()), depositAmount]]),
    mintRedeemer,
  );

  // Calculate cosponsor script address
  const cosponsorScriptAddress = getCosponsorScriptAddress(
    blaze.provider.network,
    cosponsorHash,
  );

  // Create datum for the deposit
  // We reuse the already-built CosponsoredProposalProcedure PlutusData and wrap it in CosponsorDatum::Before
  // This bypasses serialize()'s instanceof PlutusData check which fails due to Vite module duplication
  logger.debug("Building CosponsorDatum::Before from raw PlutusData");

  // CosponsorDatum::Before is Constructor 0 with the CosponsoredProposalProcedure as its single field
  const datumFields = new PlutusList();
  datumFields.add(cosponsoredProposalProcedureData);
  const datumData = PlutusData.newConstrPlutusData(
    new ConstrPlutusData(0n, datumFields),
  );

  // Debug: Log the datum CBOR (the actual serialized format that goes on-chain)
  logger.debug("Datum CBOR:", datumData.toCbor());
  logger.debug("Deposit amount:", depositAmount.toString());
  logger.debug("Governance action:", cosponsoredProposal.action.kind);

  // Lock assets at the cosponsor script address
  // TxBuilder is immutable - reassign after each operation
  tx = tx.lockAssets(
    cosponsorScriptAddress,
    makeValue(depositAmount),
    datumData,
  );
  tx = tx.setChangeAddress(await blaze.wallet.getChangeAddress());

  // Return the incomplete TxBuilder - following the pattern from cosponsor-contracts
  // The caller will handle completion, evaluation, signing, and submission
  logger.debug(
    "Transaction built successfully (incomplete, ready for completion)",
  );

  return tx;
};
