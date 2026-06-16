import { CosponsorTypes } from "./GeneratedTypes/index.js";
import { AlwaysTrue } from "./AlwaysTrue.js";
import { PlutusV3Script } from "@blaze-cardano/core";
import { TGovernanceAction, ToContractType } from "./Types/GovernanceAction.js";
import { serialize } from "@blaze-cardano/data";
import { Core } from "@blaze-cardano/sdk";
import { PlutusData } from "@blaze-cardano/core";
import { scriptAddressFromHash } from "../utils/scriptAddress.js";

// Convert the NFT name to hex for ByteArray type
const default_state_nft_name = Buffer.from("cosponsor_state_nft").toString(
  "hex",
);

export interface ICosponsoredProposal {
  deposit: bigint;
  anchor: { url: string; hash: string };
  action: TGovernanceAction;
}

export interface ICosponsorConfig {
  statePolicyId: string;
  cosponsoredProposal?: ICosponsoredProposal;
}

export class Cosponsor {
  cosponsoredProposal?: CosponsorTypes.CosponsoredProposalProcedure;
  statePolicyId: string;
  stateNft: string;

  constructor(
    statePolicyId: string,
    stateNft: string,
    cosponsoredProposal?: CosponsorTypes.CosponsoredProposalProcedure,
  ) {
    this.cosponsoredProposal = cosponsoredProposal;
    this.statePolicyId = statePolicyId;
    this.stateNft = stateNft;
  }

  public gAda(): string {
    if (this.cosponsoredProposal) {
      return serialize(
        CosponsorTypes.CosponsoredProposalProcedure,
        this.cosponsoredProposal,
      ).hash();
    } else {
      throw new Error("No cosponsored proposal available");
    }
  }

  public static new(config: ICosponsorConfig): Cosponsor {
    const instance = new Cosponsor(
      config.statePolicyId,
      default_state_nft_name,
    );
    if (config.cosponsoredProposal) {
      instance.cosponsoredProposal = {
        procedure: {
          deposit: config.cosponsoredProposal.deposit,
          governanceAction: ToContractType(config.cosponsoredProposal.action),
          returnAddress: {
            ScriptCredential: [instance.script().hash()],
          },
        },
        anchor: {
          url: config.cosponsoredProposal.anchor.url,
          hash: config.cosponsoredProposal.anchor.hash,
        },
      };
    }
    return instance;
  }

  public script(): PlutusV3Script {
    const alwaysTruePolicy = AlwaysTrue.script().hash();
    return new CosponsorTypes.CosponsorCosponsorMint(
      this.statePolicyId,
      this.stateNft,
      alwaysTruePolicy,
    ).Script.asPlutusV3()!;
  }

  public address(network: Core.NetworkId): Core.Address {
    return scriptAddressFromHash(network, this.script().hash());
  }

  public datum(): PlutusData {
    return serialize(
      CosponsorTypes.CosponsorDatum,
      this.cosponsoredProposal
        ? {
            Before: {
              cosponsored: this.cosponsoredProposal,
            },
          }
        : "After",
    );
  }
}
