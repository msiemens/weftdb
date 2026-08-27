import { defineSchema, S, type DatabaseOf } from "weftdb/schema";

/**
 * Projects hold issues, and issues hold comments.
 *
 * The `relationships` argument on each collection names the joins: `S.hasMany` from a project to
 * its issues and `S.hasOne` from an issue back to its project. `weft generate` turns each one into
 * a descriptor the client resolves against rows it already holds.
 *
 * A comment's author is stored in `author__label` and `author__device`, two flat columns whose
 * `__` separator the generated nested mapper folds back into `comment.author.label` and
 * `comment.author.device`.
 *
 * Comments are an event log, so their rows are append-class and cannot be edited or deleted after
 * the transaction that wrote them.
 */
export const schema = defineSchema({
  projects: S.collection(
    {
      name: S.string(),
      // A fractional index turns reordering one project into a single field write, without
      // renumbering every row after it.
      rank: S.string({ merge: "fracIndex" }),
    },
    {
      issues: S.hasMany("issues", "id", "project_id"),
    },
  ),
  issues: S.collection(
    {
      // The rail narrows the list to one project, so this is what the statement reads.
      project_id: S.string({ index: true }),
      title: S.string(),
      // Prose merges line by line, so two tabs editing different lines both keep their work.
      body: S.string({ merge: "diff3" }),
      // The set of values is fixed because the generated row type is the union, the mutators
      // refuse anything else, and the column carries a CHECK that says the same thing to the
      // database.
      status: S.enum(["open", "started", "closed"], { index: true }),
      rank: S.string({ merge: "fracIndex", index: true }),
    },
    {
      project: S.hasOne("projects", "project_id", "id"),
      comments: S.hasMany("comments", "id", "issue_id"),
    },
  ),
  // A comment is written once and is immutable from the next transaction on, because the server
  // refuses any later `set` or `delete` on these rows for every client. The generated mutators
  // carry `create` alone.
  comments: S.eventLog(
    {
      // Every query against this collection filters to one issue's thread, which is why the
      // column is indexed.
      issue_id: S.string({ index: true }),
      body: S.string(),
      // This carries the thread's order. `created` is stamped from the client's clock, so
      // comments written in one pass can share a millisecond, and the collection has no other
      // value to break the tie except the row id, a random UUID. A fractional index carries the
      // writing device, so two devices commenting at once still land in a total order both agree
      // on. A comment's rank is set once, when it is created, and never changes afterward.
      rank: S.string({ merge: "fracIndex" }),
      // `__` marks a nested path. The generated mapper reads these into `author.label` and
      // `author.device`.
      author__label: S.string(),
      author__device: S.string(),
    },
    {
      issue: S.hasOne("issues", "issue_id", "id"),
    },
  ),
});

export type Database = DatabaseOf<typeof schema>;
