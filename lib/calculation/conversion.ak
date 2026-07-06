//// Ledger-CDDL serializers for the WPropose body reconstruction.
////
//// Every function here emits the EXACT bytes @blaze-cardano/core
//// (cardano-sdk serialization, Conway era) puts in a transaction body:
//// tag-258 (`d90102`) wrapped sets, `0x5820`-headed 32-byte hashes,
//// legacy array outputs when datum-free and map-form Babbage outputs when
//// an inline datum is present. The golden vectors in
//// `validators/tests/propose_proof.ak` pin these encodings; the off-chain
//// Propose builder mirrors them byte-for-byte.
////
//// NETWORK NOTE: addresses and reward accounts are TESTNET-tagged
//// (0x60/0x70 payment headers, 0xe0/0xf0 reward headers). A mainnet
//// deployment must parameterize the network nibble before launch.

use aiken/cbor.{serialise}
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/math/rational
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{Lovelace, Value}
use cardano/governance.{GovernanceAction, GovernanceActionId}
use cardano/transaction.{
  Datum, DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference,
  ValidityRange,
}
use types/cosponsor.{Anchor, CosponsoredProposalProcedure}

// ---------------------------------------------------------------------------
// Generic CBOR helpers
// ---------------------------------------------------------------------------

/// CBOR tag 258 — Conway's mathematical-set wrapper. cardano-sdk emits it
/// around every set-typed body field once the Conway era flag is on (which
/// Blaze's TxBuilder always sets).
pub const set_tag: ByteArray = #"d90102"

fn cbor_header(major_base: Int, n: Int) -> ByteArray {
  if n <= 23 {
    bytearray.from_int_big_endian(major_base + n, 1)
  } else if n <= 255 {
    bytearray.from_int_big_endian(major_base + 24, 1)
      |> bytearray.concat(bytearray.from_int_big_endian(n, 1))
  } else if n <= 65535 {
    bytearray.from_int_big_endian(major_base + 25, 1)
      |> bytearray.concat(bytearray.from_int_big_endian(n, 2))
  } else {
    fail @"cbor_header: length too large"
  }
}

pub fn array_header(n: Int) -> ByteArray {
  cbor_header(128, n)
}

pub fn map_header(n: Int) -> ByteArray {
  cbor_header(160, n)
}

fn bytes_header(n: Int) -> ByteArray {
  cbor_header(64, n)
}

fn text_header(n: Int) -> ByteArray {
  cbor_header(96, n)
}

// ---------------------------------------------------------------------------
// Body field converters
// ---------------------------------------------------------------------------

/// Conway set of transaction inputs: d90102 + array of [txid, index].
pub fn convert_inputs(inputs: List<Input>) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      inputs,
      (0, ""),
      fn(input, acc) {
        let OutputReference { transaction_id, output_index } =
          input.output_reference
        (
          acc.1st + 1,
          #"825820"
            |> bytearray.concat(transaction_id)
            |> bytearray.concat(serialise(output_index))
            |> bytearray.concat(acc.2nd),
        )
      },
    )
  set_tag
    |> bytearray.concat(array_header(length))
    |> bytearray.concat(bytes)
}

/// Reference inputs share the input set encoding.
pub fn convert_reference_inputs(inputs: List<Input>) -> ByteArray {
  convert_inputs(inputs)
}

/// Outputs are a plain array (not a set). cardano-sdk emits the legacy
/// two-element array form for datum-free outputs and the map-form Babbage
/// output when an inline datum is present.
pub fn convert_outputs(outputs: List<Output>) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      outputs,
      (0, ""),
      fn(output, acc) {
        (acc.1st + 1, convert_output(output) |> bytearray.concat(acc.2nd))
      },
    )
  array_header(length) |> bytearray.concat(bytes)
}

fn convert_output(output: Output) -> ByteArray {
  let Output { address, value, datum, reference_script } = output
  // Canon: propose transactions never carry script-ref or datum-hash
  // outputs. Rejecting them here keeps the reconstruction total.
  expect None = reference_script
  when datum is {
    NoDatum ->
      #"82"
        |> bytearray.concat(convert_address(address))
        |> bytearray.concat(convert_value(value))
    InlineDatum(data) -> {
      let datum_bytes = serialise(data)
      #"a300"
        |> bytearray.concat(convert_address(address))
        |> bytearray.concat(#"01")
        |> bytearray.concat(convert_value(value))
        |> bytearray.concat(#"028201d818")
        |> bytearray.concat(bytes_header(bytearray.length(datum_bytes)))
        |> bytearray.concat(datum_bytes)
    }
    DatumHash(_) -> fail @"convert_output: datum-hash outputs unsupported"
  }
}

pub fn convert_fee(fee: Lovelace) -> ByteArray {
  fee |> serialise
}

/// TTL (body key 03): the finite upper bound of the validity range.
pub fn convert_ttl(validity_range: ValidityRange) -> ByteArray {
  expect Interval {
    upper_bound: IntervalBound { bound_type: Finite(ttl), .. },
    ..
  } = validity_range
  serialise(ttl)
}

/// Withdrawals map: { reward_account => coin }.
pub fn convert_withdrawals(
  withdrawals: Pairs<Credential, Lovelace>,
) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      withdrawals,
      (0, ""),
      fn(Pair(credential, lovelace), acc) {
        (
          acc.1st + 1,
          reward_account(credential)
            |> bytearray.concat(serialise(lovelace))
            |> bytearray.concat(acc.2nd),
        )
      },
    )
  map_header(length) |> bytearray.concat(bytes)
}

/// Mint: PlutusData's map-of-maps encoding of Value coincides with the
/// ledger's multiasset encoding for the token shapes we emit.
pub fn convert_mint(mint: Value) -> ByteArray {
  mint |> serialise
}

/// Conway set of required-signer key hashes.
pub fn convert_extra_signatories(signatures: List<ByteArray>) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      signatures,
      (0, ""),
      fn(signature, acc) {
        (acc.1st + 1, bytearray.concat(serialise(signature), acc.2nd))
      },
    )
  set_tag
    |> bytearray.concat(array_header(length))
    |> bytearray.concat(bytes)
}

// ---------------------------------------------------------------------------
// Address / reward-account encoding (testnet)
// ---------------------------------------------------------------------------

fn convert_value(assets: Value) -> ByteArray {
  let lovelace = assets.lovelace_of(assets) |> serialise
  let multi_asset = assets.without_lovelace(assets) |> serialise

  if multi_asset == #"a0" {
    lovelace
  } else {
    #"82" |> bytearray.concat(lovelace) |> bytearray.concat(multi_asset)
  }
}

fn convert_address(address: Address) -> ByteArray {
  //; bit 4: payment cred is keyhash/scripthash
  let (header_byte_pc, credential_p) =
    when address.payment_credential is {
      Script(cred) -> (16, cred)
      VerificationKey(cred) -> (0, cred)
    }
  let (header_byte_sc, credential_s) =
    when address.stake_credential is {
      None -> (96, "")
      Some(Inline(VerificationKey(cred))) -> (0, cred)
      Some(Inline(Script(cred))) -> (32, cred)
      _ -> fail @"no way"
    }
  bytearray.from_int_big_endian(header_byte_pc + header_byte_sc, 1)
    |> bytearray.concat(bytearray.concat(credential_p, credential_s))
    |> serialise
}

/// Reward account bytes (testnet): 0xe0/0xf0 header + 28-byte hash, as a
/// 29-byte CBOR bytestring.
pub fn reward_account(credential: Credential) -> ByteArray {
  when credential is {
    VerificationKey(hash) -> #"581de0" |> bytearray.concat(hash)
    Script(hash) -> #"581df0" |> bytearray.concat(hash)
  }
}

// ---------------------------------------------------------------------------
// Proposal procedures (body key 14)
// ---------------------------------------------------------------------------

/// Conway nonempty_set of proposal_procedure =
///   [deposit, reward_account, gov_action, anchor]
pub fn convert_proposals(
  proposals: List<CosponsoredProposalProcedure>,
) -> ByteArray {
  let (length, bytes) =
    list.foldr(
      proposals,
      (0, ""),
      fn(proposal, acc) {
        (acc.1st + 1, bytearray.concat(convert_proposal(proposal), acc.2nd))
      },
    )
  set_tag
    |> bytearray.concat(array_header(length))
    |> bytearray.concat(bytes)
}

fn convert_proposal(proposal: CosponsoredProposalProcedure) -> ByteArray {
  #"84"
    |> bytearray.concat(serialise(proposal.procedure.deposit))
    |> bytearray.concat(reward_account(proposal.procedure.return_address))
    |> bytearray.concat(
        convert_governance_action(proposal.procedure.governance_action),
      )
    |> bytearray.concat(convert_anchor(proposal.anchor))
}

fn convert_anchor(anchor: Anchor) -> ByteArray {
  let url_bytes = bytearray.from_string(anchor.url)
  #"82"
    |> bytearray.concat(text_header(bytearray.length(url_bytes)))
    |> bytearray.concat(url_bytes)
    |> bytearray.concat(#"5820")
    |> bytearray.concat(anchor.hash)
}

fn convert_action_id(ancestor: Option<GovernanceActionId>) -> ByteArray {
  when ancestor is {
    None -> #"f6"
    Some(GovernanceActionId { transaction, proposal_procedure }) ->
      #"825820"
        |> bytearray.concat(transaction)
        |> bytearray.concat(serialise(proposal_procedure))
  }
}

fn convert_option_script_hash(guardrails: Option<ScriptHash>) -> ByteArray {
  when guardrails is {
    None -> #"f6"
    Some(hash) -> #"581c" |> bytearray.concat(hash)
  }
}

/// Credential in ledger form: [0, key_hash] / [1, script_hash].
fn convert_credential(credential: Credential) -> ByteArray {
  when credential is {
    VerificationKey(hash) -> #"8200581c" |> bytearray.concat(hash)
    Script(hash) -> #"8201581c" |> bytearray.concat(hash)
  }
}

fn convert_governance_action(action: GovernanceAction) -> ByteArray {
  when action is {
    GovernanceAction.NicePoll -> #"8106"
    GovernanceAction.NoConfidence { ancestor } ->
      #"8203" |> bytearray.concat(convert_action_id(ancestor))
    GovernanceAction.HardFork { ancestor, new_version } ->
      #"8301"
        |> bytearray.concat(convert_action_id(ancestor))
        |> bytearray.concat(#"82")
        |> bytearray.concat(serialise(new_version.major))
        |> bytearray.concat(serialise(new_version.minor))
    GovernanceAction.TreasuryWithdrawal { beneficiaries, guardrails } -> {
      let (length, bytes) =
        list.foldr(
          beneficiaries,
          (0, ""),
          fn(Pair(credential, amount), acc) {
            (
              acc.1st + 1,
              reward_account(credential)
                |> bytearray.concat(serialise(amount))
                |> bytearray.concat(acc.2nd),
            )
          },
        )
      #"8302"
        |> bytearray.concat(map_header(length))
        |> bytearray.concat(bytes)
        |> bytearray.concat(convert_option_script_hash(guardrails))
    }
    GovernanceAction.ConstitutionalCommittee {
      ancestor,
      evicted_members,
      added_members,
      quorum,
    } -> {
      let (n_evicted, evicted_bytes) =
        list.foldr(
          evicted_members,
          (0, ""),
          fn(credential, acc) {
            (
              acc.1st + 1,
              bytearray.concat(convert_credential(credential), acc.2nd),
            )
          },
        )
      let (n_added, added_bytes) =
        list.foldr(
          added_members,
          (0, ""),
          fn(Pair(credential, mandate), acc) {
            (
              acc.1st + 1,
              convert_credential(credential)
                |> bytearray.concat(serialise(mandate))
                |> bytearray.concat(acc.2nd),
            )
          },
        )
      #"8504"
        |> bytearray.concat(convert_action_id(ancestor))
        |> bytearray.concat(set_tag)
        |> bytearray.concat(array_header(n_evicted))
        |> bytearray.concat(evicted_bytes)
        |> bytearray.concat(map_header(n_added))
        |> bytearray.concat(added_bytes)
        |> bytearray.concat(#"d81e82")
        |> bytearray.concat(serialise(rational.numerator(quorum)))
        |> bytearray.concat(serialise(rational.denominator(quorum)))
    }
    // The script-context (and therefore datum) representation of these two
    // action types drops ledger-level data (the constitution's own anchor;
    // the full parameter-update map), so their body bytes cannot be
    // reconstructed from the datum. Supporting them needs a datum-type
    // extension (e.g. carrying the raw action CBOR) — out of scope for now.
    GovernanceAction.NewConstitution { .. } ->
      fail @"convert_governance_action: NewConstitution unsupported"
    GovernanceAction.ProtocolParameters { .. } ->
      fail @"convert_governance_action: ProtocolParameters unsupported"
  }
}
