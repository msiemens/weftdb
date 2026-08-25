// What a write goes through, named structurally rather than by class.
//
// Two things carry a device's writes. `WeftClient` applies them itself, against the rows and the
// outbox it holds on the thread it was built on. `WeftClientMirror` posts them to the worker that
// holds the client, and waits for the echo. Typing generated mutators against the class picked the
// first and excluded the second, so an application storing its data in OPFS got generated read
// hooks and had to hand-write every write — the one gap left in that path.
//
// Neither class is told about this file. It is the shape they already had, written down: nothing
// here was widened to fit, and `WeftClient` in particular satisfies it as it stands.
import type { FieldName, RowId, TableName, TxnId, WireValue } from "weftdb/core";
import type { MaterializedRow } from "./index.ts";

/**
 * The verbs a generated mutator calls. `create` and `append` differ in the class the row is opened
 * as, which is settled by the op that opens it and never afterwards, so a collection declared
 * `eventLog` reaches `append` and every other collection reaches `create`.
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
  create(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId?: TxnId): void;
  append(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId?: TxnId): void;
  update(tableName: TableName, rowId: RowId, values: Record<FieldName, WireValue>, txnId?: TxnId): void;
  delete(tableName: TableName, rowId: RowId, txnId?: TxnId): void;
}

/**
 * The same, plus the two reads `WeftDb` answers `get` and `list` from. Split out rather than folded
 * in, so generated mutators keep asking for writes alone: they never read, and a target that could
 * only write would otherwise be refused by them for a capability they do not use.
 */
export interface WeftDbTarget extends MutationTarget {
  getRow(tableName: TableName, rowId: RowId): MaterializedRow | undefined;
  listRows(tableName: TableName): MaterializedRow[];
}
