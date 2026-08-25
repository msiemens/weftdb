import type { ColumnType, Generated } from 'kysely';

export interface Database {
  todos: {
    id: ColumnType<string, string, never>;
    scope_id: ColumnType<string, string, never>;
    created: ColumnType<string, string, never>;
    title: ColumnType<string, string, string | undefined>;
    notes: ColumnType<string, string, string | undefined>;
    done: ColumnType<boolean, boolean, boolean | undefined>;
    rank: ColumnType<string, string, string | undefined>;
    due_at: ColumnType<number | null, number | null | undefined, number | null>;
    auto_delete_days: ColumnType<number | null, number | null | undefined, number | null>;
  };
  todo_events: {
    id: ColumnType<string, string, never>;
    scope_id: ColumnType<string, string, never>;
    created: ColumnType<string, string, never>;
    todo_id: ColumnType<string, string, string | undefined>;
    kind: ColumnType<string, string, string | undefined>;
    actor: ColumnType<string, string, string | undefined>;
  };
}

export interface InternalDatabase {
  todos: {
    id: ColumnType<string, string, never>;
    _weft_hlc_id: string | null;
    scope_id: ColumnType<string, string, never>;
    _weft_hlc_scope_id: string | null;
    created: ColumnType<string, string, never>;
    _weft_hlc_created: string | null;
    title: ColumnType<string, string, string | undefined>;
    _weft_hlc_title: string | null;
    notes: ColumnType<string, string, string | undefined>;
    _weft_hlc_notes: string | null;
    _weft_base_notes: string | null;
    done: ColumnType<boolean, boolean, boolean | undefined>;
    _weft_hlc_done: string | null;
    rank: ColumnType<string, string, string | undefined>;
    _weft_hlc_rank: string | null;
    due_at: ColumnType<number | null, number | null | undefined, number | null>;
    _weft_hlc_due_at: string | null;
    auto_delete_days: ColumnType<number | null, number | null | undefined, number | null>;
    _weft_hlc_auto_delete_days: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: Generated<number>;
    _weft_dirty: Generated<number>;
    _weft_null_fields: string | null;
  };
  todo_events: {
    id: ColumnType<string, string, never>;
    _weft_hlc_id: string | null;
    scope_id: ColumnType<string, string, never>;
    _weft_hlc_scope_id: string | null;
    created: ColumnType<string, string, never>;
    _weft_hlc_created: string | null;
    todo_id: ColumnType<string, string, string | undefined>;
    _weft_hlc_todo_id: string | null;
    kind: ColumnType<string, string, string | undefined>;
    _weft_hlc_kind: string | null;
    actor: ColumnType<string, string, string | undefined>;
    _weft_hlc_actor: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: Generated<number>;
    _weft_dirty: Generated<number>;
    _weft_null_fields: string | null;
  };
}
