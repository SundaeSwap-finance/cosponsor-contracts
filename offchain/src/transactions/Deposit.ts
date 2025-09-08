import { Core, Wallet } from "@blaze-cardano/sdk";
import { Blaze } from "@blaze-cardano/sdk";
import { makeValue } from "@blaze-cardano/sdk";
import { Provider } from "@blaze-cardano/sdk";
import { TxBuilder } from "@blaze-cardano/sdk";
import {
  PROPOSAL_LIFETIME,
  PROTOCOL_BOOT_TRANSACTION_ID,
  PROTOCOL_BOOT_TRANSACTION_INDEX,
} from "src/Config";
import { Cosponsor, ICosponsoredProposal } from "src/validators/Cosponsor";
import { CosponsorState } from "src/validators/CosponsorState";

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

  tx.addMint(
    Core.PolicyId(cosponsor.script().hash()),
    new Map<Core.AssetName, bigint>([
      [Core.AssetName(cosponsor.gAda()), depositAmount],
    ]),
  );

  const cosponsorReference = await blaze.provider.resolveScriptRef(
    cosponsor.script().hash(),
  );

  if (!cosponsorReference) {
    throw new Error("Cosponsor script reference not found");
  }

  tx.addReferenceInput(cosponsorReference);

  tx.lockAssets(
    cosponsor.address(blaze.provider.network),
    makeValue(depositAmount),
    cosponsor.datum(),
  );

  tx.setChangeAddress(await blaze.wallet.getChangeAddress());

  return tx;
}
