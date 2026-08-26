// One browser, for the demos to be opened in.
//
// Everything the demos ship is real here and only the browser is stood in for. Each tab runs the
// shipped `serveDemoStorageWorker` over a `MessageChannel` — the same module a `Worker` loads, with
// the far end of the channel standing in for the worker's global — and syncs through the shipped
// `serveDemoRelay`, reached over a port that is genuinely transferred into that worker rather than
// passed by reference. The election, the port broker, the device ids and the OPFS pool are the
// library's own, driven through `openWeftDatabase` exactly as a page drives them.
//
// What a namespace is here is what it is in a browser: the identity of one database. Each tab of a
// demo takes one of its own, which is what makes a second tab a second device, so the file each
// worker opens is keyed on it. A worker that closes its database does not lose it — that is what
// OPFS gives and what makes a reload a reload rather than a fresh device.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { SessionStatus, StorageLike, WorkerHostPortLike, WorkerLike, WorkerMessage } from "weftdb/client";
import type { SchemaDefinition } from "weftdb/schema";
import type { Sqlite3Module, WasmDatabase } from "weftdb/client/wasm-sqlite";
import { tabIdentity, type TabIdentity } from "weftdb-demo-shared/identity";
import { openDemoDatabase, type DemoDatabase, type DemoOpenOverrides } from "weftdb-demo-shared/open";
import type { RelayPortLike } from "weftdb-demo-shared/port-transport";
import { serveDemoRelay, type WeftDemoRelay } from "weftdb-demo-shared/relay-worker";
import { serveDemoStorageWorker } from "weftdb-demo-shared/storage-worker";
import { BrokerHub, PortEndpoint, QueuedLocks } from "./multitab-fixtures.ts";

/** The build that ships to a browser, minus the OPFS pool `DemoBrowser` puts back per namespace. */
const sqlite3: Sqlite3Module = await sqlite3InitModule();

/** Storage that behaves like the browser's: string in, string out, nothing shared by accident. */
export function memoryStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, String(value)),
    removeItem: (key) => void entries.delete(key),
  };
}

export interface DemoBrowserOptions {
  /** The demo's schema, which is what its storage workers open a database for. */
  readonly schema: SchemaDefinition;
  /** The demo's slug, which is what its scope and its namespaces are named after. */
  readonly demo: string;
}

export interface TabOptions {
  /**
   * Whether this tab is given a port to the relay. `false` is a browser with nowhere to run one,
   * which is a demo that works and does not sync — the state a local-first page is built for.
   */
  readonly relay?: boolean;
  /** Where a mutation the worker refused is reported, since a mutator returns `void`. */
  readonly onError?: (error: Error) => void;
}

/** One tab's half of a demo: who it says it is, and the database it opened. */
export interface DemoTab {
  readonly identity: TabIdentity;
  readonly database: DemoDatabase;
}

/**
 * Runs syncs until a device has nothing left to send.
 *
 * `syncing` is half the condition rather than decoration. The worker's session starts a sync of its
 * own the moment a token reaches it, which is before anything the page did has crossed the port, and
 * a status published from inside that sync reports an outbox that is empty because nothing has been
 * put in it yet. Waiting for the sync to finish as well is what makes "nothing pending" mean it.
 */
export async function drain(
  store: { sync(): Promise<void>; status(): SessionStatus },
  message = "this tab never drained its outbox",
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await store.sync();
    await delay(2);
    const status = store.status();
    if (!status.syncing && status.pending === 0) return;
  }
  throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DemoBrowser {
  /** One `localStorage` for the whole browser: the visitor's scope, and every device id. */
  readonly local = memoryStorage();
  readonly locks = new QueuedLocks();
  /** One port broker `SharedWorker`, which is what every tab of the origin connects to. */
  readonly hub = new BrokerHub();
  /** One relay `SharedWorker`, which is what stands in for a deployment. */
  readonly relay: WeftDemoRelay = serveDemoRelay();
  readonly workers: DemoStorageWorker[] = [];
  readonly #schema: SchemaDefinition;
  readonly #demo: string;
  readonly #sessions = new Map<string, StorageLike>();
  readonly #files = new Map<string, WasmDatabase>();
  readonly #ports: MessagePort[] = [];

  constructor(options: DemoBrowserOptions) {
    this.#schema = options.schema;
    this.#demo = options.demo;
  }

  /**
   * Opens one tab's database, the way each demo's own `open` does.
   *
   * The namespace is the tab's, which is the whole arrangement these demos rest on: two tabs of one
   * browser take two namespaces under one scope, so they are two databases holding one list —
   * separate elections, separate workers, separate device ids — and everything they show each other
   * has been through the relay.
   */
  async tab(name: string, options: TabOptions = {}): Promise<DemoTab> {
    const identity = tabIdentity(this.session(name), this.local, { demo: this.#demo });
    const database = await openDemoDatabase({
      schema: this.#schema,
      scopeId: identity.scopeId,
      namespace: `weftdb-demo/${this.#demo}/${identity.deviceId}`,
      // Never dereferenced: `overrides` is what turns these into a worker, a broker connection and
      // a relay port, because Node has neither constructor.
      worker: "./storage-worker.ts",
      broker: "./broker.ts",
      relayWorker: "./relay-worker.ts",
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      overrides: this.overrides(options),
    });
    return { identity, database };
  }

  /**
   * A tab's `sessionStorage`, which is what makes a tab a tab: reusing a name is that tab
   * reloading, and a new name is a new tab and therefore a new device.
   */
  session(name: string): StorageLike {
    const existing = this.#sessions.get(name);
    if (existing !== undefined) return existing;
    const created = memoryStorage();
    this.#sessions.set(name, created);
    return created;
  }

  /** What a demo's `open` is handed instead of the browser it cannot have. */
  overrides(options: TabOptions = {}): DemoOpenOverrides {
    return {
      locks: this.locks,
      deviceStorage: this.local,
      createBroker: () => this.hub.connect(),
      createWorker: (_url, namespace) => this.#worker(namespace),
      relayPort: options.relay === false ? null : this.#relayPort(),
      workerTimeoutMs: 10_000,
    };
  }

  /** A `WindowLike` for one tab: this browser's local storage, and that tab's session storage. */
  window(name: string): { readonly sessionStorage: StorageLike; readonly localStorage: StorageLike } {
    return { sessionStorage: this.session(name), localStorage: this.local };
  }

  close(): void {
    for (const worker of this.workers) worker.terminate();
    this.relay.stop();
    this.hub.close();
    for (const port of this.#ports) {
      try {
        port.close();
      } catch {
        // Transferred into a worker, which took it with it.
      }
    }
    this.#ports.length = 0;
  }

  /** This tab's end of a connection to the one relay, ready to be moved into its storage worker. */
  #relayPort(): RelayPortLike {
    const channel = new MessageChannel();
    this.#ports.push(channel.port2);
    this.relay.connect(channel.port2 as unknown as RelayPortLike);
    return channel.port1 as unknown as RelayPortLike;
  }

  #worker(namespace: string): WorkerLike {
    const channel = new MessageChannel();
    const far = new PortEndpoint<unknown>(channel.port2);
    const worker = new DemoStorageWorker(channel);
    this.workers.push(worker);
    // The shipped entry point, waiting for its relay port exactly as it does in a `Worker`.
    void serveDemoStorageWorker({
      schema: this.#schema,
      sqlite3InitModule: async () => this.#module(namespace),
      scope: far,
      port: far as unknown as WorkerHostPortLike,
      // Long, because every test here syncs when it means to. A device whose line has been cut is
      // blind, and a poll that retried every few milliseconds would publish a status twice a poll
      // for the whole of a test that is counting renders.
      pollWhileBlindMs: 5_000,
    });
    return worker;
  }

  /** A SQLite build whose pool hands out this namespace's one database, however often it is asked. */
  #module(namespace: string): Sqlite3Module {
    const file = this.#file(namespace);
    return {
      oo1: sqlite3.oo1,
      installOpfsSAHPoolVfs: async () => ({
        OpfsSAHPoolDb: class {
          prepare(sql: string): ReturnType<WasmDatabase["prepare"]> {
            return file.prepare(sql);
          }
          exec(sql: string): unknown {
            return file.exec(sql);
          }
          close(): void {
            file.close();
          }
        },
      }),
    };
  }

  /**
   * One namespace's database, which outlives every worker that opens it.
   *
   * `close` is deliberately a no-op. It is what the host calls to give the OPFS access handle back,
   * and what OPFS does then is release the file rather than forget it — so a tab that reloads finds
   * the rows it left, which is the property half of these tests turn on.
   */
  #file(namespace: string): WasmDatabase {
    const existing = this.#files.get(namespace);
    if (existing !== undefined) return existing;
    const database = new sqlite3.oo1.DB(":memory:", "c");
    const kept: WasmDatabase = {
      prepare: (sql) => database.prepare(sql),
      exec: (sql) => database.exec(sql),
      close: () => undefined,
    };
    this.#files.set(namespace, kept);
    return kept;
  }
}

/**
 * A dedicated worker, as far as the page is concerned. The transfer list is the whole reason it
 * takes one: the relay port and every brokered port reach the worker by being moved into it, and a
 * stand-in that dropped the second argument would deliver a detached port to a worker that then
 * waits for ever.
 */
export class DemoStorageWorker implements WorkerLike {
  terminated = false;
  readonly #channel: MessageChannel;
  readonly #page: PortEndpoint<WorkerMessage>;

  constructor(channel: MessageChannel) {
    this.#channel = channel;
    this.#page = new PortEndpoint<WorkerMessage>(channel.port1);
  }

  postMessage(message: never, transfer?: readonly unknown[]): void {
    this.#page.postMessage(message, transfer);
  }

  addEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.#page.addEventListener(type, listener);
  }

  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerMessage>) => void): void {
    this.#page.removeEventListener(type, listener);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.#channel.port1.close();
    this.#channel.port2.close();
  }
}
