// What a read is made against: the rows, the engine watching them, the scope they belong to, and
// how a statement is answered. `weftdb-react` re-exports these; the hooks are one consumer of a
// source rather than what defines one.
import type { ReactiveSqlQuery, RowSelect, SubscriptionEngine } from "./subscriptions.ts";
import type { LocalRow } from "./index.ts";

/**
 * What a query key is read against. `useWeftQuerySnapshot` and `useWeftRows` take this rather than
 * a whole {@link WeftSource}, because neither touches `select`, so a caller holding a client and an
 * engine can use them. Application code names `WeftSource`.
 */
export interface QueryLifecycleSource {
  readonly engine: SubscriptionEngine;
  /**
   * The client's live row map, which is `client.rows`. A map rather than an iterable because this
   * is read on every render: a one-shot iterator comes back empty the second time and re-renders
   * for ever.
   */
  readonly rows: ReadonlyMap<string, LocalRow>;
}

/**
 * Everything a generated hook reads through, and the one source shape an application names.
 *
 * A `WeftClientMirror` is one of these already, and `openWeftDatabase` hands one back. A client on
 * the thread that renders becomes one by being paired with a `SubscriptionEngine` and an
 * `executorRowSelect` over the same SQLite its store writes through, or by {@link rowMapSource}
 * where there is no SQLite at all.
 */
export interface WeftSource extends QueryLifecycleSource {
  /**
   * Which rows a statement matched, in order, or `undefined` where this source has no answer for it
   * yet. A function rather than an executor because the database is not always on the thread that
   * renders: where it is, this runs the statement and always has an answer, and where it is in a
   * worker, this reads the ids that worker last pushed and has one only once it has pushed.
   */
  readonly select: RowSelect;
  /** The scope the client was hydrated for. Generated query builders scope their statements by it. */
  readonly scopeId: string;
  /**
   * Tells whatever holds the database that this statement is being read, and stops telling it.
   *
   * Required of every source, and a pair of no-ops where the database is on the thread that
   * renders: `select` runs the statement there and there is nobody to inform. Where the database is
   * in a worker, `select` answers out of what that worker last pushed — so a statement nobody
   * registered has no answer, for ever, and a source that quietly implemented neither member would
   * be that statement everywhere. `source.watch?.(query)` cannot report the difference between a
   * source with nothing to register and a source that forgot; requiring both members makes a source
   * that says nothing about registration a compile error instead.
   *
   * A caller that reads a statement registers it and hands it back when it stops:
   * `useWeftSqlSnapshot` does it in an effect, so an application reading through the generated
   * `use<Collection>Query` never sees either. Registrations are counted, so two components reading
   * one list are one registration in the worker and the first to unmount does not retire it under
   * the second.
   *
   * `watch` resolves once the statement's first answer is in. Nothing has to await it: the answer
   * arrives as a push like any other, and the subscription is what wakes on it.
   */
  watch(query: ReactiveSqlQuery): Promise<void>;
  unwatch(query: ReactiveSqlQuery): void;
}

/** Raised where a statement-backed read is asked of a device that keeps no SQL database. */
export class SqlQueryUnavailableError extends Error {
  constructor(message = "this device has no SQL database, so a statement-backed query cannot run on it") {
    super(message);
    this.name = "SqlQueryUnavailableError";
  }
}

/**
 * A source for a device whose rows live somewhere other than SQLite, such as one persisting through
 * `WebStorageClientStore` on the thread that renders.
 *
 * `useWeftRows` and the generated `use<Collection>` read the row map and work unchanged. A
 * statement-backed read has nothing to run against, so `select` raises
 * {@link SqlQueryUnavailableError} rather than answering with no rows, which is indistinguishable
 * from a statement that matched nothing.
 */
export function rowMapSource(source: QueryLifecycleSource, scopeId: string): WeftSource {
  return {
    engine: source.engine,
    rows: source.rows,
    scopeId,
    select: () => {
      throw new SqlQueryUnavailableError();
    },
    // Registration is how a statement reaches a database somewhere else. No statement runs against
    // this device at all — `select` is where that is said — so there is nothing to register and
    // nothing to hand back.
    watch: () => Promise.resolve(),
    unwatch: () => undefined,
  };
}
