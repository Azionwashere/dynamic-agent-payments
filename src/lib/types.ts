export interface CheckoutConfig {
  environmentId: string;
  apiToken: string;
  apiBase: string;
  settlementChainId: string;
  settlementChainName: 'EVM' | 'SOL';
  settlementTokenAddress: string;
  settlementTokenSymbol: string;
  settlementTokenDecimals: number;
  destinationAddress: string;
}

export interface PaymentSession {
  transactionId: string;
  sessionToken: string;
}

export interface PaymentQuote {
  fromAmount: string;
  toAmount: string;
  estimatedTimeSec: number;
  fees: {
    totalFeeUsd: string;
  };
  quoteExpiresAt?: string;
  signingPayload?: {
    chainId: string;
    chainName: string;
    evmTransaction?: {
      to: string;
      data: string;
      value: string;
      gasLimit: string;
      gasPrice: string;
    };
  };
}

export interface SigningPayload {
  to?: string;
  data?: string;
  value?: string;
  transactionRequest?: {
    to: string;
    data: string;
    value: string;
  };
  serializedTransaction?: string | { serializedTransaction: string };
}

export interface SettlementResult {
  transactionId: string;
  txHash: string;
  executionState: string;
  settlementState: string;
  completedAt?: string;
}

export interface X402PaymentRequirements {
  amount: string;
  currency: string;
  recipient: string;
  facilitator: string;
  chainId?: string;
  network?: string;
  scheme?: string;
  extra?: Record<string, unknown>;
}

export interface X402PaymentResult {
  settlementHash: string;
  accessGranted: boolean;
}

export interface WalletInfo {
  accountAddress: string;
  walletId: string;
  chain: 'EVM' | 'SOL';
}

export interface AgentEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type SignTransactionFn = (payload: SigningPayload, chainName: string) => Promise<string>;

export type EventCallback = (event: AgentEvent) => void;
