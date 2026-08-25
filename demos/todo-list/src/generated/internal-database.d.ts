export interface InternalDatabase {
  todos: {
    id: string;
    _weft_hlc_id: string | null;
    scope_id: string;
    _weft_hlc_scope_id: string | null;
    created: string;
    _weft_hlc_created: string | null;
    title: string;
    _weft_hlc_title: string | null;
    notes: string;
    _weft_hlc_notes: string | null;
    _weft_base_notes: string | null;
    done: boolean;
    _weft_hlc_done: string | null;
    rank: string;
    _weft_hlc_rank: string | null;
    due_at: number | null;
    _weft_hlc_due_at: string | null;
    auto_delete_days: number | null;
    _weft_hlc_auto_delete_days: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: number;
    _weft_dirty: number;
  };
  todo_events: {
    id: string;
    _weft_hlc_id: string | null;
    scope_id: string;
    _weft_hlc_scope_id: string | null;
    created: string;
    _weft_hlc_created: string | null;
    todo_id: string;
    _weft_hlc_todo_id: string | null;
    kind: string;
    _weft_hlc_kind: string | null;
    actor: string;
    _weft_hlc_actor: string | null;
    _weft_first_synced_at: number | null;
    _weft_rev: number;
    _weft_dirty: number;
  };
}
