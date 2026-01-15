// Types for transaction building and processing

export interface DepositTransaction {
  depositTxHash: string;
  depositOutputIndex: number;
  depositAmount: bigint;
}

export interface TokenGroup {
  expectedTokenAssetName: string;
  cosponsoredProposal: any; // ICosponsoredProposal type from validators
  deposits: DepositTransaction[];
}

export interface TransactionDetails {
  timestamp: string;
  txId: string;
  type: 'deposit' | 'withdrawal' | 'bulk-withdrawal' | 'multi-token-withdrawal';
  status: 'pending' | 'completed' | 'failed';
  amount?: string; // ADA amount as string
  deposits?: DepositTransaction[];
  tokens?: Array<{
    assetName: string;
    amount: string;
  }>;
  metadata?: Record<string, any>;
}

export interface TransactionBuildConfig {
  timeout?: number; // Transaction timeout in milliseconds
  enableLogging?: boolean;
  validateInputs?: boolean;
  dryRun?: boolean;
}