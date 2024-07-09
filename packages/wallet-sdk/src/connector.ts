import type {
  AppMetadata,
  ProviderInterface,
} from './core/provider/interface'
import {
  ChainNotConfiguredError,
  type Connector,
  createConnector,
} from '@wagmi/core'
import {
  type Evaluate,
  type Mutable,
  type Omit,
} from '@wagmi/core/internal'
import {
  type AddEthereumChainParameter,
  type Hex,
  type ProviderRpcError,
  SwitchChainError,
  UserRejectedRequestError,
  getAddress,
  numberToHex,
} from 'viem'
// import { signOut } from 'next-auth/react'
import { AliasWalletProvider } from './provider'

export const DEFAULT_WALLET_URL = 'http://localhost:3001/wallet'

export type SmartWalletParameters =
  Evaluate<
      {
        headlessMode?: false | undefined
      } & ConnectorParameters
    >

connector.type = 'alias' as const
export function connector<version extends '4'>(
  parameters: SmartWalletParameters = {} as any,
): ReturnType<typeof toAliasWagmiConnector> {
  return toAliasWagmiConnector(parameters as ConnectorParameters) as any
}

type AliasWalletSDKParams = Partial<AppMetadata>

type ConnectorParameters = Mutable<
  Omit<
    AliasWalletSDKParams,
    'appChainIds' // set via wagmi config
  > & {
    keysUrl?: string | undefined,
  }
>

function toAliasWagmiConnector(parameters: ConnectorParameters) {
  type Provider = ProviderInterface & {
    // for backwards compatibility
    close?(): void
  }

  let walletProvider: Provider | undefined
  let walletChainId: number | undefined

  let accountsChanged: Connector['onAccountsChanged'] | undefined
  let chainChanged: Connector['onChainChanged'] | undefined
  let disconnect: Connector['onDisconnect'] | undefined

  return createConnector<Provider>((config) => ({
    id: 'alias',
    name: 'Alias',
    supportsSimulation: true,
    type: connector.type,
    async connect({ chainId } = {}) {
      try {
        const provider = await this.getProvider()
        const accounts = (
          (await provider.request({
            method: 'eth_requestAccounts',
          })) as string[]
        ).map((x) => getAddress(x))

        if (!accountsChanged) {
          accountsChanged = this.onAccountsChanged.bind(this)
          provider.on('accountsChanged', accountsChanged)
        }
        if (!chainChanged) {
          chainChanged = this.onChainChanged.bind(this)
          provider.on('chainChanged', chainChanged)
        }
        if (!disconnect) {
          disconnect = this.onDisconnect.bind(this)
          provider.on('disconnect', disconnect)
        }

        // Switch to chain if provided
        let currentChainId = await this.getChainId()
        if (chainId && currentChainId !== chainId) {
          const chain = await this.switchChain!({ chainId }).catch((error) => {
            if (error.code === UserRejectedRequestError.code) throw error
            return { id: currentChainId }
          })
          currentChainId = chain?.id ?? currentChainId
        }
        walletChainId = currentChainId

        return { accounts, chainId: currentChainId }
      } catch (error) {
        console.error(error)
        if (
          /(user closed modal|accounts received is empty|user denied account|request rejected)/i.test(
            (error as Error).message,
          )
        )
          throw new UserRejectedRequestError(error as Error)
        throw error
      }
    },
    async disconnect() {
      const provider = await this.getProvider()

      if (accountsChanged) {
        provider.removeListener('accountsChanged', accountsChanged)
        accountsChanged = undefined
      }
      if (chainChanged) {
        provider.removeListener('chainChanged', chainChanged)
        chainChanged = undefined
      }
      if (disconnect) {
        provider.removeListener('disconnect', disconnect)
        disconnect = undefined
      }

      await provider.disconnect()
      provider.close?.()
    },
    async getAccounts() {
      const provider = await this.getProvider()
      return (
        await provider.request<string[]>({
          method: 'eth_accounts',
        })
      ).map((x) => getAddress(x))
    },
    async getChainId() {
      const provider = await this.getProvider()
      const currentChainId = await provider.request<Hex>({
        method: 'eth_chainId',
      })
      walletChainId = Number(currentChainId)
      return Number(currentChainId)
    },
    async getProvider() {
      if (!walletProvider) {
        walletProvider = new AliasWalletProvider({
          metadata: {
            appName: parameters.appName||"Dapp",
            appLogoUrl: parameters.appLogoUrl||null,
            appChainIds: config.chains.map((x) => x.id),
          },
          preference: {
            options: 'smartWalletOnly',
            keysUrl: parameters.keysUrl,
          },
        })
      }

      return walletProvider
    },
    async isAuthorized() {
      try {
        const accounts = await this.getAccounts()
        return !!accounts.length
      } catch {
        return false
      }
    },
    async switchChain({ addEthereumChainParameter, chainId: newChainId }) {
      const chain = config.chains.find((chain) => chain.id === newChainId)
      if (!chain) throw new SwitchChainError(new ChainNotConfiguredError())

      const provider = await this.getProvider()

      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: numberToHex(chain.id) }],
        })
        walletChainId = chain.id
        return chain
      } catch (error) {
        // Indicates chain is not added to provider
        if ((error as ProviderRpcError).code === 4902) {
          try {
            let blockExplorerUrls: string[] | undefined
            if (addEthereumChainParameter?.blockExplorerUrls)
              blockExplorerUrls = addEthereumChainParameter.blockExplorerUrls
            else
              blockExplorerUrls = chain.blockExplorers?.default.url
                ? [chain.blockExplorers?.default.url]
                : []

            let rpcUrls: readonly string[]
            if (addEthereumChainParameter?.rpcUrls?.length)
              rpcUrls = addEthereumChainParameter.rpcUrls
            else rpcUrls = [chain.rpcUrls.default?.http[0] ?? '']

            const addEthereumChain = {
              blockExplorerUrls,
              chainId: numberToHex(newChainId),
              chainName: addEthereumChainParameter?.chainName ?? chain.name,
              iconUrls: addEthereumChainParameter?.iconUrls,
              nativeCurrency:
                addEthereumChainParameter?.nativeCurrency ??
                chain.nativeCurrency,
              rpcUrls,
            } satisfies AddEthereumChainParameter

            await provider.request({
              method: 'wallet_addEthereumChain',
              params: [addEthereumChain],
            })

            return chain
          } catch (error) {
            throw new UserRejectedRequestError(error as Error)
          }
        }

        throw new SwitchChainError(error as Error)
      }
    },
    onAccountsChanged(accounts) {
      if (accounts.length === 0) this.onDisconnect()
      else
        config.emitter.emit('change', {
          accounts: accounts.map((x) => getAddress(x)),
        })
    },
    onChainChanged(chain) {
      walletChainId = Number(chain)
      config.emitter.emit('change', { chainId: walletChainId })
    },
    async onDisconnect(_error) {
      config.emitter.emit('disconnect')

      const provider = await this.getProvider()
      if (accountsChanged) {
        provider.removeListener('accountsChanged', accountsChanged)
        accountsChanged = undefined
      }
      if (chainChanged) {
        provider.removeListener('chainChanged', chainChanged)
        chainChanged = undefined
      }
      if (disconnect) {
        provider.removeListener('disconnect', disconnect)
        disconnect = undefined
      }
    },
  }))
}