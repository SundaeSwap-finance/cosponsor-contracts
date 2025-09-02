import { PlutusV3Script } from "@blaze-cardano/core";
import { CosponsorTypes } from "./GeneratedTypes";

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
    return new CosponsorTypes.CosponsorStateCosponsorStateMint(
      this.protocolBootUtxo,
      this.proposalLifetime,
    ).Script.asPlutusV3()!;
  }
}
