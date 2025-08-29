use aiken/cbor.{serialise}
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{Address, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use types/cosponsor.{CosponsoredProposalProcedure}
use types/cosponsor_state.{CosponsorStateDatum}

pub fn value_without_lovelace_preserved(
  output1: Output,
  output2: Output,
) -> Bool {
  assets.without_lovelace(output1.value) == assets.without_lovelace(
    output2.value,
  )
}

pub fn proposal_procedure_hash(
  proposal_procedure: CosponsoredProposalProcedure,
) -> ByteArray {
  blake2b_256(serialise(proposal_procedure))
}

pub fn final_validity(transaction: Transaction) -> Int {
  expect Interval {
    upper_bound: IntervalBound { bound_type: Finite(final_validity), .. },
    ..
  } = transaction.validity_range
  final_validity
}

pub fn find_script_inputs(
  inputs: List<Input>,
  script_hash: ByteArray,
) -> List<Input> {
  inputs
    |> list.filter(
        fn(input) {
          let Address { payment_credential, .. } = input.output.address
          when payment_credential is {
            Script(input_script_hash) -> input_script_hash == script_hash
            _ -> False
          }
        },
      )
}

pub fn find_inputs_by_token(
  inputs: List<Input>,
  policy_id: PolicyId,
  asset: AssetName,
) -> List<Input> {
  inputs
    |> list.filter(
        fn(input) {
          ( input.output.value |> assets.quantity_of(policy_id, asset) ) > 0
        },
      )
}

pub fn get_state_datum(
  inputs: List<Input>,
  state_policy_id: PolicyId,
  state_nft: AssetName,
) -> CosponsorStateDatum {
  expect [state_input] =
    find_inputs_by_token(inputs, state_policy_id, state_nft)
  expect InlineDatum(state_input_data) = state_input.output.datum
  expect state_input_datum: CosponsorStateDatum = state_input_data
  state_input_datum
}
