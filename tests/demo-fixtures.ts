// One browser, for the demos to be opened in.
//
// Everything the demos ship is real here and only the browser is stood in for. The shipped
// `serveDemoStorageWorker` runs once per browser — one `SharedWorker` serves an origin — and each
// tab reaches it over a `MessageChannel`, syncing through the shipped `serveDemoRelay` over a port
// that is genuinely transferred into that worker. The device ids, the routing and the storage are
// the library's own, driven through `openWeftDatabase` exactly as a page drives them.
//
// What a namespace is here is what it is in a browser: the identity of one database. Each tab of a
// demo takes one of its own, which is what makes a second tab a second device, so the file each
// client is read out of is keyed on it. A database whose last tab has gone is dropped and reopened
// with what it committed still in it, which is what makes a reload a reload.
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { SessionStatus, StorageLike, WorkerLike } from "weftdb/client";
import type { SchemaDefinition } from "weftdb/schema";
import { tabIdentity, type TabIdentity } from "weftdb-demo-shared/identity";
import { openDemoDatabase, type DemoDatabase, type DemoOpenOverrides } from "weftdb-demo-shared/open";
import type { RelayPortLike } from "weftdb-demo-shared/port-transport";
import { serveDemoRelay, type WeftDemoRelay } from "weftdb-demo-shared/relay-worker";
import { serveDemoStorageWorker, type DemoStorageWorker } from "weftdb-demo-shared/storage-worker";
import { memorySqlite } from "./storage-fixtures.ts";
import { PortEndpoint } from "./multitab-fixtures.ts";

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
  /** The demo's schema, which is what its storage worker opens databases for. */
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
  /** Where a failure with no caller to reject is reported. */
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
  /** One relay `SharedWorker`, which is what stands in for a deployment. */
  readonly relay: WeftDemoRelay = serveDemoRelay();
  /** One storage `SharedWorker`, holding a client per `(namespace, scope)` any tab has asked for. */
  storage: DemoStorageWorker;
  readonly #schema: SchemaDefinition;
  readonly #demo: string;
  readonly #sessions = new Map<string, StorageLike>();
  /** The files, kept across a restart of the worker that serves them, as a browser's storage is. */
  readonly #sqlite = memorySqlite();
  readonly #ports: MessagePort[] = [];
  /** The worker's own end of each tab connection, which a restart takes with it. */
  readonly #served: MessagePort[] = [];

  constructor(options: DemoBrowserOptions) {
    this.#schema = options.schema;
    this.#demo = options.demo;
    this.storage = this.#serveStorage();
  }

  /**
   * The browser stopping this origin's storage worker and starting it again over the same files.
   *
   * Stopping the worker is not what a page hears; a closed port is. So the worker's end of every
   * tab connection is closed here, which is the notice `openWeftDatabase` reconnects on, and the
   * connection it makes is served by the new worker — one that has none of the relay ports the
   * tabs handed to the old one.
   */
  async restartStorage(): Promise<void> {
    await this.storage.stop();
    for (const port of this.#served) port.close();
    this.#served.length = 0;
    this.storage = this.#serveStorage();
  }

  /**
   * Opens one tab's database, the way each demo's own `open` does.
   *
   * The namespace is the tab's, which is the whole arrangement these demos rest on: two tabs of one
   * browser take two namespaces under one scope, so they are two databases holding one list —
   * separate clients, separate files, separate device ids — and everything they show each other has
   * been through the relay.
   */
  async tab(name: string, options: TabOptions = {}): Promise<DemoTab> {
    const identity = await tabIdentity(this.session(name), this.local, { demo: this.#demo });
    const database = await openDemoDatabase({
      schema: this.#schema,
      scopeId: identity.scopeId,
      namespace: `weftdb-demo/${this.#demo}/${identity.deviceId}`,
      // Never dereferenced: `overrides` is what turns these into a connection and a relay port,
      // because Node has no `SharedWorker` constructor.
      worker: "./storage-worker.ts",
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
      deviceStorage: this.local,
      connect: () => this.#connect(),
      relayPort: options.relay === false ? null : () => this.#relayPort(),
    };
  }

  /** A `WindowLike` for one tab: this browser's local storage, and that tab's session storage. */
  window(name: string): { readonly sessionStorage: StorageLike; readonly localStorage: StorageLike } {
    return { sessionStorage: this.session(name), localStorage: this.local };
  }

  async close(): Promise<void> {
    await this.storage.stop();
    this.relay.stop();
    for (const port of this.#ports) {
      try {
        port.close();
      } catch {
        // Transferred into a worker, which took it with it.
      }
    }
    this.#ports.length = 0;
  }

  /** This tab's end of a connection to the one relay, ready to be moved into the storage worker. */
  #relayPort(): RelayPortLike {
    const channel = new MessageChannel();
    this.#ports.push(channel.port2);
    this.relay.connect(channel.port2 as unknown as RelayPortLike);
    return channel.port1 as unknown as RelayPortLike;
  }

  /** This tab's end of a connection to the one storage worker, as `onconnect` would deliver it. */
  #connect(): WorkerLike {
    const channel = new MessageChannel();
    this.#ports.push(channel.port1, channel.port2);
    this.#served.push(channel.port2);
    this.storage.connect(new PortEndpoint(channel.port2));
    return new PortEndpoint(channel.port1) as unknown as WorkerLike;
  }

  #serveStorage(): DemoStorageWorker {
    return serveDemoStorageWorker({
      schema: this.#schema,
      sqlite: this.#sqlite,
      // Long, because every test here syncs when it means to. A device whose line has been cut is
      // blind, and a poll that retried every few milliseconds would publish a status twice a poll
      // for the whole of a test that is counting renders.
      pollWhileBlindMs: 5_000,
    });
  }
}
