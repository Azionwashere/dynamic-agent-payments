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
    gasEstimate?: {
      usdValue: string;
      nativeValue: string;
      nativeSymbol: string;
    };
  };
  quoteExpiresAt?: string;
  version?: number;
}

export interface PrepareResult {
  signingPayload: CheckoutSigningPayload;
  quote: PaymentQuote;
}

export interface CheckoutSigningPayload {
  chainName: string;
  chainId: string;
  evmTransaction?: {
    to: string;
    data: string;
    value: string;
    gasLimit: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  evmApproval?: {
    tokenAddress: string;
    spenderAddress: string;
    amount: string;
  };
  serializedTransaction?: string; // SOL, SUI — base64
  psbt?: string; // BTC — base64 unsigned PSBT
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
  memo?: Record<string, unknown>;
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
  /** MPP only: the Authorization header to retry the request with */
  authorizationHeader?: string;
  /** MPP only: the payment ID for tracking */
  paymentId?: string;
  /** Which protocol was used */
  protocol?: 'x402-coinbase' | 'mpp';
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

export type ApprovalFn = (approval: { tokenAddress: string; spenderAddress: string; amount: string }) => Promise<string>;

export type EventCallback = (event: AgentEvent) => void;
