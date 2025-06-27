use aiken/collection/list
use calculation/cosponsor_state.{mpf_updated_correctly} as cosponsor_state_calculation
use calculation/shared.{final_validity, value_without_lovelace_preserved}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, OutputReference, Transaction, find_input, find_script_outputs,
}
use types/cosponsor_state.{
  CosponsorStateDatum, CosponsorStateRedeemer, cosponsor_state_nft_name,
} as cosponsor_state_types

validator cosponsor_state(
  protocol_boot_utxo: OutputReference,
  proposal_lifetime: Int,
) {
  spend(
    datum_option: Option<CosponsorStateDatum>,
    redeemer: CosponsorStateRedeemer,
    utxo: OutputReference,
    transaction: Transaction,
  ) {
    expect Some(datum) = datum_option
    expect Some(state_input) = find_input(transaction.inputs, utxo)
    expect Address { payment_credential: Script(own_policy_id), .. } =
      state_input.output.address
    expect [state_output] =
      find_script_outputs(transaction.outputs, own_policy_id)

    expect InlineDatum(state_output_data) = state_output.datum
    expect state_output_datum: CosponsorStateDatum = state_output_data

    let final_validity = final_validity(transaction)
    let proposal_expiration = final_validity + proposal_lifetime
    and {
      value_without_lovelace_preserved(state_input.output, state_output)?,
      (list.length(transaction.proposal_procedures) > 0)?,
      (state_input.output.address == state_output.address)?,
      mpf_updated_correctly(
        transaction.proposal_procedures,
        proposal_expiration,
        datum.expired_proposals_mpf_root,
        state_output_datum.expired_proposals_mpf_root,
        redeemer.proof,
        redeemer.anchor_list,
      )?,
    }
  }

  // Let us mint the cosponsor state NFT exactly once, by checking that one of the inputs is the protocol_boot_utxo
  mint(_r: Data, own_policy_id: PolicyId, transaction: Transaction) {
    let expected_mint =
      assets.from_asset(own_policy_id, cosponsor_state_nft_name, 1)
    // Check that we mint *only* one token, and it's exactly our own policy id, and the cosponsor state NFT name
    // This ensures that we don't sneakily mint a second NFT for "reasons"
    let mints_exactly_one_cosponsor_state_nft =
      transaction.mint == expected_mint

    // And, like mentioned above, ensure that this is a true NFT
    let spends_protocol_boot_utxo =
      list.any(
        transaction.inputs,
        fn(input) { input.output_reference == protocol_boot_utxo },
      )

    // Make sure the output value contains no extra tokens, and is paid to the cosponsor state script itself
    expect [cosponsor_state_output] =
      list.filter(
        transaction.outputs,
        fn(output) { assets.without_lovelace(output.value) == expected_mint },
      )
    let pays_to_cosponsor_state_script =
      cosponsor_state_output.address.payment_credential == Script(own_policy_id)
    // Make sure the datum is an inline datum, and has a well-formed datum
    expect InlineDatum(cosponsor_state_datum) = cosponsor_state_output.datum
    expect _: CosponsorStateDatum = cosponsor_state_datum

    and {
      mints_exactly_one_cosponsor_state_nft,
      spends_protocol_boot_utxo,
      pays_to_cosponsor_state_script,
    }
  }

  else(_) {
    fail
  }
}
