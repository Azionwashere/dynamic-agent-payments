declare module '@dynamic-labs-wallet/node-evm' {
  export function createDelegatedEvmWalletClient(config: {
    environmentId: string;
    apiKey: string;
    baseMPCRelayApiUrl?: string;
  }): any;

  export function delegatedSignTransaction(
    client: any,
    params: {
      walletId: string;
      walletApiKey: string;
      keyShare: any;
      transaction: any;
    },
  ): Promise<string>;

  export function delegatedSignTypedData(
    client: any,
    params: {
      walletId: string;
      walletApiKey: string;
      keyShare: any;
      typedData: any;
    },
  ): Promise<string>;

  export function delegatedSignMessage(
    client: any,
    params: {
      walletId: string;
      walletApiKey: string;
      keyShare: any;
      message: string;
    },
  ): Promise<string>;

  export class DynamicEvmWalletClient {
    constructor(config: { environmentId: string });
    authenticateApiToken(token: string): Promise<void>;
    createWalletAccount(params: {
      thresholdSignatureScheme: any;
      password?: string;
      backUpToClientShareService?: boolean;
    }): Promise<{
      accountAddress: string;
      publicKeyHex: string;
      walletId: string;
    }>;
    signTypedData(params: {
      accountAddress: string;
      typedData: any;
      password?: string;
    }): Promise<string>;
    signTransaction(params: {
      accountAddress: string;
      transaction: any;
      password?: string;
    }): Promise<string>;
  }
}

declare module '@dynamic-labs-wallet/node-svm' {
  export function createDelegatedSvmWalletClient(config: {
    environmentId: string;
    apiKey: string;
  }): any;

  export class DynamicSvmWalletClient {
    constructor(config: { environmentId: string });
    authenticateApiToken(token: string): Promise<void>;
    createWalletAccount(params: {
      thresholdSignatureScheme: any;
    }): Promise<{
      accountAddress: string;
      publicKeyHex: string;
      walletId: string;
    }>;
  }
}

declare module '@dynamic-labs-wallet/node' {
  export enum ThresholdSignatureScheme {
    TWO_OF_TWO = 'TWO_OF_TWO',
    TWO_OF_THREE = 'TWO_OF_THREE',
    THREE_OF_FIVE = 'THREE_OF_FIVE',
  }
}
