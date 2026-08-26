// What a write goes through, named structurally rather than by class.
//
// Two things carry a device's writes. `WeftClient` applies them itself, against the rows and the
// outbox it holds on the thread it was built on. `WeftClientMirror` posts them to the worker that
// holds the client, and waits for the echo. Typing generated mutators against the class would pick
// the first and exclude the second, leaving an application whose database is in the storage worker
// with generated read hooks and every write to hand-write.
//
// Neither class is told about this file. It is the shape they already had, written down: nothing
// here was widened to fit, and `WeftClient` in particular satisfies it as it stands.
import type { FieldName, RowId, TableName, TxnId, WireValue } from "weftdb/core";

/**
 * The verbs a generated mutator calls. `create` and `append` differ in the class the row is opened
 * as, which is settled by the op that opens it and never afterwards, so a collection declared
 * `eventLog` reaches `append` and every other collection reaches `create`.
 *
 * Each resolves once the write has committed and rejects when the write was refused, so a caller
 * that awaits one knows which of the two happened and a caller that does not has to write down
 * that it is discarding the answer.
 *
 * `txnId` is optional on every verb because both implementations mint one when it is left out, and
 * generated code passes a derived one so that a create and its field writes land in one transaction.
 *
 * `restore` is absent. `WeftClient.restore` takes the row's values and queues a write for each;
 * `WeftClientMirror.restore` takes none, because the worker un-deletes a row the scope still holds
 * and its fields come back on the next pull. One interface over both would have to accept values in
 * a position where one of them ignores them, and a caller reading the type would have no way to
 * tell that its restore had dropped the fields it passed. A restore is reached through the class
 * that offers it.
 */
export interface MutationTarget {
  create(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId?: TxnId): Promise<void>;
  append(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId?: TxnId): Promise<void>;
  update(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId?: TxnId): Promise<void>;
  delete(tableName: TableName, rowId: RowId, txnId?: TxnId): Promise<void>;
}
