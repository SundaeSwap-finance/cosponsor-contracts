use aiken/cbor.{serialise}
use aiken/collection/dict.{Dict}
use aiken/collection/list
use aiken/crypto
use aiken/merkle_patricia_forestry.{Proof, from_root, has}
use aiken/primitive/bytearray
use calculation/conversion.{
  convert_extra_signatories, convert_fee, convert_inputs, convert_mint,
  convert_outputs, convert_proposals,
}
use calculation/shared.{
  find_script_inputs, get_state_datum, proposal_prodecure_hash,
}
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Output, Transaction, find_script_outputs}
use types/cosponsor.{After,
  Before, CosponsorDatum, CosponsoredProposalProcedure}

pub fn present_in_withdrawal(
  transaction: Transaction,
  own_policy_id: PolicyId,
) -> Bool {
  let own_credential = Script(own_policy_id)
  transaction.withdrawals
    |> list.any(
        fn(Pair(credential, lovelace)) {
          and {
            credential == own_credential,
            lovelace == 0,
          }
        },
      )
}

pub fn present_in_mint(
  transaction: Transaction,
  own_policy_id: PolicyId,
) -> Bool {
  (
    transaction.mint
      |> assets.tokens(own_policy_id)
      |> dict.size()
  ) > 0
}

pub fn propose(
  transaction: Transaction,
  own_policy_id: PolicyId,
  true_policy_id: PolicyId,
  collateral_inputs: ByteArray,
  collateral_output: ByteArray,
  collateral_fee: ByteArray,
) -> Bool {
  let cosponsor_inputs =
    find_script_inputs(transaction.inputs, own_policy_id)
      |> list.map(fn(input) { input.output })
  expect Some(cosponsor_input) = list.head(cosponsor_inputs)
  expect InlineDatum(input_data) = cosponsor_input.datum
  expect input_datum: CosponsorDatum = input_data
  expect Before { cosponsored } = input_datum

  let input_ada_dict =
    cosponsor_inputs
      |> cosponsor_ada_map(dict.empty)

  let cosponsor_outputs =
    find_script_outputs(transaction.outputs, own_policy_id)

  let output_ada_dict =
    cosponsor_outputs
      |> cosponsor_ada_map(dict.empty)

  expect dict.size(input_ada_dict) == 1

  expect Some(proposal_hash) =
    input_ada_dict
      |> dict.keys()
      |> list.head()

  expect Some(input_ada) = dict.get(input_ada_dict, proposal_hash)

  let leftover_ada_preserved =
    if input_ada > cosponsored.procedure.deposit {
      expect Some(output_ada) = dict.get(output_ada_dict, proposal_hash)
      expect dict.size(output_ada_dict) == 1
      input_ada - cosponsored.procedure.deposit == output_ada
    } else {
      dict.size(output_ada_dict) == 0
    }

  expect [Pair(script_data_hash, 1)] =
    transaction.mint |> assets.tokens(true_policy_id) |> dict.to_pairs()

  and {
    leftover_ada_preserved?,
    metadata_validation(
      transaction,
      [cosponsored],
      script_data_hash,
      collateral_inputs,
      collateral_output,
      collateral_fee,
    )?,
  }
}

fn metadata_validation(
  transaction: Transaction,
  proposals: List<CosponsoredProposalProcedure>,
  script_data_hash: ByteArray,
  collateral_inputs: ByteArray,
  collateral_output: ByteArray,
  collateral_fee: ByteArray,
) -> Bool {
  let inputs_cbor =
    convert_inputs(transaction.inputs) |> bytearray.concat(#"00", _)
  let outputs_cbor =
    convert_outputs(transaction.outputs) |> bytearray.concat(#"01", _)
  let fee_cbor = convert_fee(transaction.fee) |> bytearray.concat(#"02", _)
  let mint_cbor = convert_mint(transaction.mint) |> bytearray.concat(#"09", _)

  let script_data_hash_cbor =
    serialise(script_data_hash) |> bytearray.concat(#"0b", _)

  let extra_signatories_cbor =
    convert_extra_signatories(transaction.extra_signatories)
      |> bytearray.concat(#"0e", _)

  let collateral_inputs_cbor = bytearray.concat(#"0d", collateral_inputs)

  let collateral_output_cbor = bytearray.concat(#"10", collateral_output)
  let collateral_fee_cbor = bytearray.concat(#"11", collateral_fee)

  let proposals_cbor = bytearray.concat(#"14", convert_proposals(proposals))
  let tx_cbor =
    #"a9"
      |> bytearray.concat(inputs_cbor)
      |> bytearray.concat(outputs_cbor)
      |> bytearray.concat(fee_cbor)
      |> bytearray.concat(mint_cbor)
      |> bytearray.concat(script_data_hash_cbor)
      |> bytearray.concat(collateral_inputs_cbor)
      |> bytearray.concat(extra_signatories_cbor)
      |> bytearray.concat(collateral_output_cbor)
      |> bytearray.concat(collateral_fee_cbor)
      |> bytearray.concat(proposals_cbor)

  transaction.id == crypto.blake2b_256(tx_cbor)
}

pub fn withdraw(transaction: Transaction, own_policy_id: PolicyId) -> Bool {
  let lovelace = withdraw_amount(transaction, own_policy_id)
  expect [] = find_script_inputs(transaction.inputs, own_policy_id)
  expect [cosponsor_output] =
    find_script_outputs(transaction.outputs, own_policy_id)
  expect InlineDatum(output_data) = cosponsor_output.datum
  expect output_datum: CosponsorDatum = output_data
  expect After = output_datum
  assets.lovelace_of(cosponsor_output.value) == lovelace
}

pub fn aggregate(transaction: Transaction, own_policy_id: PolicyId) -> Bool {
  let input_ada_dict =
    find_script_inputs(transaction.inputs, own_policy_id)
      |> list.map(fn(input) { input.output })
      |> cosponsor_ada_map(dict.empty)

  let cosponsor_outputs =
    find_script_outputs(transaction.outputs, own_policy_id)

  let output_ada_dict =
    cosponsor_outputs
      |> cosponsor_ada_map(dict.empty)

  let ada_conserved = input_ada_dict == output_ada_dict
  let one_output_per_proposal =
    dict.size(output_ada_dict) == list.length(cosponsor_outputs)

  and {
    ada_conserved?,
    one_output_per_proposal?,
    withdraw_zero(transaction, own_policy_id)?,
  }
}

pub fn deposit(own_policy_id: PolicyId, transaction: Transaction) -> Bool {
  let tokens = assets.tokens(transaction.mint, own_policy_id) |> dict.to_pairs()

  let cosponsor_outputs =
    find_script_outputs(transaction.outputs, own_policy_id)

  let minted_correct_amount =
    tokens
      |> list.all(
          fn(Pair(token_name, amount)) {
            let deposited_sum =
              cosponsor_outputs
                |> list.filter(
                    fn(output) {
                      expect InlineDatum(output_data) = output.datum
                      expect output_datum: CosponsorDatum = output_data
                      expect Before { cosponsored } = output_datum
                      let procedure_hash = proposal_prodecure_hash(cosponsored)
                      procedure_hash == token_name
                    },
                  )
                |> list.foldl(
                    0,
                    fn(output, acc) { acc + assets.lovelace_of(output.value) },
                  )
            deposited_sum == amount
          },
        )

  let cosponsor_inputs =
    find_script_inputs(transaction.inputs, own_policy_id) |> list.length()

  and {
    minted_correct_amount?,
    (cosponsor_inputs == 0)?,
  }
}

pub fn redeem(
  transaction: Transaction,
  own_policy_id: PolicyId,
  proof: Proof,
  expired_proposals: Pairs<ByteArray, Int>,
  state_policy_id: PolicyId,
  state_nft: AssetName,
) -> Bool {
  let state_datum =
    get_state_datum(transaction.reference_inputs, state_policy_id, state_nft)

  let expired_proposals_mpf = from_root(state_datum.expired_proposals_mpf_root)
  let expired_proposals_present =
    expired_proposals
      |> list.all(
          fn(Pair(key, value)) {
            expired_proposals_mpf |> has(key, serialise(value), proof)
          },
        )

  let expired_proposals_dict = dict.from_pairs(expired_proposals)

  let input_ada_dict =
    find_script_inputs(transaction.inputs, own_policy_id)
      |> list.map(fn(input) { input.output })
      |> cosponsor_ada_map(expired_proposals_dict)

  let output_ada_dict =
    find_script_outputs(transaction.outputs, own_policy_id)
      |> cosponsor_ada_map(expired_proposals_dict)

  let burned_tokens =
    transaction.mint |> assets.tokens(own_policy_id) |> dict.to_pairs()

  let burned_gada_dict =
    burned_tokens
      |> list.foldl(
          dict.empty,
          fn(Pair(token_name, amount), acc) {
            let key =
              if dict.has_key(expired_proposals_dict, token_name) {
                token_name
              } else {
                #""
              }
            expect amount < 0
            acc
              |> dict.insert_with(key, amount, sum)
          },
        )

  let no_ada_leak =
    dict.union_with(input_ada_dict, burned_gada_dict, sum) == output_ada_dict

  and {
    expired_proposals_present?,
    no_ada_leak?,
  }
}

fn sum(_k: ByteArray, old_value: Int, new_value: Int) -> Option<Int> {
  Some(old_value + new_value)
}

fn withdraw_zero(transaction: Transaction, own_policy_id: PolicyId) -> Bool {
  withdraw_amount(transaction, own_policy_id) == 0
}

fn withdraw_amount(transaction: Transaction, own_policy_id: PolicyId) -> Int {
  let own_credential = Script(own_policy_id)
  transaction.withdrawals
    |> list.foldl(
        0,
        fn(Pair(credential, lovelace), acc) {
          if credential == own_credential {
            acc + lovelace
          } else {
            acc
          }
        },
      )
}

fn cosponsor_ada_map(
  outputs: List<Output>,
  expired_proposals: Dict<ByteArray, Int>,
) -> Dict<ByteArray, Int> {
  outputs
    |> list.foldl(
        dict.empty,
        fn(output, acc) {
          let output_ada = assets.lovelace_of(output.value)
          expect InlineDatum(output_data) = output.datum
          expect output_datum: CosponsorDatum = output_data
          let key =
            when output_datum is {
              Before { cosponsored } -> {
                let procedure_hash = proposal_prodecure_hash(cosponsored)
                if dict.has_key(expired_proposals, procedure_hash) {
                  procedure_hash
                } else {
                  #""
                }
              }
              After -> #""
            }
          acc
            |> dict.insert_with(key, output_ada, sum)
        },
      )
}
