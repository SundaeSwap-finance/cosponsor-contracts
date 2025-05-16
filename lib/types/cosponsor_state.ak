use aiken/merkle_patricia_forestry.{Proof}
use types/cosponsor.{Anchor}

pub const cosponsor_state_nft_name = "cosponsor_state_nft"

pub type CosponsorStateDatum {
  expired_proposals_mpf_root: ByteArray,
}

pub type CosponsorStateRedeemer {
  proof: Proof,
  anchor_list: List<Anchor>,
}
