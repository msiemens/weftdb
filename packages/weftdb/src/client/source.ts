// What a read is made against: the rows, the engine watching them, the scope they belong to, and
// how a statement is answered. `weftdb-react` re-exports these; a source is defined here, and the
// hooks are one consumer of it.
import type { ReactiveSqlQuery, RowSelect, SubscriptionEngine } from "./subscriptions.ts";
import type { LocalRow } from "./index.ts";

/**
 * What a query key is read against. `useWeftQuerySnapshot` and `useWeftRows` take this because
 * neither touches `select`, so a caller holding a client and an engine can use them without the
 * whole {@link WeftSource}. Application code names `WeftSource`.
 */
export interface QueryLifecycleSource {
  readonly engine: SubscriptionEngine;
  /**
   * The client's live row map, which is `client.rows`. A map, because this is read on every
   * render. An iterable would come back empty the second time and re-render for ever.
   */
  readonly rows: ReadonlyMap<string, LocalRow>;
}

/**
 * Everything a generated hook reads through, and the one source shape an application names.
 *
 * A `WeftClientMirror` is one of these already, and `openWeftDatabase` hands one back. A client on
 * the thread that renders becomes one by being paired with a `SubscriptionEngine` and an
 * `executorRowSelect` over the same SQLite its store writes through.
 */
export interface WeftSource extends QueryLifecycleSource {
  /**
   * Which rows a statement matched, in order, or `undefined` where this source has no answer for it
   * yet. A function, because the database is not always on the thread that renders. Where it is,
   * this runs the statement and always has an answer; where it is in a worker, this reads the ids
   * that worker last pushed and has one only once it has pushed.
   */
  readonly select: RowSelect;
  /** The scope the client was hydrated for. Generated query builders scope their statements by it. */
  readonly scopeId: string;
  /**
   * Tells whatever holds the database that this statement is being read, and stops telling it.
   *
   * Required of every source, and a pair of no-ops where the database is on the thread that
   * renders, because `select` runs the statement there and there is nobody to inform. Where the
   * database is in a worker, `select` answers out of what that worker last pushed, so a statement
   * nobody registered has no answer, for ever, and a source that quietly implemented neither member
   * would be that statement everywhere. `source.watch?.(query)` cannot report the difference
   * between a source with nothing to register and a source that forgot; requiring both members
   * makes a source that says nothing about registration a compile error.
   *
   * A caller that reads a statement registers it and hands it back when it stops.
   * `useWeftSqlSnapshot` does it in an effect, so an application reading through the generated
   * `use<Collection>Query` never sees either. Registrations are counted, so two components reading
   * one list are one registration in the worker and the first to unmount does not retire it under
   * the second.
   *
   * `watch` resolves once the statement's first answer is in. Nothing has to await it, because the
   * answer arrives as a push like any other, and the subscription is what wakes on it.
   */
  watch(query: ReactiveSqlQuery): Promise<void>;
  unwatch(query: ReactiveSqlQuery): void;
}
