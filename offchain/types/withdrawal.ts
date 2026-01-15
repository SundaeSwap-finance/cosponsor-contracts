// Types for withdrawal specifications and operations

export interface TokenSpecification {
  tokenAssetName: string;
  requiredAmount: bigint; // Total amount of this token to burn
  availableAmount: bigint; // Available in wallet
  deposits: Array<{
    depositTxHash: string;
    depositOutputIndex: number;
    depositAmount: bigint;
  }>;
}

export interface WithdrawalSpecification {
  tokens: TokenSpecification[];
  totalRecoveredAda: bigint;
  totalDeposits: number;
}

export interface WithdrawalResult {
  txId: string;
  timestamp: string;
  mode: 'single-token' | 'multi-token' | 'indexed-multi-token';
  tokensWithdrawn: number;
  depositsWithdrawn: number;
  totalRecovered: string; // BigInt as string
  recoveredAda: string;   // Human readable amount
}

export interface BulkWithdrawalSummary {
  timestamp: string;
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  totalADARecovered: string;
  transactionIds: string[];
}