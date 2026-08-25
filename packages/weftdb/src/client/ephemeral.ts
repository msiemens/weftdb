// A device whose rows are re-fetchable and whose unsent work is not.
//
// Where a browser has no OPFS synchronous access handle pool, SQLite can still run: an in-memory
// database is synchronous and needs no worker. What it cannot do is survive a reload, so the rows
// are fetched from the relay again at every start. That is affordable because the relay is where
// they came from.
//
// The outbox and the quarantine are not affordable that way. §4.1 makes local storage the client's
// state rather than a cache of it, and §10 rests on that: work made offline sits there across a
// restart until a session can push it. Nothing else holds it, so it goes to `localStorage`, where it
// is small — it is what this device has yet to send, not what it has ever written.
import { encodeHlc, type DeviceId, type HlcString, type ScopeId, type WeftOp } from "weftdb/core";
import type { ClientPersistence, QuarantinedOp, WeftClient } from "./index.ts";
import type { SqliteClientStore } from "./sqlite.ts";
import type { StorageLike } from "./web-storage.ts";

/** Bumped when the shape below changes, so a queue written by an older build is dropped, not misread. */
const FORMAT = 1;

interface StoredQueue {
  readonly version: number;
  /** The highest reading this device's clock had reached, so a restart does not stamp below it. */
  readonly hlc: HlcString | null;
  readonly outbox: readonly WeftOp[];
  readonly quarantine: readonly QuarantinedOp[];
}

export interface EphemeralClientStoreOptions {
  /** The in-memory database the rows live in, from `openMemorySqliteExecutor`. */
  readonly rows: SqliteClientStore;
  readonly storage: StorageLike;
  /** Prefixes every key written, so two applications in one origin do not collide. */
  readonly namespace?: string;
  /** Where a queue that cannot be read is reported. It is dropped either way. */
  readonly onError?: (error: Error) => void;
}

/**
 * Rows in memory, unsent work in `localStorage`.
 *
 * `hydrate` returns a client holding no rows and every op this device had queued, with its cursor
 * reset so the next sync asks for a snapshot rather than an increment: an incremental pull from a
 * cursor whose rows are gone would leave the device believing it holds what it does not.
 */
export class EphemeralClientStore implements ClientPersistence {
  readonly #rows: SqliteClientStore;
  readonly #storage: StorageLike;
  readonly #namespace: string;
  readonly #onError: (error: Error) => void;

  constructor(options: EphemeralClientStoreOptions) {
    this.#rows = options.rows;
    this.#storage = options.storage;
    this.#namespace = options.namespace ?? "weft";
    this.#onError = options.onError ?? (() => undefined);
  }

  installSchema(): void {
    this.#rows.installSchema();
  }

  hydrate(scopeId: ScopeId, deviceId: DeviceId): WeftClient {
    const client = this.#rows.hydrate(scopeId, deviceId);
    // `SqliteClientStore.hydrate` makes itself the client's persistence. Both halves have to be
    // written on every change, so this takes it over and delegates the row half back.
    client.persistence = this;

    const stored = this.#read(scopeId, deviceId);
    if (stored !== undefined) {
      client.outbox.push(...stored.outbox);
      client.quarantine.push(...stored.quarantine);
      // The clock has to come back above everything this device already stamped, or the first edit
      // after a reload carries a reading below work still queued and loses the comparison to it.
      if (stored.hlc !== null) client.clock.acknowledge(stored.hlc);
      for (const op of client.outbox) client.clock.acknowledge(op.hlc);
      for (const op of client.quarantine) client.clock.acknowledge(op.hlc);
    }

    // The rows went with the tab. A cursor is a claim about what this device has already seen, and
    // it has seen none of it, so the next sync takes a snapshot.
    client.lastServerSeq = 0;
    client.resyncRequired = true;
    return client;
  }

  save(client: WeftClient): void {
    this.#rows.save(client);
    this.#write(client);
  }

  /** Drops this device's queue, for a sign-out that is meant to leave nothing behind. */
  clear(scopeId: ScopeId, deviceId: DeviceId): void {
    this.#storage.removeItem(this.#key(scopeId, deviceId));
  }

  #write(client: WeftClient): void {
    const clock = client.clock.snapshot();
    const queue: StoredQueue = {
      version: FORMAT,
      // A clock that has never been used has nothing to preserve, and encoding wall time zero would
      // only teach the restored clock about the epoch.
      hlc: clock.wallMs === 0 ? null : encodeHlc(clock),
      outbox: [...client.outbox],
      quarantine: [...client.quarantine],
    };
    try {
      this.#storage.setItem(this.#key(client.scopeId, client.deviceId), JSON.stringify(queue));
    } catch (error) {
      // A full or refused storage is the one failure that matters here, and it is not recoverable
      // from inside a write: the work stays in memory and will be pushed if the session lasts.
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #read(scopeId: ScopeId, deviceId: DeviceId): StoredQueue | undefined {
    const raw = this.#storage.getItem(this.#key(scopeId, deviceId));
    if (raw === null) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredQueue>;
      if (parsed.version !== FORMAT || !Array.isArray(parsed.outbox) || !Array.isArray(parsed.quarantine)) {
        return undefined;
      }
      return parsed as StoredQueue;
    } catch (error) {
      // Unreadable rather than absent. Dropping it loses unsent work, which is why it is reported
      // rather than swallowed; carrying on with a half-parsed queue would be worse.
      this.#onError(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  #key(scopeId: ScopeId, deviceId: DeviceId): string {
    return `${this.#namespace}:${scopeId}:${deviceId}:queue`;
  }
}
