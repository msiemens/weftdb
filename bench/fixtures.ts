// The world every case measures against: the demo schema, a todo row shaped the way the
// generated mutators write one, and the two ways to stand a relay up. Transaction ids follow
// what `weft generate` emits — a deterministic one per create, a fresh one per update — so the
// numbers describe the calls an application actually makes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deviceId,
  fieldName,
  rowId,
  scopeId,
  tableName,
  txnId,
  type DeviceId,
  type FieldName,
  type RowId,
  type TxnId,
  type WireValue,
} from "weftdb/shared";
import { WeftClient, type SocketTransport } from "weftdb/client";
import { WeftServer } from "weftdb/server";
import { startRelay, type RunningServer } from "weftdb/server/serve";
import { authContext } from "weftdb/server/relay";
import { schemaHash } from "weftdb/schema";
import { schema } from "weftdb-demo-todo/schema";

export { schema };

export const SCOPE = scopeId("bench-scope");
export const TODOS = tableName("todos");
export const TITLE = fieldName("title");
export const NOTES = fieldName("notes");
export const DONE = fieldName("done");
export const RANK = fieldName("rank");
export const DUE_AT = fieldName("due_at");
export const AUTO_DELETE_DAYS = fieldName("auto_delete_days");
export const HASH = schemaHash(schema);

/** How many protocol ops one `create` of this row enqueues: the row op, three base fields, six values. */
export const OPS_PER_CREATE = 10;

export function todoValues(title: string, notes: string, rank: string): Record<FieldName, WireValue> {
  return {
    [TITLE]: title,
    [NOTES]: notes,
    [DONE]: false,
    [RANK]: rank,
    [DUE_AT]: null,
    [AUTO_DELETE_DAYS]: null,
  };
}

/** Ranks are compared as strings, so a padded base-36 counter orders the seeded rows. */
export function rankFor(index: number): string {
  return `a${index.toString(36).padStart(6, "0")}`;
}

export function todoId(index: number): RowId {
  return rowId(`todo-${index.toString(36).padStart(6, "0")}`);
}

export function benchClient(device: string): WeftClient {
  return new WeftClient(SCOPE, deviceId(device), schema);
}

/** A note long enough that a diff3 merge has something to do. */
export function notesFor(index: number): string {
  return Array.from({ length: 8 }, (_unused, line) => `line ${line} of note ${index}`).join("\n");
}

export function seedRows(client: WeftClient, count: number, from = 0): void {
  for (let index = from; index < from + count; index += 1) {
    const id = todoId(index);
    client.create(TODOS, id, todoValues(`todo ${index}`, notesFor(index), rankFor(index)), txnId(`create-${id}`));
  }
}

/** A client holding `count` rows with an empty outbox, as a device that has synced looks. */
export function syncedClient(count: number, device = "device-a"): WeftClient {
  const client = benchClient(device);
  seedRows(client, count);
  client.sync(new WeftServer(), HASH);
  return client;
}

/** The transaction id `weft generate` puts on an update, built the same way it builds it. */
export function updateTxn(id: RowId): TxnId {
  return txnId(`update-${id}-${crypto.randomUUID()}`);
}

export interface BenchRelay {
  readonly relay: RunningServer;
  readonly baseUrl: string;
  readonly socketUrl: string;
  token(device: number): string;
  device(index: number): DeviceId;
  close(): Promise<void>;
}

/**
 * A relay on the loopback interface with one token per device. Keepalive is off: a ping timer
 * firing inside a timed section is noise the numbers do not need.
 *
 * It is returned only once `/health` has answered over it, which settles two things at once. An
 * ephemeral port sometimes lands on one the fetch specification refuses to connect to at all, and
 * a relay there is unusable rather than slow; and the answer leaves the pooled connection open,
 * so no timed section afterwards pays for a TCP handshake. That last part is also what makes the
 * HTTP transport comparable with the socket one, which is connected before its first request by
 * construction.
 */
export async function startBenchRelay(devices: number, databasePath?: string): Promise<BenchRelay> {
  const tokens = new Map(
    Array.from(
      { length: devices },
      (_unused, index) => [`token-${index}`, authContext(SCOPE, `device-${index}`)] as const,
    ),
  );
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const relay = await startRelay({
      host: "127.0.0.1",
      port: 0,
      tokens,
      keepaliveMs: 0,
      ...(databasePath === undefined ? {} : { databasePath }),
    });
    if (await reachable(relay.url)) {
      return {
        relay,
        baseUrl: relay.url,
        socketUrl: `${relay.url.replace(/^http/u, "ws")}/sync`,
        token: (device) => `token-${device}`,
        device: (index) => deviceId(`device-${index}`),
        close: () => relay.close(),
      };
    }
    await relay.close();
  }
  throw new Error(`no usable loopback port after ${PORT_ATTEMPTS} attempts`);
}

const PORT_ATTEMPTS = 8;

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`);
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForSocket(socket: SocketTransport): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (socket.connected) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the bench socket never connected");
}

export interface TempDirectory extends Disposable {
  readonly path: string;
  file(name: string): string;
}

/** Somewhere under the OS temp directory for the SQLite cases, removed when the group ends. */
export function tempDirectory(): TempDirectory {
  const path = mkdtempSync(join(tmpdir(), "weftdb-bench-"));
  return {
    path,
    file: (name) => join(path, name),
    [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }),
  };
}
