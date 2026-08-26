import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

/**
 * A chat room. Two collections, and the difference between them is the whole schema: a message
 * is written once and never changes, a device record is rewritten every few seconds.
 */
export const schema = defineSchema({
  // Append-class rows: created once, never edited and never deleted, so two devices posting at
  // the same moment produce two messages rather than one write racing another. The generated
  // mutators carry `create` alone, and the server rejects anything else against these rows.
  messages: S.eventLog({
    body: S.string(),
    /** The device that wrote it, so a tab can find its own messages in the log. */
    device: S.string(),
    /** What that device calls itself, kept on the row so the log reads without a join. */
    author: S.string(),
  }),
  // A mutable collection alongside the log: one row per device, rewritten on every heartbeat.
  // Last-writer-wins is the right merge for a value whose only reader wants the newest one.
  devices: S.collection({
    // The device strip selects on it, so the statement it runs after every heartbeat reads an index.
    label: S.string({ index: true }),
    last_seen: S.number(),
  }),
});

export type Database = DatabaseOf<typeof schema>;
