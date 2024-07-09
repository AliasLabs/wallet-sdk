import EventEmitter from 'eventemitter3';
import { AppMetadata, ConstructorOptions, ProviderInterface, RequestArguments, Signer } from './core/provider/interface';
import { Communicator } from './core/communicator/Communicator';
import { AddressString, Chain, IntNumber } from './core/type';
import { determineMethodCategory } from './core/provider/method';
import { areAddressArraysEqual, hexStringFromIntNumber } from './core/type/util';
import { standardErrorCodes, standardErrors } from './core/error';
import { checkErrorForInvalidRequestArgs, fetchRPCRequest } from './core/util/provider';
import { ScopedLocalStorage } from './core/util/ScopedLocalStorage';
import { serializeError } from './core/error/serialize';
import { SCWSigner } from './core/scw/SCWSigner';
import { AccountsUpdate, ChainUpdate } from './core/scw/interface';

export class AliasWalletProvider extends EventEmitter implements ProviderInterface {
  private readonly metadata: AppMetadata;
  private readonly communicator: Communicator;

  private signer: Signer | null;
  private address: AddressString | undefined;
  protected accounts: AddressString[] = [];
  protected chain: Chain;

  constructor({ metadata, preference: { keysUrl } }: Readonly<ConstructorOptions>) {
    super();
    this.metadata = metadata;
    this.communicator = new Communicator(keysUrl);
    this.chain = {
      id: metadata.appChainIds?.[0] ?? 1,
    };
    // Load states from storage
    this.signer = new SCWSigner({
      metadata,
      communicator: this.communicator,
      updateListener: this.updateListener
    })
  }

  public get connected() {
    return this.accounts.length > 0;
  }

  public async request<T>(args: RequestArguments): Promise<T> {
    try {
      const invalidArgsError = checkErrorForInvalidRequestArgs(args);
      if (invalidArgsError) throw invalidArgsError;
      // unrecognized methods are treated as fetch requests
      const category = determineMethodCategory(args.method) ?? 'fetch';
      return this.handlers[category](args) as T;
    } catch (error) {
      return Promise.reject(serializeError(error, args.method));
    }
  }

  protected readonly handlers = {
    // eth_requestAccounts
    handshake: async (_: RequestArguments): Promise<AddressString[]> => {
      try {
        if (this.connected) {
          this.emit('connect', { chainId: hexStringFromIntNumber(IntNumber(this.chain.id)) });
          return this.accounts;
        }

        const signer = this.initSigner();
        const accounts = await signer.handshake();

        this.signer = signer;

        this.emit('connect', { chainId: hexStringFromIntNumber(IntNumber(this.chain.id)) });
        return accounts;
      } catch (error) {
        this.handleUnauthorizedError(error);
        throw error;
      }
    },

    sign: async (request: RequestArguments) => {
      if (!this.connected || !this.signer) {
        throw standardErrors.provider.unauthorized(
          "Must call 'eth_requestAccounts' before other methods"
        );
      }
      try {
        return await this.signer.request(request);
      } catch (error) {
        this.handleUnauthorizedError(error);
        throw error;
      }
    },

    fetch: (request: RequestArguments) => fetchRPCRequest(request, this.chain),

    state: (request: RequestArguments) => {
      const getConnectedAccounts = (): AddressString[] => {
        if (this.connected) return this.accounts;
        throw standardErrors.provider.unauthorized(
          "Must call 'eth_requestAccounts' before other methods"
        );
      };
      switch (request.method) {
        case 'eth_chainId':
          return hexStringFromIntNumber(IntNumber(this.chain.id));
        case 'net_version':
          return this.chain.id;
        case 'eth_accounts':
          return getConnectedAccounts();
        case 'eth_coinbase':
          return getConnectedAccounts()[0];
        default:
          return this.handlers.unsupported(request);
      }
    },

    deprecated: ({ method }: RequestArguments) => {
      throw standardErrors.rpc.methodNotSupported(`Method ${method} is deprecated.`);
    },

    unsupported: ({ method }: RequestArguments) => {
      throw standardErrors.rpc.methodNotSupported(`Method ${method} is not supported.`);
    },
  };

  private handleUnauthorizedError(error: unknown) {
    const e = error as { code?: number };
    if (e.code === standardErrorCodes.provider.unauthorized) this.disconnect();
  }

  /** @deprecated Use `.request({ method: 'eth_requestAccounts' })` instead. */
  public async enable(): Promise<unknown> {
    console.warn(
      `.enable() has been deprecated. Please use .request({ method: "eth_requestAccounts" }) instead.`
    );
    return await this.request({
      method: 'eth_requestAccounts',
    });
  }

  async disconnect(): Promise<void> {
    this.accounts = [];
    this.chain = { id: 1 };
    ScopedLocalStorage.clearAll();
    this.emit('disconnect', standardErrors.provider.disconnected('User initiated disconnection'));
  }

  protected readonly updateListener = {
    onAccountsUpdate: ({ accounts, source }: AccountsUpdate) => {
      if (areAddressArraysEqual(this.accounts, accounts)) return;
      this.accounts = accounts;
      if (source === 'storage') return;
      this.emit('accountsChanged', this.accounts);
    },
    onChainUpdate: ({ chain, source }: ChainUpdate) => {
      if (chain.id === this.chain.id && chain.rpcUrl === this.chain.rpcUrl) return;
      this.chain = chain;
      if (source === 'storage') return;
      this.emit('chainChanged', hexStringFromIntNumber(IntNumber(chain.id)));
    },
  };

  private initSigner(): Signer {
    return new SCWSigner({
      metadata: this.metadata,
      communicator: this.communicator,
      updateListener: this.updateListener,
      address: this.address
    })
  }
}