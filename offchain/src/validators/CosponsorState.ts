import { PlutusV3Script } from "@blaze-cardano/core";
import { CosponsorTypes } from "./GeneratedTypes/index.js";
import { Core } from "@blaze-cardano/sdk";
import { scriptAddressFromHash } from "../utils/scriptAddress.js";

export class CosponsorState {
  protocolBootUtxo: CosponsorTypes.OutputReference;
  proposalLifetime: bigint;

  constructor(transactionId: string, index: bigint, proposalLifetime: bigint) {
    this.protocolBootUtxo = {
      transaction_id: transactionId,
      output_index: index,
    };
    this.proposalLifetime = proposalLifetime;
  }

  public script(): PlutusV3Script {
    // Pass the OutputReference directly - it now matches the Type schema
    return new CosponsorTypes.CosponsorStateCosponsorStateMint(
      this.protocolBootUtxo,
      this.proposalLifetime,
    ).Script.asPlutusV3()!;
  }

  public address(network: Core.NetworkId): Core.Address {
    return scriptAddressFromHash(network, this.script().hash());
  }
}
