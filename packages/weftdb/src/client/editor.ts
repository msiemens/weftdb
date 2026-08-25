import type { FieldName, RowId, TableName } from "weftdb/shared";

export interface BufferedRemoteEdit {
  readonly tableName: TableName;
  readonly rowId: RowId;
  readonly fieldName: FieldName;
  readonly value: string;
}

export class Diff3EditorBuffer {
  #focused = false;
  readonly #pending: BufferedRemoteEdit[] = [];

  focus(): void {
    this.#focused = true;
  }

  blur(): readonly BufferedRemoteEdit[] {
    this.#focused = false;
    return this.flush();
  }

  receiveRemote(edit: BufferedRemoteEdit): readonly BufferedRemoteEdit[] {
    if (this.#focused) {
      this.#pending.push(edit);
      return [];
    }
    return [edit];
  }

  flush(): readonly BufferedRemoteEdit[] {
    const edits = [...this.#pending];
    this.#pending.length = 0;
    return edits;
  }
}
