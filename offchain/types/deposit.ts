// Types for deposit tracking and indexing

export interface DepositInfo {
  tokenAssetName: string
  depositTxId: string
  depositOutputIndex: number
  depositAmount: string // Keep as string for JSON compatibility
  proposalUrl: string
  proposalHash: string
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