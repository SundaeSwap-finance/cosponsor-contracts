use aiken/merkle_patricia_forestry.{Proof}
use cardano/governance.{ProposalProcedure}

pub type Anchor {
  url: String,
  hash: ByteArray,
}

pub type CosponsoredProposalProcedure {
  procedure: ProposalProcedure,
  anchor: Anchor,
}

pub type CosponsorDatum {
  Before {
    // The proposal this UTXO is destined to cosponsor
    cosponsored: CosponsoredProposalProcedure,
  }
  After
}

pub type CosponsorMintRedeemer {
  MDeposit
  MRedeem { proof: Proof, expired_proposals: Pairs<ByteArray, Int> }
}

pub type CosponsorRedeemer {
  SAggregate
  SPropose
}

pub type CosponsorWithdrawRedeemer {
  WAggregate
  WPropose {
    collateral_inputs: ByteArray,
    collateral_output: ByteArray,
    collateral_fee: ByteArray,
  }
  WWithdraw
}
