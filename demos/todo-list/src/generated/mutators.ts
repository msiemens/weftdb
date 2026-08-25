export interface TodosMutation {
  readonly title?: string;
  readonly notes?: string;
  readonly done?: boolean;
  readonly rank?: string;
  readonly due_at?: number | null;
  readonly auto_delete_days?: number | null;
}
export interface TodosMutators {
  create(id: string, values: TodosMutation): void;
  update(id: string, values: TodosMutation): void;
  delete(id: string): void;
}

export interface TodoEventsMutation {
  readonly todo_id?: string;
  readonly kind?: string;
  readonly actor?: string;
}
export interface TodoEventsMutators {
  create(id: string, values: TodoEventsMutation): void;
}
