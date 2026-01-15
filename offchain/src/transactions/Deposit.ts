import { Core, Wallet } from "@blaze-cardano/sdk";
import { Blaze } from "@blaze-cardano/sdk";
import { makeValue } from "@blaze-cardano/sdk";
import { Provider } from "@blaze-cardano/sdk";
import { TxBuilder } from "@blaze-cardano/sdk";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
  SCRIPT_REFERENCE_ADDRESS,
} from "@/Config.js";
import { Cosponsor, ICosponsoredProposal } from "@validators/Cosponsor.js";
import { CosponsorState } from "@validators/CosponsorState.js";
import { CosponsorTypes } from "@validators/GeneratedTypes/index.js";
import { serialize } from "@blaze-cardano/data";
import { Address } from "@blaze-cardano/core";

export interface IDepositArgs<P extends Provider, W extends Wallet> {
  blaze: Blaze<P, W>;
  cosponsoredProposal: ICosponsoredProposal;
  depositAmount: bigint;
}

export const deposit = async <P extends Provider, W extends Wallet>({
  blaze,
  cosponsoredProposal,
  depositAmount,
}: IDepositArgs<P, W>): Promise<TxBuilder> => {
  const tx = blaze.newTransaction();

  const cosponsorState = new CosponsorState(
    PROTOCOL_BOOT_TRANSACTION_ID,
    PROTOCOL_BOOT_TRANSACTION_INDEX,
    PROPOSAL_LIFETIME,
  );

  const cosponsor = Cosponsor.new({
    statePolicyId: cosponsorState.script().hash(),
    cosponsoredProposal,
  });

  const scriptAddress = Address.fromBech32(SCRIPT_REFERENCE_ADDRESS);

  // Get reference to the Cosponsor minting policy FIRST
  const cosponsorReference = await blaze.provider.resolveScriptRef(
    cosponsor.script().hash(),
    scriptAddress,
  );

  if (!cosponsorReference) {
    throw new Error("Cosponsor script reference not found");
  }

  tx.addReferenceInput(cosponsorReference);

  // Also get reference to the CosponsorState script
  const cosponsorStateReference = await blaze.provider.resolveScriptRef(
    cosponsorState.script().hash(),
    scriptAddress,
  );

  if (cosponsorStateReference) {
    tx.addReferenceInput(cosponsorStateReference);
  }

  // NOW create the MDeposit redeemer and add minting after script references are available
  const mintRedeemer = serialize(
    CosponsorTypes.CosponsorMintRedeemer,
    "MDeposit",
  );

  // Extract proposal information for metadata
  const proposalUrlDecoded = Buffer.from(
    cosponsoredProposal.anchor.url,
    "hex",
  ).toString();
  const proposalName = proposalUrlDecoded.includes("proposal")
    ? proposalUrlDecoded.split("/").pop()?.replace(".json", "") || "Unknown"
    : "Custom Proposal";

  // Create CIP-25 compliant metadata using Blaze Core types
  const tokenAssetName = cosponsor.gAda();
  const policyId = cosponsor.script().hash();

  try {
    // Create CIP-25 metadata using the correct Blaze Core approach
    // Create token metadata map with CIP-25 required fields
    const tokenMetadataMap = new Core.MetadatumMap();

    // Required: name
    tokenMetadataMap.insert(
      Core.Metadatum.newText("name"),
      Core.Metadatum.newText(`Governance ADA - ${proposalName}`),
    );

    // Required: image (using chunking for long data URI)
    const svgImage = `data:image/svg+xml;base64,${Buffer.from(
      `
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
        <rect width="100" height="100" fill="#1e40af"/>
        <text x="50" y="30" font-family="Arial" font-size="12" fill="white" text-anchor="middle">gADA</text>
        <text x="50" y="50" font-family="Arial" font-size="10" fill="#93c5fd" text-anchor="middle">${depositAmount / 1_000_000n} ADA</text>
        <text x="50" y="70" font-family="Arial" font-size="8" fill="#dbeafe" text-anchor="middle">Governance</text>
        <text x="50" y="85" font-family="Arial" font-size="8" fill="#dbeafe" text-anchor="middle">Token</text>
      </svg>
    `,
    ).toString("base64")}`;

    // Chunk the image data to fit 64-byte limit
    const chunkImageData = (value: string): Core.Metadatum => {
      if (Buffer.from(value, "utf8").length <= 64) {
        return Core.Metadatum.newText(value);
      } else {
        // Split into chunks that fit in 64 bytes
        const chunks = new Core.MetadatumList();
        for (let i = 0; i < value.length; i += 64) {
          let j = 0;
          // Find the largest chunk that fits in 64 bytes
          while (
            Buffer.from(value.substring(i, i + 64 - j), "utf8").length > 64
          ) {
            j++;
          }
          chunks.add(Core.Metadatum.newText(value.substring(i, i + 64 - j)));
          i -= j;
        }
        return Core.Metadatum.newList(chunks);
      }
    };

    tokenMetadataMap.insert(
      Core.Metadatum.newText("image"),
      chunkImageData(svgImage),
    );

    // Optional: description
    tokenMetadataMap.insert(
      Core.Metadatum.newText("description"),
      Core.Metadatum.newText(
        `gADA: ${depositAmount / 1_000_000n} ADA for ${proposalName}`,
      ),
    );

    // Custom fields (not part of CIP-25 but useful)
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
      Core.Metadatum.newText(proposalUrlDecoded),
    );
    tokenMetadataMap.insert(
      Core.Metadatum.newText("governance_action"),
      Core.Metadatum.newText(cosponsoredProposal.action.kind),
    );

    // Create policy map using hex-encoded asset name (CIP-25 Version 1)
    const policyMap = new Core.MetadatumMap();
    policyMap.insert(
      Core.Metadatum.newText(tokenAssetName), // Asset name as hex string
      Core.Metadatum.newMap(tokenMetadataMap),
    );

    // Create CIP-25 structure (label 721) using hex-encoded policy ID
    const cip25Map = new Core.MetadatumMap();
    cip25Map.insert(
      Core.Metadatum.newText(policyId), // Policy ID as hex string
      Core.Metadatum.newMap(policyMap),
    );

    // Create the final metadata map
    const metadataMap = new Map<bigint, Core.Metadatum>();
    metadataMap.set(721n, Core.Metadatum.newMap(cip25Map));

    // Create the Metadata object using the constructor
    const metadata = new Core.Metadata(metadataMap);

    // Add metadata to transaction
    tx.setMetadata(metadata);
  } catch (metadataError) {
    const errorMessage =
      metadataError instanceof Error
        ? metadataError.message
        : String(metadataError);
    throw new Error(
      `Deposit failed: Could not add CIP-25 metadata - ${errorMessage}`,
    );
  }

  tx.addMint(
    Core.PolicyId(policyId),
    new Map<Core.AssetName, bigint>([
      [Core.AssetName(tokenAssetName), depositAmount],
    ]),
    mintRedeemer,
  );

  tx.lockAssets(
    cosponsor.address(blaze.provider.network),
    makeValue(depositAmount),
    cosponsor.datum(),
  );

  tx.setChangeAddress(await blaze.wallet.getChangeAddress());

  return tx;
};
