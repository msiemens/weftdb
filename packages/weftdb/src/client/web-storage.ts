// Durable local state for a browser tab. §4.1 makes local storage the client's state rather
// than a cache of it, so a reload has to bring back unsent ops, quarantined work and the sync
// cursor exactly as they were — a tab that forgets its outbox has silently discarded a write
// somebody made.
import { encodeHlc, type DeviceId, type HlcString, type ScopeId, type WeftOp } from "weftdb/core";
import type { SchemaDefinition } from "weftdb/schema";
import { WeftClient, type ClientPersistence, type LocalRow, type QuarantinedOp, type Tombstone } from "./index.ts";

/** The slice of the DOM `Storage` interface this needs — `localStorage` satisfies it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const FORMAT = 1;

interface StoredClient {
  readonly version: number;
  readonly scopeId: ScopeId;
  readonly deviceId: DeviceId;
  readonly lastServerSeq: number;
  readonly resyncRequired: boolean;
  /** The clock's own last stamp, so a reload inside the same millisecond cannot repeat it. */
  readonly hlc: HlcString | null;
  readonly rows: readonly (readonly [string, StoredRow])[];
  readonly tombstones: readonly (readonly [string, Tombstone])[];
  readonly outbox: readonly WeftOp[];
  readonly quarantine: readonly QuarantinedOp[];
}

interface StoredRow {
  readonly id: LocalRow["id"];
  readonly scopeId: ScopeId;
  readonly tableName: LocalRow["tableName"];
  readonly created: string;
  readonly fields: readonly (readonly [string, LocalRow["fields"] extends Map<unknown, infer V> ? V : never])[];
  readonly internals: {
    readonly firstSyncedAt: number | null;
    readonly rev: number;
    readonly dirty: number;
    readonly hlc: readonly (readonly [string, HlcString])[];
    readonly diff3Base: readonly (readonly [string, StoredValue])[];
  };
}

type StoredValue = LocalRow["fields"] extends Map<unknown, infer V> ? V : never;

export class WebStorageClientStore implements ClientPersistence {
  readonly storage: StorageLike;
  readonly schema: SchemaDefinition;
  readonly namespace: string;

  constructor(storage: StorageLike, schema: SchemaDefinition, namespace = "weft") {
    this.storage = storage;
    this.schema = schema;
    this.namespace = namespace;
  }

  /** Makes this store the client's durable state: every change is written through to it. */
  attach(client: WeftClient): WeftClient {
    client.persistence = this;
    this.save(client);
    return client;
  }

  /** The client as it was left, or a fresh one if this device has never written here. */
  hydrate(scopeId: ScopeId, deviceId: DeviceId, now?: () => number): WeftClient {
    const client = new WeftClient(scopeId, deviceId, this.schema, now);
    const stored = this.read(scopeId, deviceId);
    if (stored !== undefined) restoreInto(client, stored);
    client.persistence = this;
    return client;
  }

  save(client: WeftClient): void {
    this.storage.setItem(this.key(client.scopeId, client.deviceId), JSON.stringify(serializeClient(client)));
  }

  forget(scopeId: ScopeId, deviceId: DeviceId): void {
    this.storage.removeItem(this.key(scopeId, deviceId));
  }

  private read(scopeId: ScopeId, deviceId: DeviceId): StoredClient | undefined {
    const raw = this.storage.getItem(this.key(scopeId, deviceId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as StoredClient;
    // A format this build does not understand is dropped rather than half-applied: partially
    // restored local state is worse than an honest resync from the server.
    return parsed.version === FORMAT ? parsed : undefined;
  }

  private key(scopeId: ScopeId, deviceId: DeviceId): string {
    return `${this.namespace}/${scopeId}/${deviceId}`;
  }
}

export function serializeClient(client: WeftClient): StoredClient {
  const clock = client.clock.snapshot();
  return {
    version: FORMAT,
    scopeId: client.scopeId,
    deviceId: client.deviceId,
    lastServerSeq: client.lastServerSeq,
    resyncRequired: client.resyncRequired,
    // A clock that has never been used has nothing to preserve; encoding wallMs 0 would only
    // teach the restored clock about the epoch.
    hlc: clock.wallMs === 0 ? null : encodeHlc(clock),
    rows: [...client.rows].map(([key, row]) => [key, serializeRow(row)] as const),
    tombstones: [...client.tombstones].map(([key, tombstone]) => [key, tombstone] as const),
    outbox: [...client.outbox],
    quarantine: [...client.quarantine],
  };
}

function serializeRow(row: LocalRow): StoredRow {
  return {
    id: row.id,
    scopeId: row.scopeId,
    tableName: row.tableName,
    created: row.created,
    fields: [...row.fields].map(([field, value]) => [field, value] as const),
    internals: {
      firstSyncedAt: row.internals._weft_first_synced_at,
      rev: row.internals._weft_rev,
      dirty: row.internals._weft_dirty,
      hlc: [...row.internals.hlc].map(([field, hlc]) => [field, hlc] as const),
      diff3Base: [...row.internals.diff3Base].map(([field, value]) => [field, value] as const),
    },
  };
}

function restoreInto(client: WeftClient, stored: StoredClient): void {
  for (const [key, row] of stored.rows) client.rows.set(key, deserializeRow(row));
  for (const [key, tombstone] of stored.tombstones) client.tombstones.set(key, tombstone);
  client.outbox.push(...stored.outbox);
  client.quarantine.push(...stored.quarantine);
  client.lastServerSeq = stored.lastServerSeq;
  client.resyncRequired = stored.resyncRequired;
  // Folding the stored stamp back in keeps this device's writes ordered after its own past
  // ones even when the reload lands in the same millisecond the tab died in.
  if (stored.hlc !== null) client.clock.observe(stored.hlc);
  // Retry counts deliberately start over: a restart is a new attempt at the same work, and
  // the bound exists to stop a live loop, not to condemn an op across sessions.
}

function deserializeRow(stored: StoredRow): LocalRow {
  return {
    id: stored.id,
    scopeId: stored.scopeId,
    tableName: stored.tableName,
    created: stored.created,
    fields: new Map(stored.fields) as LocalRow["fields"],
    internals: {
      _weft_first_synced_at: stored.internals.firstSyncedAt,
      _weft_rev: stored.internals.rev,
      _weft_dirty: stored.internals.dirty,
      hlc: new Map(stored.internals.hlc) as LocalRow["internals"]["hlc"],
      diff3Base: new Map(stored.internals.diff3Base) as LocalRow["internals"]["diff3Base"],
    },
  };
}

export type { StoredClient, StoredValue };
