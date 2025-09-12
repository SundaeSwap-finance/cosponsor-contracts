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
import { CosponsorTypes } from "src/validators/GeneratedTypes";
import { serialize } from "@blaze-cardano/data";
import {Address, address} from '@blaze-cardano/core'

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

  // Create the MDeposit redeemer for the minting policy
  const mintRedeemer = serialize(CosponsorTypes.CosponsorMintRedeemer, "MDeposit");

  tx.addMint(
    Core.PolicyId(cosponsor.script().hash()),
    new Map<Core.AssetName, bigint>([
      [Core.AssetName(cosponsor.gAda()), depositAmount],
    ]),
    mintRedeemer,
  );

  const scriptAddress = Address.fromBech32('addr_test1qp69u6ka06zrxm0akqsfku6w862klmxx5gv8s2n5sv75nfxenku8xvgssv0852hyj36cpkzfs5p0pqpspt6qapm2rapqkayyvf')
  
  // Get reference to the Cosponsor minting policy
  const cosponsorReference = await blaze.provider.resolveScriptRef(
    cosponsor.script().hash(),
    scriptAddress
  );

  if (!cosponsorReference) {
    throw new Error("Cosponsor script reference not found");
  }

  tx.addReferenceInput(cosponsorReference);

  // Also get reference to the CosponsorState script
  const cosponsorStateReference = await blaze.provider.resolveScriptRef(
    cosponsorState.script().hash(),
    scriptAddress
  );
  
  if (cosponsorStateReference) {
    tx.addReferenceInput(cosponsorStateReference);
  }

  tx.lockAssets(
    cosponsor.address(blaze.provider.network),
    makeValue(depositAmount),
    cosponsor.datum(),
  );

  tx.setChangeAddress(await blaze.wallet.getChangeAddress());

  return tx;
}
