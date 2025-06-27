use calculation/cosponsor.{
  aggregate, deposit, present_in_mint, present_in_withdrawal, propose, redeem,
  withdraw,
} as cosponsor_calculation
use cardano/address.{Address, Credential, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction, find_input}
use types/cosponsor.{
  CosponsorMintRedeemer, CosponsorWithdrawRedeemer, MDeposit, MRedeem,
  WAggregate, WPropose, WWithdraw,
} as cosponsor_types

//TODO: Add logic to prevent adding tokens to cosponsor utxos
validator cosponsor(
  state_policy_id: PolicyId,
  state_nft: ByteArray,
  true_policy_id: PolicyId,
) {
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    utxo: OutputReference,
    transaction: Transaction,
  ) {
    expect Some(self) = find_input(transaction.inputs, utxo)
    expect Address { payment_credential: Script(own_policy_id), .. } =
      self.output.address

    or {
      present_in_mint(transaction, own_policy_id),
      present_in_withdrawal(transaction, own_policy_id),
    }
  }

  mint(
    redeemer: CosponsorMintRedeemer,
    own_policy_id: PolicyId,
    transaction: Transaction,
  ) {
    when redeemer is {
      MDeposit -> deposit(own_policy_id, transaction)
      MRedeem { proof, expired_proposals } ->
        redeem(
          transaction,
          own_policy_id,
          proof,
          expired_proposals,
          state_policy_id,
          state_nft,
        )
    }
  }

  withdraw(
    redeemer: CosponsorWithdrawRedeemer,
    account: Credential,
    self: Transaction,
  ) {
    expect Script(own_policy_id) = account
    when redeemer is {
      WAggregate -> aggregate(self, own_policy_id)
      WPropose { collateral_inputs, collateral_output, collateral_fee } ->
        propose(
          self,
          own_policy_id,
          true_policy_id,
          collateral_inputs,
          collateral_output,
          collateral_fee,
        )
      WWithdraw -> withdraw(self, own_policy_id)
    }
  }

  else(_) {
    fail
  }
}
