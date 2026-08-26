// The page half of a demo's database: `openWeftDatabase`, plus the two things these demos need
// that no deployed application does.
//
// The first is that **each tab is a device**. A browser normally wants the opposite — one database
// per person, whichever tabs are open, which is what one `SharedWorker` per origin gives — and a
// demo about two devices merging has nothing to show under it. `namespace` is the seam: a database
// is a namespace and a scope together, so giving every tab a namespace of its own gives every tab
// its own client, its own storage and its own device id inside that one worker, while the scope
// stays the visitor's and the rows stay one list. What a second tab is here is what a second laptop
// is in a deployment.
//
// The second is where the relay is. There is no server behind a static docs page, so the relay is a
// `WeftServer` in a second `SharedWorker` of this browser (`relay-worker.ts`) and it is reached over
// a `MessagePort`. Only the page can construct a `SharedWorker`, and only the storage worker can run
// the sync session, so the page transfers that port into the storage worker over its own connection
// to it — which is what `connect` below is wrapped for.
import type { ScopeId } from "weftdb/core";
import type { SchemaDefinition } from "weftdb/schema";
import {
  openWeftDatabase,
  type SessionStatus,
  type StorageLike,
  type WeftDatabase,
  type WorkerLike,
} from "weftdb/client";
import { DEMO_ONLINE_MESSAGE, DEMO_RELAY_MESSAGE } from "./storage-worker.ts";
import type { RelayPortLike } from "./port-transport.ts";

/**
 * The credential the demo relay runs under.
 *
 * A deployed relay derives the scope and the device from the token, and that is what keeps one
 * person's rows away from another's. This relay has nobody to keep apart — every device it serves
 * is a tab of one browser, reading data that never leaves the machine — so it reads no token at
 * all. One is still handed over, because a device with no credential has no session: the worker
 * holds the rows and never syncs them.
 */
export const DEMO_TOKEN = "demo";

export interface DemoOpenOverrides {
  /** Stands in for the browser's `SharedWorker`, so a test can drive the whole assembly under Node. */
  readonly connect?: (url: URL | string) => WorkerLike;
  readonly deviceStorage?: StorageLike;
  /** The relay, as a port. Omitted means "construct the `SharedWorker`"; `null` means no relay. */
  readonly relayPort?: RelayPortLike | null;
}

export interface DemoDatabaseOptions {
  readonly schema: SchemaDefinition;
  /** The visitor's scope. Every tab of this browser opens the same one. */
  readonly scopeId: ScopeId;
  /** Names this tab's database within the origin. One per tab, which is what makes it a device. */
  readonly namespace: string;
  readonly worker: URL | string;
  /** The relay `SharedWorker`'s module. */
  readonly relayWorker: URL | string;
  readonly onError?: (error: Error) => void;
  readonly overrides?: DemoOpenOverrides;
}

/** A demo's database, with the switch the pages hang their online toggle on. */
export interface DemoDatabase {
  readonly weft: WeftDatabase;
  /** Whether this device has a session at all. False where the browser has no `SharedWorker`. */
  readonly syncing: boolean;
  readonly online: boolean;
  /** Cuts or restores the line between this device's session and the relay. */
  setOnline(online: boolean): void;
  dispose(): Promise<void>;
}

/** Opens this tab's database and gives the storage worker a line to the relay. */
export async function openDemoDatabase(options: DemoDatabaseOptions): Promise<DemoDatabase> {
  const overrides = options.overrides ?? {};
  const relayPort =
    overrides.relayPort === undefined ? connectRelay(options.relayWorker) : (overrides.relayPort ?? undefined);
  // Kept so the online switch has something to post to. Replaced whenever this tab reconnects,
  // because a worker the browser stopped took the previous one with it.
  let port: WorkerLike | undefined;
  let online = true;

  const connect = (url: URL | string): WorkerLike => {
    const opened = (overrides.connect ?? defaultConnect)(url);
    // Before anything else is said on it: the storage worker reads this off the port and every
    // session it builds afterwards runs over the line it names. A port can only be transferred
    // once, so a second connection says so by sending `undefined` and the worker keeps the line it
    // already has.
    const handing = port === undefined ? relayPort : undefined;
    post(opened, { weft: DEMO_RELAY_MESSAGE, port: handing }, handing === undefined ? [] : [handing]);
    post(opened, { weft: DEMO_ONLINE_MESSAGE, online });
    port = opened;
    return opened;
  };

  const weft = await openWeftDatabase({
    schema: options.schema,
    scopeId: options.scopeId,
    namespace: options.namespace,
    worker: options.worker,
    connect,
    ...(overrides.deviceStorage === undefined ? {} : { deviceStorage: overrides.deviceStorage }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    // A worker that was given no relay port was given no session either, and asking it to
    // authenticate is refused rather than ignored.
    ...(relayPort === undefined ? {} : { relay: { token: () => DEMO_TOKEN } }),
  });

  return {
    weft,
    syncing: relayPort !== undefined,
    get online() {
      return online;
    },
    setOnline: (next) => {
      online = next;
      if (port !== undefined) post(port, { weft: DEMO_ONLINE_MESSAGE, online: next });
      // Coming back is a sync now rather than at the next poll, which is what the toggle is for:
      // the unsent count drains while you are looking at it. A relay that cannot be reached is an
      // ordinary state and settles into the status; what is caught here is the tab going away with
      // this sync still crossing the port, which has nobody left to tell.
      if (next && relayPort !== undefined) void weft.source.sync().catch(() => undefined);
    },
    dispose: () => weft.dispose(),
  };
}

/**
 * What a device with no session reports.
 *
 * One object rather than one per read, because `useSyncExternalStore` compares snapshots by
 * identity and a status rebuilt on every render is a render loop. `online` is true because nothing
 * has failed: this is a device that has not been given a relay, which is where every open starts.
 */
const IDLE: SessionStatus = {
  online: true,
  syncing: false,
  pending: 0,
  quarantined: 0,
  quarantineReasons: [],
  cursor: 0,
  lastError: undefined,
  lastSyncedAt: undefined,
  live: false,
};

/**
 * What each demo's page reads its status pills off, and clicks its online toggle through.
 *
 * The one thing it does that reading `weft.status()` does not is fold in the switch. Being
 * offline by choice is a fact the page knows and the worker's session does not: the session sees
 * a relay it cannot reach, which is what `lastError` is for and is honest, but a person who has
 * just clicked "offline" is not looking at a fault. So the reported status is handed through
 * unchanged while the line is up, and while it is cut the three fields that describe a connection
 * are turned off and the error is dropped. Everything else — `pending` climbing, `quarantined`,
 * `cursor` — is the session's own and passes through either way, which is the whole point of
 * cutting the line in the worker rather than signing out.
 *
 * The result is memoised against the two things it is derived from, for the reason `IDLE` is one
 * object.
 */
export class DemoSync {
  readonly #database: DemoDatabase;
  readonly #listeners = new Set<() => void>();
  #reported: SessionStatus | undefined;
  #online: boolean;
  #view: SessionStatus = IDLE;

  constructor(database: DemoDatabase) {
    this.#database = database;
    this.#online = database.online;
    database.weft.subscribeStatus(() => this.#notify());
  }

  status(): SessionStatus {
    const reported = this.#database.weft.status() ?? IDLE;
    if (reported === this.#reported && this.#online === this.#database.online) return this.#view;
    this.#reported = reported;
    this.#online = this.#database.online;
    this.#view = this.#online
      ? reported
      : { ...reported, online: false, syncing: false, live: false, lastError: undefined };
    return this.#view;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get online(): boolean {
    return this.#database.online;
  }

  setOnline(online: boolean): void {
    this.#database.setOnline(online);
    this.#notify();
  }

  /** Syncs now rather than at the next poll. A device with no relay has nothing to ask. */
  async sync(): Promise<void> {
    if (!this.#database.syncing) return;
    await this.#database.weft.source.sync();
  }

  async discardQuarantine(): Promise<void> {
    await this.#database.weft.source.discardQuarantine();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * This browser's one relay, or nothing where it has no `SharedWorker`.
 *
 * A `SharedWorker` is identified by its script URL, which is the whole reason the relay can be one
 * server for every tab rather than one per tab. A browser without one is not refused here: the demo
 * opens, the database works, and only the syncing is gone — which `openWeftDatabase` would refuse
 * anyway a moment later, for the storage worker rather than for this.
 */
function connectRelay(url: URL | string): RelayPortLike | undefined {
  const constructor = (
    globalThis as {
      SharedWorker?: new (url: URL | string, options?: { type: "module" }) => { readonly port: RelayPortLike };
    }
  ).SharedWorker;
  if (constructor === undefined) return undefined;
  return new constructor(url, { type: "module" }).port;
}

function defaultConnect(url: URL | string): WorkerLike {
  const constructor = (
    globalThis as {
      SharedWorker: new (url: URL | string, options?: { type: "module" }) => { readonly port: WorkerLike };
    }
  ).SharedWorker;
  return new constructor(url, { type: "module" }).port;
}

/**
 * Posts a message that is not part of the worker protocol, through the port's own widest shape.
 * `WorkerLike.postMessage` is typed to the protocol's union so that a mistyped request is a
 * compile error; these two messages are addressed to `serveDemoStorageWorker` instead, and
 * everything else listening on that port drops them by their tag.
 */
function post(port: WorkerLike, message: unknown, transfer: readonly unknown[] = []): void {
  (port as unknown as { postMessage(message: unknown, transfer?: readonly unknown[]): void }).postMessage(
    message,
    transfer,
  );
}
