import { StateUpdateListener } from './interface';
// import { SCWKeyManager } from './SCWKeyManager';
import { SCWStateManager } from './SCWStateManager';
import { Communicator } from '../communicator/Communicator';
import { standardErrors } from '../error';
import { RPCRequestMessage, RPCResponse, RPCResponseMessage } from '../message';
import { AppMetadata, OAuthConfigs, RequestArguments, Signer } from '../provider/interface';
import { Method } from '../provider/method';
import { AddressString } from '../type';
import { ensureIntNumber } from '../type/util';
// import {
//   decryptContent,
//   encryptContent,
//   exportKeyToHexString,
//   importKeyFromHexString,
// } from '../util/cipher';
import { getSession, signIn, signOut } from 'next-auth/react';

type SwitchEthereumChainParam = [
  {
    chainId: `0x${string}`; // Hex chain id
  },
];

export class SCWSigner implements Signer {
  private readonly metadata: AppMetadata;
  private readonly communicator: Communicator;
  // private readonly keyManager: SCWKeyManager;
  private readonly stateManager: SCWStateManager;
  private address: AddressString | undefined;

  private readonly oauth: OAuthConfigs | undefined;

  constructor(params: {
    address?: AddressString;
    metadata: AppMetadata;
    communicator: Communicator;
    updateListener: StateUpdateListener;
    oauth?: OAuthConfigs;
  }) {
    this.metadata = params.metadata;
    this.communicator = params.communicator;
    // this.keyManager = new SCWKeyManager();
    this.stateManager = new SCWStateManager({
      appChainIds: this.metadata.appChainIds,
      updateListener: params.updateListener,
    });
    this.address = params.address;
    this.oauth = params.oauth;

    this.handshake = this.handshake.bind(this);
    this.request = this.request.bind(this);
    this.createRequestMessage = this.createRequestMessage.bind(this);
    this.decryptResponseMessage = this.decryptResponseMessage.bind(this);
  }

  async handshake(): Promise<AddressString[]> {
    // const handshakeMessage = await this.createRequestMessage({
    //   handshake: {
    //     method: 'eth_requestAccounts',
    //     params: this.metadata,
    //   },
    // });
    // const response: RPCResponseMessage = await this.communicator.postRequestAndWaitForResponse(
    //   handshakeMessage
    // );
    let accounts: AddressString[] = [];
    const session = await getSession();
    if (!session || !session.user) {
      const provider = this.oauth?.provider ?? 'alias'
      const options = this.oauth?.signInRedirect ? {redirect: this.oauth.signInRedirect.enabled, callbackUrl: this.oauth.signInRedirect.url} : undefined
      options ? await signIn(provider, options) : await signIn(provider);
    } else {
      const address = (session.user as any).wallet as AddressString;
      this.address = address
      accounts = [this.address] as AddressString[]
    }

    const response: RPCResponse<unknown> = {
      result: {
        value: accounts
      },
    }

    // store peer's public key
    // if ('failure' in response.content) throw response.content.failure;
    // const peerPublicKey = await importKeyFromHexString('public', response.sender);
    // await this.keyManager.setPeerPublicKey(peerPublicKey);

    // const decrypted = await this.decryptResponseMessage<AddressString[]>(response);
    this.updateInternalState({ method: 'eth_requestAccounts' }, response);

    // const result = decrypted.result;
    // if ('error' in result) throw result.error;

    return this.stateManager.accounts as AddressString[];
  }

  async request<T>(request: RequestArguments): Promise<T> {
    const localResult = this.tryLocalHandling<T>(request);
    if (localResult !== undefined) {
      if (localResult instanceof Error) throw localResult;
      return localResult;
    }

    // Open the popup before constructing the request message.
    // This is to ensure that the popup is not blocked by some browsers (i.e. Safari)
    await this.communicator.waitForPopupLoaded();

    const response = await this.sendEncryptedRequest(request);
    const decrypted = await this.decryptResponseMessage<T>(response);
    this.updateInternalState(request, decrypted);

    const result = decrypted.result;
    if ('error' in result) throw result.error;

    return result.value;
  }

  async disconnect() {
    this.address = undefined
    this.stateManager.clear();
    const session = await getSession()
    if (session) {
      const options = this.oauth?.signOutRedirect ? {redirect: this.oauth.signOutRedirect.enabled, callbackUrl: this.oauth.signOutRedirect.url} : undefined
      await signOut(options)
    }
    // await this.keyManager.clear();
  }

  private tryLocalHandling<T>(request: RequestArguments): T | undefined {
    switch (request.method as Method) {
      case 'wallet_switchEthereumChain': {
        const params = request.params as SwitchEthereumChainParam;
        if (!params || !params[0]?.chainId) {
          throw standardErrors.rpc.invalidParams();
        }
        const chainId = ensureIntNumber(params[0].chainId);
        const switched = this.stateManager.switchChain(chainId);
        // "return null if the request was successful"
        // https://eips.ethereum.org/EIPS/eip-3326#wallet_switchethereumchain
        return switched ? (null as T) : undefined;
      }
      case 'wallet_getCapabilities': {
        const walletCapabilities = this.stateManager.walletCapabilities;
        if (!walletCapabilities) {
          // This should never be the case for scw connections as capabilities are set during handshake
          throw standardErrors.provider.unauthorized(
            'No wallet capabilities found, please disconnect and reconnect'
          );
        }
        return walletCapabilities as T;
      }
      default:
        return undefined;
    }
  }

  private async sendEncryptedRequest(request: RequestArguments): Promise<RPCResponseMessage> {
    // const sharedSecret = await this.keyManager.getSharedSecret();
    // if (!sharedSecret) {
    //   throw standardErrors.provider.unauthorized(
    //     'No valid session found, try requestAccounts before other methods'
    //   );
    // }
    const session = await getSession()
    if (!session) {
      throw standardErrors.provider.unauthorized(
        'No valid session found, try requestAccounts before other methods'
      );
    }

    // const encrypted = await encryptContent(
    //   {
    //     action: request,
    //     chainId: this.stateManager.activeChain.id,
    //   },
    //   sharedSecret
    // );
    const message = await this.createRequestMessage({
      action: request,
      chainId: this.stateManager.activeChain.id,
    });

    return this.communicator.postRequestAndWaitForResponse(message);
  }

  private async createRequestMessage(
    content: RPCRequestMessage['content']
  ): Promise<RPCRequestMessage> {
    // const publicKey = await exportKeyToHexString('public', await this.keyManager.getOwnPublicKey());
    return {
      // id: crypto.randomUUID(),
      // sender: publicKey,
      content,
      timestamp: new Date(),
    };
  }

  private async decryptResponseMessage<T>(message: RPCResponseMessage): Promise<RPCResponse<T>> {
    const content = message.content;

    // throw protocol level error
    if ('failure' in content) {
      throw content.failure;
    }

    // const sharedSecret = await this.keyManager.getSharedSecret();
    // if (!sharedSecret) {
    //   throw standardErrors.provider.unauthorized('Invalid session');
    // }
    const session = await getSession()
    if (!session) {
      throw standardErrors.provider.unauthorized('Invalid session');
    }

    // return decryptContent(content.encrypted, sharedSecret);
    return content as RPCResponse<T>;
  }

  private updateInternalState<T>(request: RequestArguments, response: RPCResponse<T>) {
    const availableChains = response.data?.chains;
    if (availableChains) {
      this.stateManager.updateAvailableChains(availableChains);
    }

    const walletCapabilities = response.data?.capabilities;
    if (walletCapabilities) {
      this.stateManager.updateWalletCapabilities(walletCapabilities);
    }

    const result = response.result;
    if ('error' in result) return;

    switch (request.method as Method) {
      case 'eth_requestAccounts': {
        const accounts = result.value as AddressString[];
        this.stateManager.updateAccounts(accounts);
        break;
      }
      case 'wallet_switchEthereumChain': {
        // "return null if the request was successful"
        // https://eips.ethereum.org/EIPS/eip-3326#wallet_switchethereumchain
        if (result.value !== null) return;

        const params = request.params as SwitchEthereumChainParam;
        const chainId = ensureIntNumber(params[0].chainId);
        this.stateManager.switchChain(chainId);
        break;
      }
      default:
        break;
    }
  }
}
