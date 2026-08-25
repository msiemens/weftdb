import type { ColumnType, Generated } from 'kysely';

export interface Database {
  projects: {
    id: ColumnType<string, string, never>;
    scope_id: ColumnType<string, string, never>;
    created: ColumnType<string, string, never>;
    name: ColumnType<string, string, string | undefined>;
    rank: ColumnType<string, string, string | undefined>;
  };
  issues: {
    id: ColumnType<string, string, never>;
    scope_id: ColumnType<string, string, never>;
    created: ColumnType<string, string, never>;
    project_id: ColumnType<string, string, string | undefined>;
    title: ColumnType<string, string, string | undefined>;
    body: ColumnType<string, string, string | undefined>;
    status: ColumnType<"open" | "started" | "closed", "open" | "started" | "closed", "open" | "started" | "closed" | undefined>;
    rank: ColumnType<string, string, string | undefined>;
  };
  comments: {
    id: ColumnType<string, string, never>;
    scope_id: ColumnType<string, string, never>;
    created: ColumnType<string, string, never>;
    issue_id: ColumnType<string, string, string | undefined>;
    body: ColumnType<string, string, string | undefined>;
    rank: ColumnType<string, string, string | undefined>;
    author__label: ColumnType<string, string, string | undefined>;
    author__device: ColumnType<string, string, string | undefined>;
  };
}

export interface InternalDatabase {
  projects: {
    id: ColumnType<string, string, never>;
    _weft_hlc_id: string | null;
    scope_id: ColumnType<string, string, never>;
    _weft_hlc_scope_id: string | null;
    created: ColumnType<string, string, never>;
    _weft_hlc_created: string | null;
    name: ColumnType<string, string, string | undefined>;
    _weft_hlc_name: string | null;
    rank: ColumnType<string, string, string | undefined>;
    _weft_hlc_rank: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: Generated<number>;
    _weft_dirty: Generated<number>;
    _weft_null_fields: string | null;
  };
  issues: {
    id: ColumnType<string, string, never>;
    _weft_hlc_id: string | null;
    scope_id: ColumnType<string, string, never>;
    _weft_hlc_scope_id: string | null;
    created: ColumnType<string, string, never>;
    _weft_hlc_created: string | null;
    project_id: ColumnType<string, string, string | undefined>;
    _weft_hlc_project_id: string | null;
    title: ColumnType<string, string, string | undefined>;
    _weft_hlc_title: string | null;
    body: ColumnType<string, string, string | undefined>;
    _weft_hlc_body: string | null;
    _weft_base_body: string | null;
    status: ColumnType<"open" | "started" | "closed", "open" | "started" | "closed", "open" | "started" | "closed" | undefined>;
    _weft_hlc_status: string | null;
    rank: ColumnType<string, string, string | undefined>;
    _weft_hlc_rank: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: Generated<number>;
    _weft_dirty: Generated<number>;
    _weft_null_fields: string | null;
  };
  comments: {
    id: ColumnType<string, string, never>;
    _weft_hlc_id: string | null;
    scope_id: ColumnType<string, string, never>;
    _weft_hlc_scope_id: string | null;
    created: ColumnType<string, string, never>;
    _weft_hlc_created: string | null;
    issue_id: ColumnType<string, string, string | undefined>;
    _weft_hlc_issue_id: string | null;
    body: ColumnType<string, string, string | undefined>;
    _weft_hlc_body: string | null;
    rank: ColumnType<string, string, string | undefined>;
    _weft_hlc_rank: string | null;
    author__label: ColumnType<string, string, string | undefined>;
    _weft_hlc_author__label: string | null;
    author__device: ColumnType<string, string, string | undefined>;
    _weft_hlc_author__device: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: Generated<number>;
    _weft_dirty: Generated<number>;
    _weft_null_fields: string | null;
  };
}
