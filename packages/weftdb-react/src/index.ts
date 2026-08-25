import { useCallback, useRef, useSyncExternalStore } from "react";
import { hasConflictMarkers } from "weftdb/core";
import type { MaterializedRow, QuerySnapshot, SubscriptionEngine, QueryKey, TypedQueryKey } from "weftdb/client";

/**
 * A store this can subscribe to, and the keys it accepts. The key type comes from the source
 * rather than being `string`: a source that knows its own keys — a union of the queries it
 * was built with, or a branded id — makes asking it for something it does not have a compile
 * error instead of an `undefined` at runtime.
 */
export interface SubscriptionSource<Value, Key extends SubscriptionKey = string> {
  // Written as function properties rather than methods on purpose: TypeScript compares method
  // parameters bivariantly, which would let a source that accepts two keys stand in for one
  // asked for a third — exactly the mistake this type exists to catch.
  readonly getSnapshot: (key: Key) => Value;
  readonly subscribe: (key: Key, listener: () => void) => () => void;
}

/** Keys have to be usable as a cache key, which is what rules out arbitrary objects. */
export type SubscriptionKey = string | number;

export function useWeftQuery<Value, Key extends SubscriptionKey>(
  source: SubscriptionSource<Value, Key>,
  key: Key,
): Value {
  const subscribe = useCallback((listener: () => void) => source.subscribe(key, listener), [source, key]);
  const getSnapshot = useCallback(() => source.getSnapshot(key), [source, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface SuspenseSubscriptionSource<Value, Key extends SubscriptionKey = string> extends SubscriptionSource<
  Value | undefined,
  Key
> {
  readonly load: (key: Key) => Promise<Value>;
}

/**
 * In-flight loads, per source. A key is only unique within the source that issues it, so a
 * single map of keys makes two sources asked for `"shared-key"` share one load: the second is
 * never asked for its own, and renders the first one's value. The outer map is weak so a source
 * that goes out of scope takes its in-flight loads with it.
 */
const suspensePromises = new WeakMap<object, Map<SubscriptionKey, Promise<unknown>>>();

export function useWeftSuspenseQuery<Value, Key extends SubscriptionKey>(
  source: SuspenseSubscriptionSource<Value, Key>,
  key: Key,
): Value {
  const value = useWeftQuery(source, key);
  if (value !== undefined) return value;
  const pending = suspensePromises.get(source) ?? new Map<SubscriptionKey, Promise<unknown>>();
  suspensePromises.set(source, pending);
  const promise = pending.get(key) ?? source.load(key).finally(() => pending.delete(key));
  pending.set(key, promise);
  // Throwing the promise is how Suspense is told to wait for it, so this is the protocol rather
  // than an error being raised.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw promise;
}

export interface QueryLifecycleSource {
  readonly engine: SubscriptionEngine;
  /**
   * The client's live row map — `client.rows`. It is a map rather than an iterable because
   * this is read on every render: a one-shot iterator would come back empty the second time
   * and re-render forever.
   */
  readonly rows: ReadonlyMap<string, import("weftdb/client").LocalRow>;
}

export function useWeftQuerySnapshot(source: QueryLifecycleSource, key: QueryKey): QuerySnapshot {
  const subscribe = useCallback((listener: () => void) => source.engine.subscribe(key, listener), [source, key]);
  const getSnapshot = useCallback(() => source.engine.getSnapshot(key, source.rows.values()), [source, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * A query's rows, decoded into whatever the schema says they are. The decoded array is cached
 * against the snapshot it came from: rebuilding it on every render would hand React a new
 * array each time, which is an infinite update loop rather than a slow render. Generated hooks
 * are built on this, so an application never has to know that.
 */
export function useWeftRows<Row>(
  source: QueryLifecycleSource,
  key: TypedQueryKey<Row>,
  decode: (row: MaterializedRow) => Row,
): readonly Row[] {
  const snapshot = useWeftQuerySnapshot(source, key);
  const cache = useRef<{ snapshot: QuerySnapshot; rows: readonly Row[] } | undefined>(undefined);
  if (cache.current?.snapshot !== snapshot) {
    cache.current = { snapshot, rows: snapshot.rows.map((row) => decode(row)) };
  }
  return cache.current.rows;
}

export interface ConflictRecord {
  readonly row: MaterializedRow;
  readonly field: string;
  readonly value: string;
}

export function useWeftConflicts(rows: readonly MaterializedRow[]): readonly ConflictRecord[] {
  return rows.flatMap((row) =>
    [...row.fields.entries()].flatMap(([field, value]) =>
      typeof value === "string" && hasConflictMarkers(value) ? [{ row, field, value }] : [],
    ),
  );
}

export class QueryCache<T> implements SubscriptionSource<T | undefined> {
  readonly values = new Map<string, T>();
  readonly listeners = new Map<string, Set<() => void>>();

  getSnapshot(key: string): T | undefined {
    return this.values.get(key);
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  publish(key: string, value: T): void {
    this.values.set(key, value);
    queueMicrotask(() => {
      for (const listener of this.listeners.get(key) ?? []) listener();
    });
  }
}
