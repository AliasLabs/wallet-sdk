import { Message } from './Message';
import { SerializedEthereumRpcError } from '../error';
import { AppMetadata, RequestArguments } from '../provider/interface';
import type { RPCResponse } from './RPCResponse';

interface RPCMessage extends Message {
  // id: MessageID;
  // sender: string; // hex encoded public key of the sender
  content: unknown;
  timestamp: Date;
}

export type EncryptedData = {
  iv: ArrayBuffer;
  cipherText: ArrayBuffer;
};

export interface RPCRequestMessage extends RPCMessage {
  content:
    | {
        handshake: RequestAccountsAction;
      }
    | {
        encrypted: EncryptedData;
      }
    | {
        action: RequestArguments;
        chainId: number
      };
}

export interface RPCResponseMessage extends RPCMessage {
  // requestId: MessageID;
  content:
    | {
        encrypted: EncryptedData;
      }
    | {
        failure: SerializedEthereumRpcError;
      }
    | RPCResponse<unknown>;
}

type RequestAccountsAction = {
  method: 'eth_requestAccounts';
  params: AppMetadata;
};
