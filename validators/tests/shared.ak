use aiken/cbor.{serialise}
use aiken/crypto.{ScriptHash}
use aiken/fuzz.{constant}
use aiken/interval.{Finite, Interval, IntervalBound}
use aiken/merkle_patricia_forestry
use calculation/shared.{proposal_procedure_hash}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/fuzz as cardano
use cardano/governance.{GovernanceAction, ProposalProcedure}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ValidityRange,
}
use types/cosponsor.{Anchor, CosponsoredProposalProcedure}
use types/cosponsor_state.{CosponsorStateDatum, cosponsor_state_nft_name}

pub const protocol_boot_utxo: OutputReference =
  OutputReference {
    transaction_id: #"00000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }

pub const proposal_lifetime: Int = 1000

pub const cosponsor_state_validator_hash: ScriptHash =
  #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

pub const state_policy_id: PolicyId = cosponsor_state_validator_hash

pub const state_nft: ByteArray = cosponsor_state_nft_name

pub const true_policy_id: PolicyId =
  #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffee"

pub const cosponsor_validator_hash: ScriptHash =
  #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffdd"

pub fn scenario_random_inputs() -> Fuzzer<List<Input>> {
  fuzz.list_between(cardano.input(), 1, 10)
}

pub fn scenario_validity_range() -> Fuzzer<ValidityRange> {
  let validity_lower <- fuzz.and_then(fuzz.int_at_least(0))
  let validity_upper <- fuzz.and_then(fuzz.int_at_least(validity_lower))

  constant(
    Interval {
      lower_bound: IntervalBound {
        bound_type: Finite(validity_lower),
        is_inclusive: True,
      },
      upper_bound: IntervalBound {
        bound_type: Finite(validity_upper),
        is_inclusive: True,
      },
    },
  )
}

pub fn scenario_proposal_procedure_baseline() -> Fuzzer<ProposalProcedure> {
  let deposit <- fuzz.and_then(fuzz.int_at_least(0))
  let return_address <- fuzz.and_then(cardano.credential())
  let governance_action = GovernanceAction.NicePoll
  let procedure =
    ProposalProcedure { deposit, return_address, governance_action }
  constant(procedure)
}

pub fn anchor_fuzzer() -> Fuzzer<Anchor> {
  fuzz.tuple(constant(@"http://dummy.url"), fuzz.bytearray())
    |> fuzz.map(fn(pair) { Anchor { url: pair.1st, hash: pair.2nd } })
}

pub fn cosponsor_state_output_with_cpp(
  cpp: CosponsoredProposalProcedure,
  validity_upper: Int,
) -> Output {
  let updated_mpf_root =
    merkle_patricia_forestry.empty
      |> merkle_patricia_forestry.insert(
          proposal_procedure_hash(cpp),
          serialise(validity_upper + proposal_lifetime),
          [],
        )
      |> merkle_patricia_forestry.root

  Output {
    address: Address {
      payment_credential: Script(cosponsor_state_validator_hash),
      stake_credential: None,
    },
    value: assets.from_asset(cosponsor_state_validator_hash, state_nft, 1),
    datum: InlineDatum(
      CosponsorStateDatum { expired_proposals_mpf_root: updated_mpf_root },
    ),
    reference_script: None,
  }
}
