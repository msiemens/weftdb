import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

/**
 * A shared todo list. Each field is annotated with how it should merge when two tabs touch it
 * while apart, which is the only place the application says anything about sync.
 */
export const schema = defineSchema({
  todos: S.collection({
    title: S.string(),
    // Prose merges line by line rather than last-writer-wins, so two tabs editing different
    // lines of the same note both keep their work.
    notes: S.string({ merge: "diff3" }),
    done: S.boolean(),
    // Ordering is a fractional index, so dragging one row is one field write rather than a
    // renumbering of everything below it.
    rank: S.string({ merge: "fracIndex" }),
    due_at: S.number({ nullable: true, retentionAnchor: true }),
    auto_delete_days: S.number({ nullable: true }),
  }),
  // Append-only: rows are written once and are immutable from the next transaction on, so
  // two tabs writing history at once always agree on it without anyone merging anything.
  todo_events: S.eventLog({
    todo_id: S.string(),
    kind: S.string(),
    actor: S.string(),
  }),
});

export type Database = DatabaseOf<typeof schema>;
