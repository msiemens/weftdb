// The page's front door. Everything between "this application has a schema and a scope" and
// "components can read rows", paid once here rather than once per application.
//
// What it collapses is not one long function but five composition mistakes that the library could
// only warn about in prose, because none of them is a type error and none of them raises anything:
//
//   - the BroadcastChannel a follower's proxy talks on and the one the leader's responder answers
//     on have to be the same name, and nothing checked;
//   - the leader has to feed its worker's pushes to `relayPush`, or every follower's rows freeze
//     after the first load — silently, with no error and no type error;
//   - each mirror needs an engine of its own, or two of them evict each other's cached rows on
//     every render and `useSyncExternalStore` spins;
//   - a follower's request has no deadline, so a tab that elects itself before any leader is
//     serving waits for an answer that was posted to nobody;
//   - and the teardown has an order: the Web Lock must be handed back after the worker has let go
//     of the OPFS access handle, or the successor tab opens a file the predecessor still holds.
//
// There is one storage topology and it is OPFS. A device that cannot get a synchronous access
// handle pool — Safari's private browsing mode is the case that matters — fails the open loudly
// rather than being handed a smaller database, for the same reason `openWebSqliteExecutor` refuses
// to open against memory: a database that answers every read and write and then loses all of it on
// reload is worse than one that says it cannot open. One front door that handed back two sources
// differing in what they can answer would be the ambiguity this module exists to remove.
import { deviceId as toDeviceId, type DeviceId } from "weftdb/core";
import { schemaHash, type SchemaDefinition } from "weftdb/schema";
import {
  BroadcastDbProxy,
  MultiTabCoordinator,
  serveBroadcastDbProxy,
  type BroadcastDbProxyServer,
  type LockManagerLike,
  type TabRole,
} from "./multitab.ts";
import { SubscriptionEngine } from "./subscriptions.ts";
import type { SessionStatus } from "./session.ts";
import type { StorageLike } from "./web-storage.ts";
import {
  isWeftWorkerReady,
  OpfsWorkerTransport,
  type MirrorTransport,
  type WorkerLike,
  type WorkerMessage,
} from "./worker.ts";
import { WeftClientMirror } from "./worker-mirror.ts";

/**
 * The worker as this module drives it: the port protocol, plus a way to stop it. `Worker` satisfies
 * it; so does a `MessagePort` shim with a `serveWeftWorker` on the far end, which is how this is
 * tested under Node.
 *
 * `terminate` is optional because it is the one thing not every stand-in has, and because a page
 * that is going away has the browser to do it.
 */
export interface WeftWorkerLike extends WorkerLike {
  terminate?(): void;
}

/** Where this device's credential comes from. Read again per credential — see `setToken`. */
export interface OpenRelayOptions {
  /**
   * The token the worker's sync session runs under, or `null` for a device that has not signed in.
   *
   * A function, not a value, because a transport carries its token: HTTP sends one per request and
   * a socket presents one when it connects, so signing in as somebody else is a new transport
   * rather than a mutated one. Re-reading it is how a refreshed token reaches the session, which is
   * what `setToken()` with no argument does.
   *
   * Where the relay is does not appear here. That belongs in the worker's own
   * `serveWeftWorkerDefaults({ relay })`, because the worker is where the transport is built — and
   * a base URL declared in two places that have to agree is exactly the class of mistake this
   * module exists to remove.
   */
  readonly token: () => string | null;
}

export interface OpenWeftDatabaseOptions {
  /**
   * This application's schema. It is not used to open anything — the worker holds the database and
   * imports the schema itself — but its hash is compared against the one the worker reports, so a
   * page bundle and a worker bundle built from different schemas are refused instead of quietly
   * selecting columns the other one has never heard of.
   */
  readonly schema: SchemaDefinition;
  readonly scopeId: string;
  /** The worker module, as `new URL("./storage-worker.ts", import.meta.url)`. */
  readonly worker: URL | string;
  readonly relay?: OpenRelayOptions;
  /** Where a mutation the worker refused is reported. Mutators return `void` and cannot report it. */
  readonly onError?: (error: Error) => void;
  /**
   * Where this device's id is kept. `localStorage` by default, so it survives the tab; taking it as
   * an option is what makes the identity testable and lets an application supply storage of its own.
   */
  readonly deviceStorage?: StorageLike;
  /** Prefixes every key this writes, so two applications in one origin do not collide. */
  readonly namespace?: string;
  /** Web Locks, which decide which tab holds the worker. `navigator.locks` by default. */
  readonly locks?: LockManagerLike;
  /**
   * How the `Worker` is made. The default is the one line of this module that cannot run outside a
   * browser, which is exactly why it is an option: under Node the whole assembly below — the
   * election, the channel naming, the relay wiring, the teardown order — is real, and only this is
   * replaced by a `MessageChannel` with a `serveWeftWorker` on the far end.
   */
  readonly createWorker?: (url: URL | string) => WeftWorkerLike;
  /** How long the leader's worker has to report that it opened a database. */
  readonly workerTimeoutMs?: number;
  /**
   * How long a follower waits to find a leader answering on the channel. A `BroadcastChannel`
   * queues nothing, so a tab that loses the election while the winner is still starting its worker
   * posts into silence; this bounds the wait rather than leaving the open pending forever.
   */
  readonly leaderTimeoutMs?: number;
  /** How long `dispose` waits for the worker to give the OPFS access handle back before stopping it. */
  readonly closeTimeoutMs?: number;
}

/** What an application is left holding. Everything else is the library's. */
export interface WeftDatabase {
  /**
   * What the generated hooks and mutators read and write through. It satisfies the `WeftSource`
   * shape the hooks take, so `use<Collection>` and `use<Collection>Query` work over it unchanged,
   * and `MutationTarget`, so `<collection>Mutators` writes through it.
   */
  readonly source: WeftClientMirror;
  /** Which part this tab is playing. Drive a banner off this, never off a request in flight. */
  readonly role: TabRole;
  /** What the worker's sync session last reported, or nothing before this device has signed in. */
  status(): SessionStatus | undefined;
  subscribeStatus(listener: () => void): () => void;
  /**
   * Hands the worker a credential. With no argument the `relay.token` function is read again, which
   * is how a refreshed token reaches the session; `null` signs out and leaves unsent work queued.
   */
  setToken(token?: string | null): void;
  /**
   * Unwinds everything this opened, in an order that leaves nothing running. Safe to call more than
   * once, and safe to call without awaiting — a `pagehide` handler should not block on it.
   */
  dispose(): Promise<void>;
}

export type WeftOpenFailure =
  /** The worker could not get an OPFS synchronous access handle pool. */
  | "storage-unavailable"
  /** The page and the worker were built from different schemas. */
  | "schema-mismatch"
  /** The worker never said whether it had opened a database. */
  | "worker-timeout"
  /** This tab is a follower and no leader answered on the channel. */
  | "no-leader"
  /** This environment has no `Worker`, and none was supplied. */
  | "no-worker"
  /** This environment has no `localStorage` to keep a device id in, and none was supplied. */
  | "no-device-storage";

export class WeftOpenError extends Error {
  readonly reason: WeftOpenFailure;

  constructor(reason: WeftOpenFailure, detail: string) {
    super(detail);
    this.name = "WeftOpenError";
    this.reason = reason;
  }
}

const DEFAULT_NAMESPACE = "weft";
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const DEFAULT_LEADER_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How often a follower re-asks for a leader. A lost post is only noticed by asking again. */
const LEADER_PROBE_MS = 100;

/**
 * The device this browser is, for this scope.
 *
 * Namespaced by scope, so being signed into two scopes from one browser is two devices: the relay
 * counts devices per scope, and one id shared between them would have each scope's cursor advanced
 * by the other's pulls. Minted once and kept, because a device that renamed itself on every reload
 * would leave the relay a new device per visit and this device's own past writes stamped by
 * somebody else.
 */
export function deviceIdForScope(
  scopeId: string,
  options: { readonly storage?: StorageLike; readonly namespace?: string } = {},
): DeviceId {
  const storage = options.storage ?? defaultDeviceStorage();
  const key = `${options.namespace ?? DEFAULT_NAMESPACE}/device/${scopeId}`;
  const existing = storage.getItem(key);
  if (existing !== null && existing !== "") return toDeviceId(existing);
  const minted = crypto.randomUUID();
  storage.setItem(key, minted);
  return toDeviceId(minted);
}

/**
 * Opens this device's database and returns what an application reads and writes through.
 *
 * One call per scope per tab. The first tab to take the Web Lock holds the worker and answers the
 * others over a channel named after the scope; every other tab reaches that worker through it. Which
 * of the two this tab turned out to be is `role`, and nothing above this line has to care.
 */
export async function openWeftDatabase(options: OpenWeftDatabaseOptions): Promise<WeftDatabase> {
  const { scopeId } = options;
  const deviceId = deviceIdForScope(scopeId, {
    ...(options.deviceStorage === undefined ? {} : { storage: options.deviceStorage }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
  });
  // Derived, never named by the caller. The proxy and the responder cannot disagree about a name
  // neither of them was given.
  const channel = new BroadcastChannel(databaseChannelName(scopeId, options.namespace));
  const locks = resolveLocks(options);
  const coordinator = new MultiTabCoordinator({ scopeId, ...(locks === undefined ? {} : { locks }) });

  let role: TabRole;
  try {
    role = await coordinator.elect();
  } catch (error) {
    coordinator.close();
    channel.close();
    throw error;
  }

  try {
    // A tab in a browser without Web Locks is `degraded`, and opens the worker: it is the only tab
    // as far as anything here can tell. If it is not — two degraded tabs in one browser — the second
    // one's worker fails to take the access handle and says so, which is the loud failure this
    // module prefers to a quiet second database.
    return role === "follower"
      ? await openFollower({ options, coordinator, channel, deviceId })
      : await openLeader({ options, coordinator, channel, deviceId });
  } catch (error) {
    // A failed open leaves nothing running. The two paths clean up whatever they had got as far as
    // building; what is left here is what every path had before either of them started.
    coordinator.close();
    channel.close();
    throw error;
  }
}

/** The channel every tab of one scope speaks on. Derived from the scope, so it cannot be mistyped. */
export function databaseChannelName(scopeId: string, namespace = DEFAULT_NAMESPACE): string {
  return `${namespace}:${scopeId}:db`;
}

interface OpenContext {
  readonly options: OpenWeftDatabaseOptions;
  readonly coordinator: MultiTabCoordinator;
  readonly channel: BroadcastChannel;
  readonly deviceId: DeviceId;
}

async function openLeader(context: OpenContext): Promise<WeftDatabase> {
  const { options, coordinator, channel } = context;
  const worker = (options.createWorker ?? defaultCreateWorker)(options.worker);

  // Before the transport, because the worker announces itself unasked and a transport that was
  // listening would have to be told to ignore it. What comes back also settles whether there is a
  // database at all.
  let ready: { readonly ok: true; readonly schemaHash: string };
  try {
    ready = await awaitWorkerReady(worker, options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
  } catch (error) {
    worker.terminate?.();
    throw error;
  }
  const expected = schemaHash(options.schema);
  if (ready.schemaHash !== expected) {
    worker.terminate?.();
    throw new WeftOpenError(
      "schema-mismatch",
      `this page was built from schema ${expected} and its storage worker from ${ready.schemaHash}. ` +
        "They have to be the same schema: the worker's tables are generated from its own copy, so a " +
        "page reading this one would select columns that database has never had.",
    );
  }

  const transport = new OpfsWorkerTransport(worker);
  const server: BroadcastDbProxyServer = serveBroadcastDbProxy({
    channel,
    target: transport,
    // Asked per request, so a tab that has lost the lock stops answering before its successor starts.
    isLeader: () => coordinator.role === "leader" || coordinator.role === "degraded",
  });
  // The one line whose absence is invisible. Without it a follower hydrates once and never moves
  // again: no error, no type error, just rows that stopped.
  const offRelay = transport.onPush((push) => {
    server.relayPush(push);
  });

  const mirror = newMirror(context, transport);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    // Order, and each step is load-bearing. Stop applying pushes; stop relaying them; stop
    // answering followers; ask the worker to close the database, which is what makes it let go of
    // the OPFS access handle; only then settle what was in flight and stop the worker.
    mirror.dispose();
    offRelay();
    server.stop();
    // Bounded, because the rest of the teardown is not optional. A worker that has stopped
    // answering must not also stop the Web Lock being handed back — that would leave every other
    // tab of this scope waiting on a leader that has gone.
    await Promise.race([
      transport.request({ type: "close" }).catch(() => undefined),
      delay(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS),
    ]);
    transport.dispose();
    worker.terminate?.();
    // Last of all. The Web Lock is what the next tab waits on, and handing it back before the
    // access handle is released would have the successor open a file this worker still holds.
    coordinator.close();
    channel.close();
  };

  try {
    await mirror.hydrate();
  } catch (error) {
    await dispose();
    throw error;
  }
  return open(context, mirror, dispose);
}

async function openFollower(context: OpenContext): Promise<WeftDatabase> {
  const { options, coordinator, channel } = context;
  const proxy = new BroadcastDbProxy(channel);
  const mirror = newMirror(context, proxy);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    mirror.dispose();
    // Hands this tab's watches back to the leader's worker and settles what was in flight, so a
    // caller awaiting a query is told rather than left waiting on a tab that has gone.
    proxy.dispose();
    coordinator.close();
    // A turn between the last post and the close. Handing the watches back is the only thing that
    // tells the leader's worker this tab is gone — a BroadcastChannel has no liveness signal — and
    // closing the channel in the same turn they were posted risks taking them with it.
    await delay(0);
    channel.close();
  };

  try {
    // A channel queues nothing. A tab that lost the election while the winner was still starting its
    // worker would post a hydrate into silence and wait on an answer nobody is going to give, so the
    // wait is for a leader rather than for one request, and it is bounded.
    await awaitLeader(proxy, options.scopeId, options.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS);
    await mirror.hydrate();
  } catch (error) {
    await dispose();
    throw error;
  }
  return open(context, mirror, dispose);
}

/**
 * One mirror, one engine. Sharing an engine between two mirrors has them evicting each other's
 * cached snapshots on every render, which `useSyncExternalStore` turns into an update loop rather
 * than a slow render — so the engine is built here and never handed out.
 */
function newMirror(context: OpenContext, transport: MirrorTransport): WeftClientMirror {
  return new WeftClientMirror({
    transport,
    scopeId: context.options.scopeId,
    deviceId: context.deviceId,
    engine: new SubscriptionEngine(),
    ...(context.options.onError === undefined ? {} : { onError: context.options.onError }),
  });
}

/**
 * The handle, and the first credential with it.
 *
 * The token is handed over here rather than by the caller because a mirror with no token has a
 * client and no session: the worker holds the rows and never syncs them, which is a device that
 * works perfectly offline and never comes back. A device with no `relay` is told nothing, because
 * asking a worker that was given no session options to authenticate is refused rather than ignored.
 */
function open(context: OpenContext, mirror: WeftClientMirror, dispose: () => Promise<void>): WeftDatabase {
  const token = context.options.relay?.token;
  if (token !== undefined) mirror.setToken(token());
  return {
    source: mirror,
    role: context.coordinator.role,
    status: () => mirror.status(),
    subscribeStatus: (listener) => mirror.subscribeStatus(listener),
    setToken: (next) => {
      // No argument re-reads the option: a token that has been refreshed since the open is a new
      // credential, and the session is rebuilt around it rather than having one patched in place.
      mirror.setToken(next === undefined ? (token?.() ?? null) : next);
    },
    dispose,
  };
}

/**
 * Waits for the worker's one unasked announcement.
 *
 * A worker that cannot open a database reports it here rather than throwing where nobody is
 * listening, and a worker that never reports at all — a module that failed to load, a build without
 * the entry point — is a timeout rather than an open that hangs for the life of the page.
 */
async function awaitWorkerReady(
  worker: WeftWorkerLike,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly schemaHash: string }> {
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      worker.removeEventListener("message", listener);
    };
    const listener = (event: MessageEvent<WorkerMessage>): void => {
      const message: unknown = event.data;
      if (!isWeftWorkerReady(message)) return;
      settle();
      if (message.ok) resolve({ ok: true, schemaHash: message.schemaHash });
      else {
        reject(
          new WeftOpenError(
            "storage-unavailable",
            `this device has no storage weftdb can use: ${message.error}. It needs an OPFS synchronous ` +
              "access handle pool, which a browser offers only inside a dedicated worker and which " +
              "Safari does not offer at all in private browsing.",
          ),
        );
      }
    };
    const timer = setTimeout(() => {
      settle();
      reject(
        new WeftOpenError(
          "worker-timeout",
          `the storage worker did not report within ${timeoutMs}ms. It has to call ` +
            "serveWeftWorkerDefaults (or post a ready message of its own) for the page to know whether " +
            "a database was opened.",
        ),
      );
    }, timeoutMs);
    // Node keeps its loop alive for a pending timer; a browser has no `unref` and does not care.
    (timer as { unref?: () => void }).unref?.();
    worker.addEventListener("message", listener);
  });
}

/**
 * Asks, repeatedly, until a leader answers.
 *
 * `open` is the request to ask with because it is the one the host answers without doing anything:
 * the database was opened before the host was built, so it is an acknowledgement that somebody is
 * serving rather than an instruction. Each attempt is a fresh request — a post that landed while no
 * responder was attached was not delayed, it was dropped, and only asking again finds that out.
 */
async function awaitLeader(proxy: BroadcastDbProxy, scopeId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answered = await Promise.race([
      // The rejection is caught rather than raced: a leader that is answering but refusing is still
      // a leader, and this is only asking whether one is there.
      proxy.request({ type: "open", scopeId }).then(
        () => true,
        () => true,
      ),
      delay(LEADER_PROBE_MS).then(() => false),
    ]);
    if (answered) return;
    if (Date.now() >= deadline) {
      throw new WeftOpenError(
        "no-leader",
        `no tab answered for scope ${scopeId} within ${timeoutMs}ms. This tab is a follower — another ` +
          "tab holds the OPFS access handle — and a BroadcastChannel queues nothing, so there is " +
          "nobody serving rather than somebody being slow.",
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function resolveLocks(options: OpenWeftDatabaseOptions): LockManagerLike | undefined {
  if (options.locks !== undefined) return options.locks;
  return (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
}

function defaultDeviceStorage(): StorageLike {
  const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  if (storage === undefined) {
    throw new WeftOpenError(
      "no-device-storage",
      "this environment has no localStorage to keep a device id in; pass `deviceStorage`.",
    );
  }
  return storage;
}

function defaultCreateWorker(url: URL | string): WeftWorkerLike {
  const constructor = (globalThis as { Worker?: new (url: URL | string, options?: { type: "module" }) => unknown })
    .Worker;
  if (constructor === undefined) {
    throw new WeftOpenError(
      "no-worker",
      "this environment has no Worker constructor. weftdb keeps its database in a dedicated worker " +
        "because an OPFS synchronous access handle exists nowhere else; pass `createWorker` to supply one.",
    );
  }
  return new constructor(url, { type: "module" }) as WeftWorkerLike;
}
