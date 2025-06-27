use aiken/cbor.{serialise}
use aiken/collection/list
use aiken/merkle_patricia_forestry.{Proof, from_root, insert, root}
use calculation/shared.{proposal_procedure_hash}
use cardano/governance.{ProposalProcedure}
use types/cosponsor.{Anchor, CosponsoredProposalProcedure}

pub fn mpf_updated_correctly(
  proposal_procedures: List<ProposalProcedure>,
  proposal_expiration: Int,
  original_mpf_root: ByteArray,
  actual_mpf_root: ByteArray,
  proof: Proof,
  anchor_list: List<Anchor>,
) -> Bool {
  let original_mpf = from_root(original_mpf_root)
  let updated_mpf =
    proposal_procedures
      |> list.indexed_foldr(
          original_mpf,
          fn(ix, proposal_procedure, acc) {
            expect Some(anchor) = list.at(anchor_list, ix)
            let cosponsored_procedure =
              CosponsoredProposalProcedure {
                procedure: proposal_procedure,
                anchor,
              }
            let proposal_procedure_hash =
              proposal_procedure_hash(cosponsored_procedure)
            let updated_mpf =
              acc
                |> insert(
                    proposal_procedure_hash,
                    serialise(proposal_expiration),
                    proof,
                  )
            updated_mpf
          },
        )
  root(updated_mpf) == actual_mpf_root
}
