export interface Database {
  todos: {
    id: string;
    scope_id: string;
    created: string;
    title: string;
    notes: string;
    done: boolean;
    rank: string;
    due_at: number | null;
    auto_delete_days: number | null;
  };
  todo_events: {
    id: string;
    scope_id: string;
    created: string;
    todo_id: string;
    kind: string;
    actor: string;
  };
}
