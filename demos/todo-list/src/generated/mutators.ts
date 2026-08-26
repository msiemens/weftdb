import type { TxnId } from "weftdb/core";

export interface TodosMutation {
  readonly title?: string;
  readonly notes?: string;
  readonly done?: boolean;
  readonly rank?: string;
  readonly due_at?: number | null;
  readonly auto_delete_days?: number | null;
}
export interface TodosMutators {
  create(id: string, values: TodosMutation, txnId?: TxnId): Promise<void>;
  update(id: string, values: TodosMutation, txnId?: TxnId): Promise<void>;
  delete(id: string, txnId?: TxnId): Promise<void>;
}

export interface TodoEventsMutation {
  readonly todo_id?: string;
  readonly kind?: string;
  readonly actor?: string;
}
export interface TodoEventsMutators {
  create(id: string, values: TodoEventsMutation, txnId?: TxnId): Promise<void>;
}
