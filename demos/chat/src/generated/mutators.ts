import type { TxnId } from "weftdb/core";

export interface MessagesMutation {
  readonly body?: string;
  readonly device?: string;
  readonly author?: string;
}
export interface MessagesMutators {
  create(id: string, values: MessagesMutation, txnId?: TxnId): Promise<void>;
}

export interface DevicesMutation {
  readonly label?: string;
  readonly last_seen?: number;
}
export interface DevicesMutators {
  create(id: string, values: DevicesMutation, txnId?: TxnId): Promise<void>;
  update(id: string, values: DevicesMutation, txnId?: TxnId): Promise<void>;
  delete(id: string, txnId?: TxnId): Promise<void>;
}
