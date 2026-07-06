use aiken/cbor.{serialise}
use aiken/collection/dict.{Dict}
use aiken/collection/list
use aiken/crypto
use aiken/merkle_patricia_forestry.{Proof, from_root, has}
use aiken/option
use aiken/primitive/bytearray
use calculation/conversion.{
  convert_extra_signatories, convert_fee, convert_inputs, convert_mint,
  convert_outputs, convert_proposals, convert_reference_inputs, convert_ttl,
  convert_withdrawals, map_header,
}
use calculation/shared.{
  find_script_inputs, get_state_datum, proposal_procedure_hash,
}
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Output, Transaction, find_script_outputs}
use types/cosponsor.{
  After, Before, CosponsorDatum, CosponsoredProposalProcedure,
}

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
  _collateral_inputs: ByteArray,
  _collateral_output: ByteArray,
  _collateral_fee: ByteArray,
) -> Bool {
  let cosponsor_inputs =
    find_script_inputs(transaction.inputs, own_policy_id)
      |> list.map(fn(input) { input.output })
  expect Some(cosponsor_input) = list.head(cosponsor_inputs)
  expect InlineDatum(input_data) = cosponsor_input.datum
  expect input_datum: CosponsorDatum = input_data
  expect Before { cosponsored } = input_datum

  // Every pooled input must fund THIS proposal. Without this check,
  // `cosponsor_ada_map`'s catch-all bucket would let pledges for proposal B
  // be spent into proposal A's submission, stranding B's gADA holders.
  let expected_proposal_hash = proposal_procedure_hash(cosponsored)
  expect
    cosponsor_inputs
      |> list.all(
          fn(output) {
            expect InlineDatum(data) = output.datum
            expect datum: CosponsorDatum = data
            expect Before { cosponsored: input_cosponsored } = datum
            proposal_procedure_hash(input_cosponsored) == expected_proposal_hash
          },
        )

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
      // Pin the leftover output to THIS proposal. `cosponsor_ada_map` keys
      // every output to #"" here (empty expired-map), so the amount/size
      // checks alone would accept a leftover carrying an `After` datum
      // (prematurely redeemable) or a `Before` for a DIFFERENT proposal
      // (routing this pool's surplus to another proposal's gADA holders).
      // Require it to be `Before { cosponsored }` hashing to this proposal.
      expect
        cosponsor_outputs
          |> list.all(
              fn(output) {
                expect InlineDatum(data) = output.datum
                expect datum: CosponsorDatum = data
                expect Before { cosponsored: output_cosponsored } = datum
                proposal_procedure_hash(output_cosponsored) == expected_proposal_hash
              },
            )
      input_ada - cosponsored.procedure.deposit == output_ada
    } else {
      dict.size(output_ada_dict) == 0
    }

  expect [Pair(_script_data_hash, 1)] =
    transaction.mint |> assets.tokens(true_policy_id) |> dict.to_pairs()

  and {
    leftover_ada_preserved?,
    // Bind the pledged governance action directly from the Plutus V3 script
    // context (which exposes `proposal_procedures`) rather than reconstructing
    // and hashing the entire tx body. The body-hash approach required
    // byte-exact canonical CBOR — including canonically-sorted input sets —
    // that cardano-sdk/Blaze does not emit deterministically, so it could
    // never reliably validate. NOTE: the context's `ProposalProcedure` drops
    // the anchor, so the anchor is committed by the gADA token at deposit but
    // not re-verified here. Mainnet gate: decide whether anchor binding is
    // required and, if so, restore a targeted anchor check.
    list.has(transaction.proposal_procedures, cosponsored.procedure)?,
  }
}

// Reconstructs the transaction body CBOR byte-for-byte as
// @blaze-cardano/core serializes it (Conway era) and asserts it hashes to
// the real transaction id. This is what cryptographically ties the pooled
// funds to a transaction that genuinely submits the pledged governance
// action — no other body layout can produce the same id.
//
// Canonical field set (ascending keys):
//   00 inputs · 01 outputs · 02 fee · 03 ttl · 05 withdrawals · 09 mint ·
//   0b script_data_hash · 0d collateral inputs · [0e required signers] ·
//   10 collateral return · 11 total collateral · [12 reference inputs] ·
//   14 proposal_procedures
// 0e/12 are included only when non-empty (the ledger omits empty fields).
// Collateral fields (0d/10/11) are invisible to the script context, so the
// WPropose redeemer supplies their raw bytes.
fn metadata_validation(
  transaction: Transaction,
  proposals: List<CosponsoredProposalProcedure>,
  script_data_hash: ByteArray,
  collateral_inputs: ByteArray,
  collateral_output: ByteArray,
  collateral_fee: ByteArray,
) -> Bool {
  let has_signers = !list.is_empty(transaction.extra_signatories)
  let has_reference_inputs = !list.is_empty(transaction.reference_inputs)

  let field_count =
    11 + if has_signers {
      1
    } else {
      0
    } + if has_reference_inputs {
      1
    } else {
      0
    }

  let extra_signatories_cbor =
    if has_signers {
      #"0e"
        |> bytearray.concat(
            convert_extra_signatories(transaction.extra_signatories),
          )
    } else {
      ""
    }

  let reference_inputs_cbor =
    if has_reference_inputs {
      #"12"
        |> bytearray.concat(
            convert_reference_inputs(transaction.reference_inputs),
          )
    } else {
      ""
    }

  let tx_cbor =
    map_header(field_count)
      |> bytearray.concat(#"00")
      |> bytearray.concat(convert_inputs(transaction.inputs))
      |> bytearray.concat(#"01")
      |> bytearray.concat(convert_outputs(transaction.outputs))
      |> bytearray.concat(#"02")
      |> bytearray.concat(convert_fee(transaction.fee))
      |> bytearray.concat(#"03")
      |> bytearray.concat(convert_ttl(transaction.validity_range))
      |> bytearray.concat(#"05")
      |> bytearray.concat(convert_withdrawals(transaction.withdrawals))
      |> bytearray.concat(#"09")
      |> bytearray.concat(convert_mint(transaction.mint))
      |> bytearray.concat(#"0b")
      |> bytearray.concat(serialise(script_data_hash))
      |> bytearray.concat(#"0d")
      |> bytearray.concat(collateral_inputs)
      |> bytearray.concat(extra_signatories_cbor)
      |> bytearray.concat(#"10")
      |> bytearray.concat(collateral_output)
      |> bytearray.concat(#"11")
      |> bytearray.concat(collateral_fee)
      |> bytearray.concat(reference_inputs_cbor)
      |> bytearray.concat(#"14")
      |> bytearray.concat(convert_proposals(proposals))

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
                      let procedure_hash = proposal_procedure_hash(cosponsored)
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

  let input_ada_dict = dict.union_with(input_ada_dict, burned_gada_dict, sum)
  let no_ada_leak =
    input_ada_dict
      |> dict.keys()
      |> list.all(
          fn(key) {
            dict.get(input_ada_dict, key) == Some(
              option.or_else(dict.get(output_ada_dict, key), 0),
            )
          },
        )

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
                let procedure_hash = proposal_procedure_hash(cosponsored)
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
