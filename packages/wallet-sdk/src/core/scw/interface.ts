import { AddressString, Chain } from '../type';

type UpdateSource = 'wallet' | 'storage';

export interface AccountsUpdate {
  accounts: AddressString[];
  source: UpdateSource;
}

export interface ChainUpdate {
  chain: Chain;
  source: UpdateSource;
}

export interface StateUpdateListener {
  onAccountsUpdate: (_: AccountsUpdate) => void;
  onChainUpdate: (_: ChainUpdate) => void;
}
