// Types for deposit tracking and indexing

export interface DepositInfo {
  tokenAssetName: string
  depositTxId: string
  depositOutputIndex: number
  depositAmount: string // Keep as string for JSON compatibility
  proposalUrl: string
  /**
   * blake2b-256 hash of the serialized CosponsoredProposalProcedure —
   * equals the gADA token asset name. The canonical proposal identity.
   */
  proposalHash: string
  /**
   * SHA-256 of the off-chain proposal-anchor metadata (CIP-100/108).
   * Carried for display/audit purposes only — NOT a proposal identity.
   * Pre-audit code stored this in `proposalHash` (AUDIT.md F19), which
   * silently broke any caller doing per-proposal grouping.
   */
  anchorContentHash?: string
  isSpent: boolean
  spentStatus: 'available' | 'spent' | 'not_found'
}

export interface DepositIndex {
  timestamp: string
  totalDeposits: number
  availableDeposits: number
  spentDeposits: number
  notFoundDeposits: number
  scriptAddress: string
  policyId: string
  deposits: DepositInfo[]
}

export interface WalletToken {
  assetName: string
  amount: string // Keep as string for JSON compatibility
  utxoRef: string
}

export interface WalletTokens {
  timestamp: string
  totalTokens: number
  policyId: string
  tokens: WalletToken[]
}