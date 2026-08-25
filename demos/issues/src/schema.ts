import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

/**
 * An issue tracker: projects hold issues, issues hold comments.
 *
 * Three things are declared here that the todo list has no use for. The `relationships` argument on
 * each collection names the joins — `S.hasMany` from a project to its issues, `S.hasOne` from an
 * issue back to its project — and `weft generate` turns each one into a descriptor the client
 * resolves against rows it already holds. A comment's author is stored in `author__label` and
 * `author__device`, two flat columns whose `__` separator the generated nested mapper folds back
 * into `comment.author.label` and `comment.author.device`. And comments are an event log, so
 * their rows are append-class and cannot be edited or deleted after the transaction that wrote
 * them.
 */
export const schema = defineSchema({
  projects: S.collection(
    {
      name: S.string(),
      // Fractional index: reordering one project is one field write rather than a renumbering.
      rank: S.string({ merge: "fracIndex" }),
    },
    {
      issues: S.hasMany("issues", "id", "project_id"),
    },
  ),
  issues: S.collection(
    {
      project_id: S.string(),
      title: S.string(),
      // Prose merges line by line, so two tabs editing different lines both keep their work.
      body: S.string({ merge: "diff3" }),
      // A fixed set: the generated row type is the union, the mutators refuse anything else, and
      // the column gets a CHECK that says the same thing to the database.
      status: S.enum(["open", "started", "closed"]),
      rank: S.string({ merge: "fracIndex" }),
    },
    {
      project: S.hasOne("projects", "project_id", "id"),
      comments: S.hasMany("comments", "id", "issue_id"),
    },
  ),
  // Append-only: a comment is written once and is immutable from the next transaction on. The
  // server refuses any later `set` or `delete` on these rows, so the rule holds for every client
  // rather than only for this page, and the generated mutators carry `create` alone.
  comments: S.eventLog(
    {
      issue_id: S.string(),
      body: S.string(),
      // The thread's order. `created` cannot carry it: it is stamped from the client's clock, so
      // comments written in one pass share a millisecond, and ordering by a value several rows
      // hold leaves the tie to be broken by row id, which is a random UUID. A fractional index
      // carries the writing device, so two devices commenting at once still land in a total
      // order both agree on. Nothing reorders a comment; this only ever says where it went in.
      rank: S.string({ merge: "fracIndex" }),
      // `__` marks a nested path. The generated mapper reads these two into `author`.
      author__label: S.string(),
      author__device: S.string(),
    },
    {
      issue: S.hasOne("issues", "issue_id", "id"),
    },
  ),
});

export type Database = DatabaseOf<typeof schema>;
