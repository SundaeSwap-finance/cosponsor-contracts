//// Phase-0 proof gate for the WPropose path.
////
//// Each test asserts that the on-chain body reconstruction (or one of its
//// converters in `calculation/conversion`) reproduces the exact bytes a
//// node-accepted Conway transaction body contains. Golden vectors were
//// generated with @blaze-cardano/core (cardano-sdk serialization, Conway
//// era, tag-258 sets) — the same serializer every SDK-built transaction
//// goes through.
////
//// EXPECTED RESULT TODAY: every test in this file FAILS. That failure is
//// the empirical confirmation that the deployed WPropose reconstruction
//// cannot match any real submittable transaction:
////
////   1. `metadata_validation` opens with #"a9" (map of 9) but appends 10
////      fields — and a real propose tx needs 12+ (withdrawals + ttl are
////      mandatory for the withdraw-purpose redeemer / state validator).
////   2. `convert_inputs` drops the 0x5820 bytestring header on tx ids and
////      the Conway tag-258 set wrapper.
////   3. `convert_outputs` emits pre-Babbage array outputs, which cannot
////      carry the inline datum the leftover output requires.
////   4. `convert_proposal` emits PlutusData constructor encodings where
////      the ledger CDDL demands reward-account bytes / gov-action arrays.
////   5. `convert_extra_signatories` drops the tag-258 set wrapper.
////
//// Phase 1 rewrites `conversion.ak` / `metadata_validation` until this
//// file passes; it then doubles as the acceptance suite for the canonical
//// body layout the SDK builder must produce.

use aiken/cbor
use aiken/crypto.{blake2b_256}
use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/primitive/bytearray
use calculation/conversion.{
  convert_extra_signatories, convert_inputs, convert_outputs, convert_proposals,
}
use calculation/cosponsor as cosponsor_calc
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/governance.{GovernanceAction, ProposalProcedure}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use tests/shared.{cosponsor_validator_hash, true_policy_id} as tshared
use types/cosponsor.{Anchor, CosponsorDatum, CosponsoredProposalProcedure}

// ---------------------------------------------------------------------------
// Fixture constants (all deterministic)
// ---------------------------------------------------------------------------

const user_key_hash: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const signer_key_hash: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const txid_cosponsor: ByteArray =
  #"1111111111111111111111111111111111111111111111111111111111111111"

const txid_user: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"

const txid_collateral: ByteArray =
  #"5555555555555555555555555555555555555555555555555555555555555555"

const script_data_hash_fx: ByteArray =
  #"4444444444444444444444444444444444444444444444444444444444444444"

const anchor_hash_fx: ByteArray =
  #"2222222222222222222222222222222222222222222222222222222222222222"

// The cosponsored proposal: 1 ADA info action, deposit refund routed back to
// the cosponsor script itself (mirrors BrowserDeposit's returnAddress).
fn fixture_cpp() -> CosponsoredProposalProcedure {
  CosponsoredProposalProcedure {
    procedure: ProposalProcedure {
      deposit: 1_000_000,
      return_address: Script(cosponsor_validator_hash),
      governance_action: GovernanceAction.NicePoll,
    },
    anchor: Anchor { url: @"https://x", hash: anchor_hash_fx },
  }
}

fn user_address() -> Address {
  Address {
    payment_credential: VerificationKey(user_key_hash),
    stake_credential: None,
  }
}

fn cosponsor_address() -> Address {
  Address {
    payment_credential: Script(cosponsor_validator_hash),
    stake_credential: None,
  }
}

// ---------------------------------------------------------------------------
// Golden vectors — ledger-CDDL bytes as @blaze-cardano/core emits them
// ---------------------------------------------------------------------------

// Conway set of one input: tag 258, [txid (0x5820-headed bytes32), index]
test proof_inputs_encode_to_ledger_cddl() {
  let input =
    Input {
      output_reference: OutputReference {
        transaction_id: txid_cosponsor,
        output_index: 0,
      },
      output: Output {
        address: user_address(),
        value: assets.from_lovelace(1),
        datum: NoDatum,
        reference_script: None,
      },
    }
  let expected =
    #"d9010281825820"
      |> bytearray.concat(txid_cosponsor)
      |> bytearray.concat(#"00")
  convert_inputs([input]) == expected
}

// Babbage map-form output carrying an inline datum (PlutusData int 42):
// { 0: address, 1: coin, 2: [1, #6.24(bytes .cbor plutus_data)] }
// Verified verbatim against @blaze-cardano/core TransactionOutput.toCbor().
test proof_outputs_encode_to_ledger_cddl() {
  let datum_value: Data = 42
  let output =
    Output {
      address: cosponsor_address(),
      value: assets.from_lovelace(1_000_000),
      datum: InlineDatum(datum_value),
      reference_script: None,
    }
  let expected =
    #"81a300581d70"
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"011a000f4240028201d81842182a")
  convert_outputs([output]) == expected
}

// Conway set of one required-signer key hash: tag 258, 0x581c-headed bytes28.
test proof_extra_signatories_encode_to_ledger_cddl() {
  let expected = #"d9010281581c" |> bytearray.concat(signer_key_hash)
  convert_extra_signatories([signer_key_hash]) == expected
}

// Conway nonempty_set of one proposal_procedure:
//   [deposit, reward_account (0xf0-prefixed script bytes on testnet),
//    gov_action ([6] = info action), anchor [url_text, bytes32]]
test proof_proposals_encode_to_ledger_cddl() {
  // Explicit assembly (kept flat so each ledger field is auditable):
  //   d90102 81            -- tag 258, array(1)
  //   84                   -- proposal_procedure = array(4)
  //   1a000f4240           -- deposit = 1_000_000
  //   581d f0 <hash28>     -- reward_account: testnet script stake address
  //   8106                 -- gov_action = [6] (info action)
  //   82 69 <"https://x"> 5820 <hash32>  -- anchor
  let expected =
    #"d9010281841a000f4240581df0"
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"810682")
      |> bytearray.concat(#"6968747470733a2f2f78")
      |> bytearray.concat(#"5820")
      |> bytearray.concat(anchor_hash_fx)
  convert_proposals([fixture_cpp()]) == expected
}

// ---------------------------------------------------------------------------
// Integrated proof: a semantically valid propose transaction whose id is the
// blake2b-256 of its true Conway body must satisfy propose().
// ---------------------------------------------------------------------------

// The canonical body of the fixture transaction, byte-for-byte as
// @blaze-cardano/core would serialize it (Conway era). 12 fields:
// 00 inputs, 01 outputs, 02 fee, 03 ttl, 05 withdrawals, 09 mint,
// 0b script_data_hash, 0d collateral inputs, 0e required signers,
// 10 collateral return, 11 total collateral, 14 proposal_procedures.
fn canonical_body() -> ByteArray {
  let f_inputs =
    // tag 258 set of 2: cosponsor UTxO + user fee input
    #"00d9010282825820"
      |> bytearray.concat(txid_cosponsor)
      |> bytearray.concat(#"00825820")
      |> bytearray.concat(txid_user)
      |> bytearray.concat(#"00")
  let f_outputs =
    // array(1): legacy-form user change output (no datum): [addr, 5_000_000]
    #"018182581d60"
      |> bytearray.concat(user_key_hash)
      |> bytearray.concat(#"1a004c4b40")
  let f_fee = #"021a00030d40"
  let f_ttl = #"031903e8"
  let f_withdrawals =
    // { reward_account(script, testnet): 0 } — the withdraw-zero trick
    #"05a1581df0"
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"00")
  let f_mint =
    // { true_policy: { script_data_hash_token: 1 } }
    #"09a1581c"
      |> bytearray.concat(true_policy_id)
      |> bytearray.concat(#"a15820")
      |> bytearray.concat(script_data_hash_fx)
      |> bytearray.concat(#"01")
  let f_script_data_hash = #"0b5820" |> bytearray.concat(script_data_hash_fx)
  let f_collateral_inputs = #"0d" |> bytearray.concat(collateral_inputs_bytes())
  let f_required_signers =
    #"0ed9010281581c" |> bytearray.concat(signer_key_hash)
  let f_collateral_return = #"10" |> bytearray.concat(collateral_return_bytes())
  let f_total_collateral = #"111a000f4240"
  let f_proposals =
    #"14d9010281841a000f4240581df0"
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"8106826968747470733a2f2f785820")
      |> bytearray.concat(anchor_hash_fx)

  #"ac"
    |> bytearray.concat(f_inputs)
    |> bytearray.concat(f_outputs)
    |> bytearray.concat(f_fee)
    |> bytearray.concat(f_ttl)
    |> bytearray.concat(f_withdrawals)
    |> bytearray.concat(f_mint)
    |> bytearray.concat(f_script_data_hash)
    |> bytearray.concat(f_collateral_inputs)
    |> bytearray.concat(f_required_signers)
    |> bytearray.concat(f_collateral_return)
    |> bytearray.concat(f_total_collateral)
    |> bytearray.concat(f_proposals)
}

// The three redeemer-supplied byte fields (WPropose carries these verbatim).
fn collateral_inputs_bytes() -> ByteArray {
  #"d9010281825820"
    |> bytearray.concat(txid_collateral)
    |> bytearray.concat(#"00")
}

fn collateral_return_bytes() -> ByteArray {
  // legacy-form output: [user address, 2_000_000]
  #"82581d60"
    |> bytearray.concat(user_key_hash)
    |> bytearray.concat(#"1a001e8480")
}

fn collateral_fee_bytes() -> ByteArray {
  #"1a000f4240"
}

// Same fixture, but with a pooled surplus: 2 ADA in, 1 ADA deposit, so the
// leftover 1 ADA must return to the script under a Before datum — this
// exercises the map-form inline-datum output encoding with the real
// CosponsorDatum bytes (and the multi-byte 0x58 length header).
test proof_propose_preserves_leftover_at_script() {
  let cpp = fixture_cpp()
  let leftover_datum: Data = CosponsorDatum.Before { cosponsored: cpp }
  let datum_bytes = cbor.serialise(leftover_datum)
  let datum_len = bytearray.length(datum_bytes)
  // bytes_header for the wrapped datum (fixture datum is 24..255 bytes)
  expect datum_len >= 24 && datum_len <= 255
  let leftover_output_cbor =
    #"a300581d70"
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"011a000f4240028201d81858")
      |> bytearray.concat(bytearray.from_int_big_endian(datum_len, 1))
      |> bytearray.concat(datum_bytes)
  let f_outputs =
    #"0182"
      |> bytearray.concat(leftover_output_cbor)
      |> bytearray.concat(#"82581d60")
      |> bytearray.concat(user_key_hash)
      |> bytearray.concat(#"1a004c4b40")

  let body =
    #"ac00d9010282825820"
      |> bytearray.concat(txid_cosponsor)
      |> bytearray.concat(#"00825820")
      |> bytearray.concat(txid_user)
      |> bytearray.concat(#"00")
      |> bytearray.concat(f_outputs)
      |> bytearray.concat(#"021a00030d40031903e805a1581df0")
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"0009a1581c")
      |> bytearray.concat(true_policy_id)
      |> bytearray.concat(#"a15820")
      |> bytearray.concat(script_data_hash_fx)
      |> bytearray.concat(#"010b5820")
      |> bytearray.concat(script_data_hash_fx)
      |> bytearray.concat(#"0d")
      |> bytearray.concat(collateral_inputs_bytes())
      |> bytearray.concat(#"0ed9010281581c")
      |> bytearray.concat(signer_key_hash)
      |> bytearray.concat(#"10")
      |> bytearray.concat(collateral_return_bytes())
      |> bytearray.concat(#"111a000f424014d9010281841a000f4240581df0")
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"8106826968747470733a2f2f785820")
      |> bytearray.concat(anchor_hash_fx)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: txid_cosponsor,
            output_index: 0,
          },
          output: Output {
            address: cosponsor_address(),
            value: assets.from_lovelace(2_000_000),
            datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
            reference_script: None,
          },
        },
        Input {
          output_reference: OutputReference {
            transaction_id: txid_user,
            output_index: 0,
          },
          output: Output {
            address: user_address(),
            value: assets.from_lovelace(10_000_000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: cosponsor_address(),
          value: assets.from_lovelace(1_000_000),
          datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
          reference_script: None,
        },
        Output {
          address: user_address(),
          value: assets.from_lovelace(5_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      fee: 200_000,
      mint: assets.from_asset(true_policy_id, script_data_hash_fx, 1),
      withdrawals: [Pair(Script(cosponsor_validator_hash), 0)],
      extra_signatories: [signer_key_hash],
      validity_range: Interval {
        lower_bound: IntervalBound { bound_type: Finite(0), is_inclusive: True },
        upper_bound: IntervalBound {
          bound_type: Finite(1000),
          is_inclusive: True,
        },
      },
      proposal_procedures: [cpp.procedure],
      id: blake2b_256(body),
    }

  cosponsor_calc.propose(
    tx,
    cosponsor_validator_hash,
    true_policy_id,
    collateral_inputs_bytes(),
    collateral_return_bytes(),
    collateral_fee_bytes(),
  )
}

// Cross-proposal attack: a second pooled input pledged to a DIFFERENT
// proposal is spent into this submission. The per-input datum-hash check
// must abort validation.
test attack_mixed_proposal_inputs_rejected() fail {
  let cpp = fixture_cpp()
  let other_cpp =
    CosponsoredProposalProcedure {
      ..fixture_cpp(),
      anchor: Anchor {
        url: @"https://y",
        hash: #"9999999999999999999999999999999999999999999999999999999999999999",
      },
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: txid_cosponsor,
            output_index: 0,
          },
          output: Output {
            address: cosponsor_address(),
            value: assets.from_lovelace(500_000),
            datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
            reference_script: None,
          },
        },
        Input {
          output_reference: OutputReference {
            transaction_id: txid_user,
            output_index: 0,
          },
          output: Output {
            address: cosponsor_address(),
            value: assets.from_lovelace(500_000),
            datum: InlineDatum(CosponsorDatum.Before { cosponsored: other_cpp }),
            reference_script: None,
          },
        },
      ],
      outputs: [],
      fee: 200_000,
      mint: assets.from_asset(true_policy_id, script_data_hash_fx, 1),
      withdrawals: [Pair(Script(cosponsor_validator_hash), 0)],
      extra_signatories: [signer_key_hash],
      proposal_procedures: [cpp.procedure],
      id: blake2b_256(canonical_body()),
    }

  cosponsor_calc.propose(
    tx,
    cosponsor_validator_hash,
    true_policy_id,
    collateral_inputs_bytes(),
    collateral_return_bytes(),
    collateral_fee_bytes(),
  )
}

// Tampered submission: the transaction's REAL body carries a different
// proposal (deposit 999) than the one the pledges were made for. The
// reconstruction hashes the pledged action, so the id can never match.
test attack_submitting_unpledged_action_rejected() {
  let cpp = fixture_cpp()
  let tampered_body =
    // canonical_body() with the proposal deposit swapped 1a000f4240 -> 1903e7
    #"ac00d9010282825820"
      |> bytearray.concat(txid_cosponsor)
      |> bytearray.concat(#"00825820")
      |> bytearray.concat(txid_user)
      |> bytearray.concat(#"00018182581d60")
      |> bytearray.concat(user_key_hash)
      |> bytearray.concat(#"1a004c4b40021a00030d40031903e805a1581df0")
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"0009a1581c")
      |> bytearray.concat(true_policy_id)
      |> bytearray.concat(#"a15820")
      |> bytearray.concat(script_data_hash_fx)
      |> bytearray.concat(#"010b5820")
      |> bytearray.concat(script_data_hash_fx)
      |> bytearray.concat(#"0d")
      |> bytearray.concat(collateral_inputs_bytes())
      |> bytearray.concat(#"0ed9010281581c")
      |> bytearray.concat(signer_key_hash)
      |> bytearray.concat(#"10")
      |> bytearray.concat(collateral_return_bytes())
      |> bytearray.concat(#"111a000f424014d90102818419")
      |> bytearray.concat(#"03e7581df0")
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"8106826968747470733a2f2f785820")
      |> bytearray.concat(anchor_hash_fx)

  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: txid_cosponsor,
            output_index: 0,
          },
          output: Output {
            address: cosponsor_address(),
            value: assets.from_lovelace(1_000_000),
            datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
            reference_script: None,
          },
        },
        Input {
          output_reference: OutputReference {
            transaction_id: txid_user,
            output_index: 0,
          },
          output: Output {
            address: user_address(),
            value: assets.from_lovelace(10_000_000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: user_address(),
          value: assets.from_lovelace(5_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      fee: 200_000,
      mint: assets.from_asset(true_policy_id, script_data_hash_fx, 1),
      withdrawals: [Pair(Script(cosponsor_validator_hash), 0)],
      extra_signatories: [signer_key_hash],
      validity_range: Interval {
        lower_bound: IntervalBound { bound_type: Finite(0), is_inclusive: True },
        upper_bound: IntervalBound {
          bound_type: Finite(1000),
          is_inclusive: True,
        },
      },
      id: blake2b_256(tampered_body),
    }

  !cosponsor_calc.propose(
    tx,
    cosponsor_validator_hash,
    true_policy_id,
    collateral_inputs_bytes(),
    collateral_return_bytes(),
    collateral_fee_bytes(),
  )
}

test proof_propose_accepts_canonical_conway_body() {
  let cpp = fixture_cpp()
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: txid_cosponsor,
            output_index: 0,
          },
          output: Output {
            address: cosponsor_address(),
            value: assets.from_lovelace(1_000_000),
            datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
            reference_script: None,
          },
        },
        Input {
          output_reference: OutputReference {
            transaction_id: txid_user,
            output_index: 0,
          },
          output: Output {
            address: user_address(),
            value: assets.from_lovelace(10_000_000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: user_address(),
          value: assets.from_lovelace(5_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      fee: 200_000,
      mint: assets.from_asset(true_policy_id, script_data_hash_fx, 1),
      withdrawals: [Pair(Script(cosponsor_validator_hash), 0)],
      extra_signatories: [signer_key_hash],
      validity_range: Interval {
        lower_bound: IntervalBound { bound_type: Finite(0), is_inclusive: True },
        upper_bound: IntervalBound {
          bound_type: Finite(1000),
          is_inclusive: True,
        },
      },
      proposal_procedures: [cpp.procedure],
      id: blake2b_256(canonical_body()),
    }

  cosponsor_calc.propose(
    tx,
    cosponsor_validator_hash,
    true_policy_id,
    collateral_inputs_bytes(),
    collateral_return_bytes(),
    collateral_fee_bytes(),
  )
}

// ---------------------------------------------------------------------------
// Leftover-output pinning (finding 2026-07-03): the surplus above the deposit
// must return to the script as `Before { cosponsored }` for THIS proposal.
// Both attacks abort in the `leftover_ada_preserved` branch, before
// metadata_validation — so the tx id / body need not be canonical.
// ---------------------------------------------------------------------------

fn other_cpp() -> CosponsoredProposalProcedure {
  CosponsoredProposalProcedure {
    ..fixture_cpp(),
    anchor: Anchor {
      url: @"https://y",
      hash: #"9999999999999999999999999999999999999999999999999999999999999999",
    },
  }
}

// Surplus routed into a Before UTxO labeled as a DIFFERENT proposal — would
// hand this pool's surplus to proposal B's gADA holders. Must be rejected.
test attack_leftover_routed_to_other_proposal_rejected() fail {
  let cpp = fixture_cpp()
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: txid_cosponsor,
            output_index: 0,
          },
          output: Output {
            address: cosponsor_address(),
            value: assets.from_lovelace(2_000_000),
            datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: cosponsor_address(),
          value: assets.from_lovelace(1_000_000),
          datum: InlineDatum(CosponsorDatum.Before { cosponsored: other_cpp() }),
          reference_script: None,
        },
      ],
      mint: assets.from_asset(true_policy_id, script_data_hash_fx, 1),
      withdrawals: [Pair(Script(cosponsor_validator_hash), 0)],
      extra_signatories: [signer_key_hash],
      proposal_procedures: [cpp.procedure],
      id: blake2b_256(canonical_body()),
    }

  cosponsor_calc.propose(
    tx,
    cosponsor_validator_hash,
    true_policy_id,
    collateral_inputs_bytes(),
    collateral_return_bytes(),
    collateral_fee_bytes(),
  )
}

// Surplus routed into an `After` UTxO — prematurely redeemable before the
// proposal resolves. Must be rejected (leftover must be `Before`).
test attack_leftover_as_after_datum_rejected() fail {
  let cpp = fixture_cpp()
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: OutputReference {
            transaction_id: txid_cosponsor,
            output_index: 0,
          },
          output: Output {
            address: cosponsor_address(),
            value: assets.from_lovelace(2_000_000),
            datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: cosponsor_address(),
          value: assets.from_lovelace(1_000_000),
          datum: InlineDatum(CosponsorDatum.After),
          reference_script: None,
        },
      ],
      mint: assets.from_asset(true_policy_id, script_data_hash_fx, 1),
      withdrawals: [Pair(Script(cosponsor_validator_hash), 0)],
      extra_signatories: [signer_key_hash],
      proposal_procedures: [cpp.procedure],
      id: blake2b_256(canonical_body()),
    }

  cosponsor_calc.propose(
    tx,
    cosponsor_validator_hash,
    true_policy_id,
    collateral_inputs_bytes(),
    collateral_return_bytes(),
    collateral_fee_bytes(),
  )
}

// ---------------------------------------------------------------------------
// TEST_WITHDRAWAL_1 golden cross-lock: a TreasuryWithdrawal (10 tADA to a test
// beneficiary) must encode byte-identically on the Aiken side (convert_proposals)
// and the SDK side (encodeProposalProcedures in offchain/src/utils/proposeBody.ts).
// The hex below was produced by the SDK; this test asserts the validator agrees.
// Without this, TreasuryWithdrawal's proposal_procedures encoding is only unit-
// tested per-side, never cross-verified — a 1-byte drift breaks the propose tx id.
// ---------------------------------------------------------------------------
test golden_treasury_withdrawal_matches_sdk() {
  let benef_hash = #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  let cpp =
    CosponsoredProposalProcedure {
      procedure: ProposalProcedure {
        deposit: 1_000_000,
        return_address: Script(cosponsor_validator_hash),
        governance_action: GovernanceAction.TreasuryWithdrawal {
          beneficiaries: [Pair(VerificationKey(benef_hash), 10_000_000)],
          guardrails: None,
        },
      },
      anchor: Anchor { url: @"https://x", hash: anchor_hash_fx },
    }
  let expected =
    #"d9010281841a000f4240581df0"
      |> bytearray.concat(cosponsor_validator_hash)
      |> bytearray.concat(#"8302a1581de0")
      |> bytearray.concat(benef_hash)
      |> bytearray.concat(#"1a00989680f6826968747470733a2f2f785820")
      |> bytearray.concat(anchor_hash_fx)
  convert_proposals([cpp]) == expected
}
