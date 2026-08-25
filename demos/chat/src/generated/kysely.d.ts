import type { ColumnType, Generated } from 'kysely';

export interface Database {
  messages: {
    id: ColumnType<string, string, never>;
    scope_id: ColumnType<string, string, never>;
    created: ColumnType<string, string, never>;
    body: ColumnType<string, string, string | undefined>;
    device: ColumnType<string, string, string | undefined>;
    author: ColumnType<string, string, string | undefined>;
  };
  devices: {
    id: ColumnType<string, string, never>;
    scope_id: ColumnType<string, string, never>;
    created: ColumnType<string, string, never>;
    label: ColumnType<string, string, string | undefined>;
    last_seen: ColumnType<number, number, number | undefined>;
  };
}

export interface InternalDatabase {
  messages: {
    id: ColumnType<string, string, never>;
    _weft_hlc_id: string | null;
    scope_id: ColumnType<string, string, never>;
    _weft_hlc_scope_id: string | null;
    created: ColumnType<string, string, never>;
    _weft_hlc_created: string | null;
    body: ColumnType<string, string, string | undefined>;
    _weft_hlc_body: string | null;
    device: ColumnType<string, string, string | undefined>;
    _weft_hlc_device: string | null;
    author: ColumnType<string, string, string | undefined>;
    _weft_hlc_author: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: Generated<number>;
    _weft_dirty: Generated<number>;
    _weft_null_fields: string | null;
  };
  devices: {
    id: ColumnType<string, string, never>;
    _weft_hlc_id: string | null;
    scope_id: ColumnType<string, string, never>;
    _weft_hlc_scope_id: string | null;
    created: ColumnType<string, string, never>;
    _weft_hlc_created: string | null;
    label: ColumnType<string, string, string | undefined>;
    _weft_hlc_label: string | null;
    last_seen: ColumnType<number, number, number | undefined>;
    _weft_hlc_last_seen: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: Generated<number>;
    _weft_dirty: Generated<number>;
    _weft_null_fields: string | null;
  };
}
