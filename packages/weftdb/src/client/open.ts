// The page's front door. Everything between "this application has a schema and a scope" and
// "components can read rows", paid once here rather than once per application.
//
// What it collapses is not one long function but a set of composition mistakes that the library
// could only warn about in prose, because none of them is a type error and none of them raises
// anything:
//
//   - a tab that is not the leader has to be given a port to the one worker, which takes a broker,
//     which takes a `SharedWorker` at a URL every tab agrees on;
//   - the tab that holds the worker has to forward each arriving port into it, or a second tab
//     connects to nothing and waits;
//   - each mirror needs an engine of its own, or two of them evict each other's cached rows on
//     every render and `useSyncExternalStore` spins;
//   - a tab whose port dies has to reconnect and re-register everything it was watching, or its
//     lists freeze silently at whatever they last held;
//   - and the teardown has an order: the Web Lock must be handed back after the worker has let go
//     of the OPFS access handle, or the successor tab opens a file the predecessor still holds.
//
// The data path is one hop for every tab. Only one document may hold the OPFS synchronous access
// handle, so only one tab creates the worker — but a `MessagePort` to that worker can be handed to
// any number of tabs, and once it has been, the tab that created it is not on the others' path at
// all. `./broker.ts` is how a port gets across; this is what does it and what happens when the tab
// holding the worker goes away.
//
// There is one storage topology and it is OPFS. Where a browser will not hand out a synchronous
// access handle pool — private browsing is the case that matters — the worker opens the same SQLite
// in memory instead and this reports `durability: "ephemeral"`. That is not a smaller database: the
// whole SQL read path answers identically, and what differs is only how long it lasts. What the
// front door will not do is leave the difference unsaid, which is why the value is a field beside
// `role` rather than something an application has to infer.
import { deviceId as toDeviceId, type DeviceId } from "weftdb/core";
import { schemaHash, type SchemaDefinition } from "weftdb/schema";
import { DEFAULT_NAMESPACE, WEFT_NAMESPACE_PARAM } from "./database-key.ts";
import { MultiTabCoordinator, type LockManagerLike, type TabRole } from "./multitab.ts";
import { WeftBrokerClient, type BrokeredPort, type BrokerPortLike } from "./broker.ts";
import { SubscriptionEngine } from "./subscriptions.ts";
import type { SessionStatus } from "./session.ts";
import type { StorageLike } from "./web-storage.ts";
import {
  isWeftWorkerReady,
  isWorkerHydrated,
  WorkerPortTransport,
  type WeftDurability,
  type WorkerLike,
  type WorkerMessage,
} from "./worker.ts";
import { WeftClientMirror } from "./worker-mirror.ts";

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
  /**
   * The broker module, as `new URL("./broker.ts", import.meta.url)`, whose whole content is
   * `import "weftdb/client/broker-entry"`.
   *
   * It is a `SharedWorker`, and a `SharedWorker` is identified by its script URL — so every tab of
   * the origin has to name the same one, which is why this is a URL the application owns rather
   * than something derived here. What runs there touches no storage: it relays a `MessagePort` from
   * a tab that wants the database to the tab that has it, because a `BroadcastChannel` cannot carry
   * a transferable and nothing else in a browser can.
   */
  readonly broker: URL | string;
  readonly relay?: OpenRelayOptions;
  /** Where a mutation the worker refused is reported. Mutators return `void` and cannot report it. */
  readonly onError?: (error: Error) => void;
  /**
   * Where this device's id is kept. `localStorage` by default, so it survives the tab; taking it as
   * an option is what makes the identity testable and lets an application supply storage of its own.
   */
  readonly deviceStorage?: StorageLike;
  /**
   * Which application in this origin this database belongs to. `"weft"` by default.
   *
   * It is half of the database's identity, and the scope is the other half. Two calls that agree on
   * both are two tabs of one database: one election, one worker, one device id. Two calls that
   * differ in either are two databases that share nothing — separate locks, separate workers,
   * separate device ids, separate OPFS pools — even where the `scopeId` is the same string.
   *
   * It also prefixes every key the device id is kept under, which is where it started.
   */
  readonly namespace?: string;
  /** Web Locks, which decide which tab holds the worker. `navigator.locks` by default. */
  readonly locks?: LockManagerLike;
  /**
   * How the `Worker` is made. The default is one of the two lines of this module that cannot run
   * outside a browser, which is exactly why it is an option: under Node the whole assembly below —
   * the election, the port handover, the migration, the teardown order — is real, and only this is
   * replaced by a `MessageChannel` with a `serveWeftWorker` on the far end.
   *
   * The namespace is handed over with the URL because the worker opens the database and only the
   * page knows which one to open. The default writes it into the URL's query string, where
   * `serveWeftWorkerDefaults` reads it back off its own `location`; a `createWorker` of an
   * application's own has to put it somewhere its worker will read, or two namespaces in one origin
   * will contend for a single OPFS pool and the second tab will be refused it.
   */
  readonly createWorker?: (url: URL | string, namespace: string) => WorkerLike;
  /**
   * How the connection to the broker is made. The default constructs a `SharedWorker` and hands
   * back its port; this is the seam for everything that is not a browser.
   *
   * It exists for the same reason `createWorker` does and takes the same shape. Node has no
   * `SharedWorker` at all, so a broker reachable only by constructing one would be a broker no test
   * could ever run — and the relay it runs is the piece of this design that is new, so it is the
   * piece that most needs running. A test connects `MessageChannel` ends to a `serveWeftPortBroker`
   * in the same process, which is the shipped relay with the process boundary taken out.
   */
  readonly createBroker?: (url: URL | string) => BrokerPortLike;
  /** How long the tab holding the worker has to report that it opened a database. */
  readonly workerTimeoutMs?: number;
  /**
   * How long a tab waits to reach the worker through the broker. The handover is not
   * acknowledged — the broker forwards the port into another document and hears nothing back — so
   * this bounds the wait rather than leaving the open pending forever.
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
  /**
   * Which part this tab is playing, read live rather than fixed at the open. A follower granted the
   * lock becomes the leader without the page being rebuilt, so a role captured once would go on
   * describing a tab that had stopped being it.
   *
   * Diagnostics rather than something to render. Every tab holds a port straight to the worker, so a
   * follower is one hop from the database exactly as the leader is, and there is nothing a person
   * reading "another tab holds the database" could do about it or would want to. `durability` is the
   * value worth a banner, because it says the window will not remember.
   */
  readonly role: TabRole;
  /**
   * Fires when `role` changes, so a renderer has something to re-read it on.
   *
   * Reading a live getter is only half of it: a promoted tab holds the lock from the moment the
   * browser grants it, and a page with nothing to subscribe to goes on showing the role it had at
   * the open until some unrelated state happens to re-render it. Pair the two the way
   * `status`/`subscribeStatus` are paired.
   *
   * Only a promotion moves the role. A tab hearing that somebody else is providing stays a follower,
   * and a tab being disposed of is not told, because a page on its way out has no banner to correct.
   */
  subscribeRole(listener: () => void): () => void;
  /**
   * Whether this device's database outlives the window, read from the worker that opened it.
   *
   * `"ephemeral"` means the browser would not give a synchronous access handle pool and the worker
   * opened an in-memory SQLite instead — private browsing, in practice. Everything works: the same
   * statements answer, writes queue in the outbox, and a device that signs in still syncs. What goes
   * when the window does is all of it, a reload included, which is what an application should be
   * telling the person rather than leaving them to find out.
   *
   * A getter rather than a value, for the same reason `role` is one: leadership moving reopens this
   * tab against a different worker, and the answer comes from whichever worker is serving it now.
   * Every tab of one scope reports the same thing — a follower learns it from its `hydrate`.
   *
   * It does not move during a session, so there is nothing to subscribe to. A device that was
   * durable stays durable: a successor that came up in memory because the predecessor had not let
   * the pool go yet is discarded and made again rather than accepted (see `#succeedToWorker`).
   */
  readonly durability: WeftDurability;
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
  /**
   * The worker's SQLite build has no OPFS synchronous access handle pool VFS in it at all, so there
   * is no durable storage to be had on any browser. A browser that merely declines the pool is not
   * this: it is served an in-memory database and reports `durability: "ephemeral"`.
   */
  | "storage-unavailable"
  /** The page and the worker were built from different schemas. */
  | "schema-mismatch"
  /** The worker never said whether it had opened a database. */
  | "worker-timeout"
  /** This tab could not reach the worker through the broker. */
  | "no-leader"
  /** This environment has no `Worker`, and none was supplied. */
  | "no-worker"
  /** This environment has no `SharedWorker`, so no tab can be given a port to the worker. */
  | "no-broker"
  /**
   * This environment has no Web Locks, so there is nothing that can decide which tab holds the
   * database. Reported in every tab, before a worker is created anywhere.
   */
  | "no-locks"
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

const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const DEFAULT_LEADER_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long one handover attempt is given before another port is asked for alongside it. */
const LEADER_PROBE_MS = 100;
/**
 * How many workers a successor builds before it gives up on the database this tab already had, and
 * the step between them: attempt `n` waits `n` steps, so six attempts span three quarters of a
 * second. Long enough for a browser to finish releasing a crashed document's access handles, short
 * enough that a tab taking over is not visibly stalled — and paid only by a tab that was durable and
 * whose successor worker was not. See `DatabaseTab.#succeedToWorker`.
 */
const POOL_HANDOVER_ATTEMPTS = 6;
const POOL_HANDOVER_STEP_MS = 50;
/** What a request in flight when the worker went away is rejected with. */
const MIGRATED = "the tab holding the storage worker went away; the write's outcome is unknown";

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
 * One call per scope per tab. The first tab to take the Web Lock creates the worker; every other
 * tab is handed a `MessagePort` to it through the broker and talks to it directly. Which of the two
 * this tab turned out to be is `role`, and nothing above this line has to care — including when it
 * changes.
 */
export async function openWeftDatabase(options: OpenWeftDatabaseOptions): Promise<WeftDatabase> {
  const { scopeId } = options;
  // Resolved once, here, and given to every part that decides which database this is: the device
  // id's storage key, the lock the election runs on, the key the broker registers under, and the
  // worker that opens the file. A default applied in four places is four chances for two of them to
  // disagree, and a page whose lock says one database while its broker says another is a tab that
  // leads an election nobody else is in.
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const deviceId = deviceIdForScope(scopeId, {
    ...(options.deviceStorage === undefined ? {} : { storage: options.deviceStorage }),
    namespace,
  });
  // First of the three refusals, and before anything has been built: a browser with no Web Locks
  // has nothing that can decide which tab may touch the database, and there is no smaller
  // arrangement to fall back to.
  const coordinator = new MultiTabCoordinator({ scopeId, namespace, locks: resolveLocks(options) });
  // Before the election, because the tab that wins has to be registered as the provider before any
  // tab that loses starts asking for a port. Constructing it is also where a browser with no
  // `SharedWorker` is refused, and that has to happen before a lock is taken rather than after.
  let broker: WeftBrokerClient;
  try {
    broker = new WeftBrokerClient((options.createBroker ?? defaultCreateBroker)(options.broker), scopeId, namespace);
  } catch (error) {
    coordinator.close();
    throw error;
  }

  let role: TabRole;
  try {
    role = await coordinator.elect();
  } catch (error) {
    coordinator.close();
    broker.dispose();
    throw error;
  }

  const tab = new DatabaseTab(options, coordinator, broker, deviceId, namespace);
  try {
    // A worker is created by the tab holding the lock and by no other, which is the whole of the
    // exclusion: every other tab is handed a port to that one.
    await tab.start(role === "follower");
  } catch (error) {
    await tab.dispose();
    throw error;
  }
  return tab.handle();
}

/**
 * One tab's whole connection to the database, from the open to the last teardown, across however
 * many workers it talks to on the way.
 *
 * A class rather than the two functions this used to be, because leadership moving turns "which
 * half is this tab" from something settled at the open into something that changes underneath a
 * mirror the application is still holding. Both halves therefore have to be reachable from one
 * object that owns the mirror and outlives either of them.
 */
class DatabaseTab {
  readonly #options: OpenWeftDatabaseOptions;
  readonly #coordinator: MultiTabCoordinator;
  readonly #broker: WeftBrokerClient;
  readonly #deviceId: DeviceId;
  /** Resolved by the caller, so every worker this tab builds opens the same database. */
  readonly #namespace: string;
  #mirror: WeftClientMirror | undefined;
  /** The dedicated worker, in the tab that made one. Nothing in a tab that was handed a port. */
  #worker: WorkerLike | undefined;
  #transport: WorkerPortTransport | undefined;
  /** This tab's end of the channel it asked the broker to complete, in a tab that is not leading. */
  #brokered: BrokeredPort | undefined;
  /** The leader's subscription to arriving ports. */
  #offPort: (() => void) | undefined;
  /** This tab being granted the lock. The only thing that makes it the leader. */
  #offPromotion: (() => void) | undefined;
  /** Somebody else having taken the scope's worker over. A reconnect notice, never a promotion. */
  #offProvider: (() => void) | undefined;
  /**
   * The credential last handed over, replayed after a migration. A new worker has never been told
   * one, and a device whose session silently stopped syncing after another tab closed would be the
   * quietest possible failure.
   */
  #token: string | null | undefined;
  /**
   * What the worker currently serving this tab said about its storage. Set on every connection —
   * both halves of `start` and both halves of `#migrate` go through the two methods that write it —
   * so a tab that reconnected to a different worker reports that worker's answer.
   */
  #durability: WeftDurability = "durable";
  #migrating: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(
    options: OpenWeftDatabaseOptions,
    coordinator: MultiTabCoordinator,
    broker: WeftBrokerClient,
    deviceId: DeviceId,
    namespace: string,
  ) {
    this.#options = options;
    this.#coordinator = coordinator;
    this.#broker = broker;
    this.#deviceId = deviceId;
    this.#namespace = namespace;
  }

  /** Connects, hydrates, and stands this tab in line for the worker it does not hold. */
  async start(follower: boolean): Promise<void> {
    const transport = follower ? await this.#connectToProvider() : await this.#createWorker();
    const mirror = new WeftClientMirror({
      transport,
      scopeId: this.#options.scopeId,
      deviceId: this.#deviceId,
      // One mirror, one engine. Sharing an engine between two mirrors has them evicting each
      // other's cached snapshots on every render, which `useSyncExternalStore` turns into an update
      // loop rather than a slow render — so the engine is built here and never handed out.
      engine: new SubscriptionEngine(),
      ...(this.#options.onError === undefined ? {} : { onError: this.#options.onError }),
    });
    this.#mirror = mirror;
    await mirror.hydrate();
    // Two ways this tab's worker can change under it, and they are not symmetrical.
    //
    // The lock is the first. Being granted it is a browser-guaranteed statement that the previous
    // holder's document is gone, and it is the only thing anywhere that makes this tab the leader.
    // Registered before the queue is joined, because succession can be granted in the same turn the
    // previous leader lets go and a listener attached afterwards would miss the one event it exists
    // for.
    this.#offPromotion = this.#coordinator.onPromotion(() => {
      this.#migrating = this.#migrating.then(() => this.#migrate("leader"));
    });
    // The broker is the second, and it is a message: some other tab took the lock and registered as
    // the provider. That is all it can mean. A tab further back in the queue is never woken by the
    // lock, so without this its port would go on pointing into a document that has gone — but
    // hearing it makes this tab reconnect, never lead, because a peer's word is not a grant and
    // treating it as one is how two documents come to hold one OPFS access handle.
    this.#offProvider = this.#broker.onProvider(() => {
      this.#migrating = this.#migrating.then(async () => {
        // A tab that holds the worker keeps it. `WeftBrokerClient` already spares a provider its
        // own claim; this is the same rule read at the moment it would be acted on, so a notice
        // that arrived while this tab was busy taking over cannot undo the taking over.
        if (this.#worker !== undefined) return;
        await this.#migrate("follower");
      });
    });
    this.#coordinator.watchLeader();
  }

  handle(): WeftDatabase {
    const mirror = this.#requireMirror();
    const coordinator = this.#coordinator;
    // Read through a closure rather than off a captured value, for the reason the getter below
    // gives; an arrow keeps this tab without aliasing it into the returned object.
    const durability = (): WeftDurability => this.#durability;
    const token = this.#options.relay?.token;
    // Handed over here rather than by the caller because a mirror with no token has a client and no
    // session: the worker holds the rows and never syncs them, which is a device that works
    // perfectly offline and never comes back. A device with no `relay` is told nothing, because
    // asking a worker that was given no session options to authenticate is refused rather than
    // ignored.
    if (token !== undefined) this.setToken(token());
    return {
      source: mirror,
      // A getter over the coordinator rather than a value read once: a follower granted the lock
      // is the leader from that moment, and a banner driven off a captured value would go on
      // describing a tab that had stopped being what it said.
      get role(): TabRole {
        return coordinator.role;
      },
      // The coordinator's own listener set, which already fires on the one event that moves a role
      // and already fires after `role` has been set. A second set kept here would be the same
      // listeners notified from the same place, one turn later.
      subscribeRole: (listener) => coordinator.onPromotion(listener),
      // A getter for the same reason `role` is one: a migration reconnects this tab to a worker it
      // has never spoken to, and the answer is that worker's rather than the first one's.
      get durability(): WeftDurability {
        return durability();
      },
      status: () => mirror.status(),
      subscribeStatus: (listener) => mirror.subscribeStatus(listener),
      setToken: (next) => {
        // No argument re-reads the option: a token that has been refreshed since the open is a new
        // credential, and the session is rebuilt around it rather than having one patched in place.
        this.setToken(next === undefined ? (token?.() ?? null) : next);
      },
      dispose: () => this.dispose(),
    };
  }

  setToken(token: string | null): void {
    this.#token = token;
    this.#mirror?.setToken(token);
  }

  /**
   * Unwinds everything, in the order that leaves nothing running.
   *
   * Each step is load-bearing. Stop applying pushes; stop taking ports; hand this tab's watches
   * back so the worker stops recomputing statements nobody reads; ask the worker to close the
   * database, which is what makes it let go of the OPFS access handle; only then settle what was in
   * flight, stop the worker, and last of all hand the Web Lock back — before which the successor
   * would open a file this worker still holds.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#offPromotion?.();
    this.#offPromotion = undefined;
    this.#offProvider?.();
    this.#offProvider = undefined;
    this.#mirror?.dispose();
    this.#offPort?.();
    this.#offPort = undefined;
    const transport = this.#transport;
    const closing = this.#worker === undefined ? { type: "disconnect" as const } : { type: "close" as const };
    if (transport !== undefined) {
      // Bounded, because the rest of the teardown is not optional. A worker that has stopped
      // answering must not also stop the Web Lock being handed back — that would leave every other
      // tab of this scope waiting on a leader that has gone.
      await Promise.race([
        transport.request(closing).catch(() => undefined),
        delay(this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS),
      ]);
      transport.dispose("the database was closed");
    }
    this.#transport = undefined;
    this.#brokered?.discard();
    this.#brokered = undefined;
    this.#broker.dispose();
    this.#worker?.terminate?.();
    this.#worker = undefined;
    this.#coordinator.close();
  }

  /**
   * Leadership moved. Whatever this tab was talking to is gone; it reconnects and reloads.
   *
   * Both roles mean the same thing about what was outstanding — the worker died with the document
   * that created it — and only one of them also means this tab now holds the access handle. Which
   * of the two this is was decided by the caller and never by this method: `"leader"` comes from
   * the lock being granted, `"follower"` from the broker saying somebody else is providing, and
   * nothing here can turn one into the other.
   */
  async #migrate(role: "leader" | "follower"): Promise<void> {
    if (this.#disposed) return;
    const mirror = this.#mirror;
    if (mirror === undefined) return;
    // First, and unconditionally. A request issued a moment before the worker vanished is never
    // going to be answered, and leaving it pending is a caller awaiting a promise nothing is left
    // to settle. It rejects rather than resolving: telling a mutator that a write nobody performed
    // had succeeded is the one outcome worse than not knowing.
    this.#transport?.dispose(MIGRATED);
    this.#transport = undefined;
    this.#offPort?.();
    this.#offPort = undefined;
    this.#brokered?.discard();
    this.#brokered = undefined;
    try {
      const transport = role === "leader" ? await this.#succeedToWorker() : await this.#connectToProvider();
      if (this.#disposed) return;
      // The rows and every registration are made again from the new worker. What comes back is
      // whatever committed to the database, which is also the answer for the write whose fate the
      // rejection above declined to guess at.
      await mirror.attach(transport);
      if (this.#token !== undefined) mirror.setToken(this.#token);
    } catch (error) {
      this.#report(error);
    }
  }

  /** Creates the worker for this scope, takes it, and registers as the tab that holds it. */
  async #createWorker(): Promise<WorkerPortTransport> {
    return this.#takeWorker(await this.#buildWorker());
  }

  /**
   * Creates the worker for a tab the browser has just handed the lock to, and insists on the
   * database this tab already had.
   *
   * A first open and a succession are not the same question, and only the page can tell them apart.
   * Inside the worker a pool that will never be given and a pool that is still being given back look
   * identical — both are a rejection out of `installOpfsSAHPoolVfs` — and both are answered with an
   * in-memory database. A tab that crashes runs no teardown, so the browser releases its lock and
   * its access handles on schedules of its own, and a successor granted the lock a moment early
   * would come up ephemeral with the durable file still sitting on disk and nothing left that can
   * reach it. Silently.
   *
   * The page has the one fact that settles it: what kind of database this tab was reading a moment
   * ago. A device that was durable and whose new worker is not has hit the handover, not a browser
   * that changed its mind, so that worker is thrown away and another is built. A device that was
   * already ephemeral asks nothing and waits for nothing — which is what keeps private browsing,
   * where the pool fails every time and no wait would ever help, paying none of this.
   *
   * The workers thrown away here were never taken: nothing on this tab was pointed at them and no
   * other tab was told they existed, so stopping one unwinds nothing.
   */
  async #succeedToWorker(): Promise<WorkerPortTransport> {
    const had = this.#durability;
    for (let attempt = 1; ; attempt += 1) {
      const built = await this.#buildWorker();
      if (had === "ephemeral" || built.durability === "durable") return this.#takeWorker(built);
      built.worker.terminate?.();
      if (attempt >= POOL_HANDOVER_ATTEMPTS) {
        throw new Error(
          `this tab took over the storage worker for scope ${this.#options.scopeId}, and ${POOL_HANDOVER_ATTEMPTS} ` +
            "attempts later the browser was still refusing the OPFS synchronous access handle pool. This " +
            "device's database is durable, so an in-memory one would be a different and empty database " +
            "with the real one unreachable beside it; the tab is left reporting this instead.",
        );
      }
      await delay(POOL_HANDOVER_STEP_MS * attempt);
      if (this.#disposed) throw new Error("the database was closed while it was taking over");
    }
  }

  /**
   * Starts a worker and waits for it to say what it opened.
   *
   * Nothing on this tab is changed by it, which is what lets `#succeedToWorker` throw one away.
   */
  async #buildWorker(): Promise<BuiltWorker> {
    const options = this.#options;
    const worker = (options.createWorker ?? defaultCreateWorker)(options.worker, this.#namespace);
    // Before the transport, because the worker announces itself unasked and a transport that was
    // listening would have to be told to ignore it. What comes back also settles whether there is a
    // database at all.
    let ready: { readonly ok: true; readonly schemaHash: string; readonly durability: WeftDurability };
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
    return { worker, durability: ready.durability };
  }

  /** Points this tab at a worker it has decided to keep, and starts serving the other tabs from it. */
  #takeWorker(built: BuiltWorker): WorkerPortTransport {
    const worker = built.worker;
    const transport = new WorkerPortTransport(worker);
    this.#worker = worker;
    this.#transport = transport;
    this.#durability = built.durability;
    // The one line whose absence is invisible from here: a port delivered by the broker and not
    // forwarded into the worker leaves the tab that asked for it holding a channel with nothing on
    // the other end, waiting for an answer nobody is going to give.
    this.#offPort = this.#broker.onPort((port) => {
      // Transferred, not cloned — a port cannot be copied. After this line the port belongs to the
      // worker, and this document has no usable reference to it at all.
      worker.postMessage({ weft: "connect", port }, [port]);
    });
    // Last, so that a tab asking for a port only ever finds this one once it can serve.
    this.#broker.provide();
    return transport;
  }

  /**
   * Asks the broker for a port to the tab that holds the worker, until one answers.
   *
   * There are two ways this can fail to connect and the loop treats them the same, because to the
   * tab asking they are the same: the broker may have no provider registered at all, or it may have
   * one that has since died — a registration is not liveness, and deliberately is not (see
   * `serveWeftPortBroker`). So the test is not "was the port accepted" but "does something answer
   * over it".
   *
   * What is asked is `hydrate`, which is what this tab was going to send first in any case. Its
   * reply is also the only route by which a tab that was handed a port learns whether the database
   * is durable: the worker announced that once, to the tab that created it, and this tab was not
   * that tab, so without reading the reply the same database would be reported durable here and
   * ephemeral next door.
   *
   * The rows in that reply are dropped, and the mirror built afterwards asks again. The alternative
   * is a window with nothing listening: a mirror subscribes to the worker's pushes when it is
   * constructed, and rows adopted from a reply that predates it would miss whatever another tab
   * changed in between — a page one edit behind, for ever, with nothing reporting it. One round trip
   * on a path taken once per connection buys that away.
   */
  async #connectToProvider(): Promise<WorkerPortTransport> {
    const timeoutMs = this.#options.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const probes: ProviderProbe[] = [];
    let kept: ProviderProbe | undefined;
    try {
      for (;;) {
        // Checked each time round, because this loop is the one thing in the open that can still be
        // running when the tab goes: a port taken after `dispose` would be a connection nothing is
        // left to close.
        if (this.#disposed) throw new Error("the database was closed while it was reconnecting");
        probes.push(this.#probeProvider());
        kept = await Promise.race([
          ...probes.map(async (probe) => {
            await probe.answered;
            return probe;
          }),
          delay(LEADER_PROBE_MS).then(() => undefined),
        ]);
        if (kept !== undefined) {
          this.#brokered = kept.brokered;
          this.#transport = kept.transport;
          // A worker old enough not to say is one that predates the memory fallback, and everything
          // that predates it was OPFS.
          this.#durability = kept.durability ?? "durable";
          return kept.transport;
        }
        if (Date.now() >= deadline) {
          throw new WeftOpenError(
            "no-leader",
            `no tab answered for scope ${this.#options.scopeId} within ${timeoutMs}ms. This tab does not ` +
              "hold the storage worker — another tab holds the OPFS access handle — and the ports it asked " +
              "the broker for reached nobody, so there is no tab serving rather than one being slow.",
          );
        }
      }
    } finally {
      // Every attempt that did not win, including the ones still standing. A port left open is a
      // channel into the worker that nothing on this tab is reading.
      for (const probe of probes) if (probe !== kept) probe.discard();
    }
  }

  /**
   * One attempt at reaching whoever is providing: a port from the broker, and a `hydrate` over it.
   *
   * Attempts are kept rather than abandoned when the probe interval passes, and that is the point of
   * the shape. A port delivered into a document that has gone is silent for ever; a worker reading a
   * large scope out of SQLite is silent for a while; nothing distinguishes the two at a hundred
   * milliseconds. A loop that discarded on the interval would throw away a healthy worker's answer
   * again and again and end by reporting `no-leader` against a database that was working the whole
   * time. So each interval adds another port instead, and whichever answers first is the one kept.
   */
  #probeProvider(): ProviderProbe {
    const brokered = this.#broker.requestPort();
    // The transport is made before the far end has started delivering, which is safe and is what
    // makes the handover raceless: a `MessagePort` queues what arrives while it is stopped, so the
    // request below is waiting in the worker's own queue by the time the worker calls `start` on it.
    const transport = new WorkerPortTransport(brokered.port);
    let discarded = false;
    const probe: ProviderProbe = {
      transport,
      brokered,
      answered: Promise.resolve(),
      durability: undefined,
      discard: () => {
        if (discarded) return;
        discarded = true;
        transport.dispose("this port never reached the storage worker");
        brokered.discard();
      },
    };
    probe.answered = new Promise<void>((answered) => {
      const settle = (value: unknown): void => {
        // A discarded attempt never wins. Closing its transport rejects the request standing on it,
        // and taking that for an answer would hand this tab a port it had already closed.
        if (discarded) return;
        if (isWorkerHydrated(value)) probe.durability = value.durability;
        answered();
      };
      // A rejection counts: a worker that is answering and refusing is still a worker, and this is
      // only asking whether one is there.
      void transport
        .request({ type: "hydrate", scopeId: this.#options.scopeId, deviceId: this.#deviceId })
        .then(settle, () => settle(undefined));
    });
    // The broker had nobody to give the port to, which is no provider rather than a slow one. That
    // attempt can never answer, so it is closed now instead of at the deadline.
    void brokered.refused.then(() => probe.discard());
    return probe;
  }

  #requireMirror(): WeftClientMirror {
    const mirror = this.#mirror;
    if (mirror === undefined) throw new Error("this database was not opened");
    return mirror;
  }

  #report(error: unknown): void {
    const report = this.#options.onError ?? defaultOnError;
    report(error instanceof Error ? error : new Error(String(error)));
  }
}

/** A worker that has said what it opened, before any tab has been pointed at it. */
interface BuiltWorker {
  readonly worker: WorkerLike;
  readonly durability: WeftDurability;
}

/** One attempt at reaching the tab that holds the worker. See `DatabaseTab.#probeProvider`. */
interface ProviderProbe {
  readonly transport: WorkerPortTransport;
  readonly brokered: BrokeredPort;
  /** Settles when the far end answers, either way. A port nobody holds never settles it. */
  answered: Promise<void>;
  /** What the reply said about the database, for the attempt that gets one. */
  durability: WeftDurability | undefined;
  /** Closes this attempt's port. Idempotent, and after it nothing this attempt hears is an answer. */
  discard(): void;
}

function defaultOnError(error: Error): void {
  console.error("weftdb: this tab could not reconnect to the storage worker", error);
}

/**
 * Waits for the worker's one unasked announcement.
 *
 * A worker that cannot open a database reports it here rather than throwing where nobody is
 * listening, and a worker that never reports at all — a module that failed to load, a build without
 * the entry point — is a timeout rather than an open that hangs for the life of the page.
 */
async function awaitWorkerReady(
  worker: WorkerLike,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly schemaHash: string; readonly durability: WeftDurability }> {
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      worker.removeEventListener("message", listener);
    };
    const listener = (event: MessageEvent<WorkerMessage>): void => {
      const message: unknown = event.data;
      if (!isWeftWorkerReady(message)) return;
      settle();
      // Absent means durable: a worker that opened OPFS has nothing to qualify.
      if (message.ok)
        resolve({ ok: true, schemaHash: message.schemaHash, durability: message.durability ?? "durable" });
      else {
        reject(
          new WeftOpenError(
            "storage-unavailable",
            `the storage worker could not open a database at all: ${message.error}. A browser that ` +
              "declines the OPFS synchronous access handle pool is served an in-memory database " +
              "instead, so reaching this means the sqlite3 build the worker was given cannot do OPFS " +
              "in the first place — check that `sqlite3InitModule` is the OPFS-capable build and that " +
              "it is imported from a dedicated worker, which is the only place that VFS exists.",
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Web Locks, which is what decides who may touch the database.
 *
 * A browser without one is refused here, before anything is built and in every tab, for the reason
 * `defaultCreateBroker` gives about `SharedWorker`. Only one document may hold the OPFS access
 * handle and only the lock says which; without it every tab of an origin would believe it is the
 * only one, and two tabs of one browser would run two databases, two outboxes and two sync sessions
 * under a single device id — a device that overwrites its own work with a straight face.
 *
 * Nothing is lost by insisting. Web Locks reached Safari in 15.4, against 16.4 for `SharedWorker`
 * and 17 for OPFS synchronous access handles, so every browser that can run any of this has it.
 */
function resolveLocks(options: OpenWeftDatabaseOptions): LockManagerLike {
  const locks = options.locks ?? (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (locks === undefined) {
    throw new WeftOpenError(
      "no-locks",
      "this environment has no Web Locks (navigator.locks). weftdb needs one to decide which tab may " +
        "hold the OPFS access handle: without it every tab would create a worker of its own, and two " +
        "tabs of one browser would keep two databases and two outboxes under one device id. Pass " +
        "`locks` to supply one.",
    );
  }
  return locks;
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

function defaultCreateWorker(url: URL | string, namespace: string): WorkerLike {
  const constructor = (globalThis as { Worker?: new (url: URL | string, options?: { type: "module" }) => unknown })
    .Worker;
  if (constructor === undefined) {
    throw new WeftOpenError(
      "no-worker",
      "this environment has no Worker constructor. weftdb keeps its database in a dedicated worker " +
        "because an OPFS synchronous access handle exists nowhere else; pass `createWorker` to supply one.",
    );
  }
  return new constructor(namespacedWorkerUrl(url, namespace), { type: "module" }) as WorkerLike;
}

/**
 * The worker's URL with this database's namespace written into its query string.
 *
 * Which file the worker opens is the one thing the page decides and the worker performs, and the
 * URL is the only way to say it in time. A worker opens its database as it starts — the page's first
 * message is the `ready` announcement coming back the other way — so anything sent over the port
 * arrives after a pool has already been asked for, and the second application's tab would have been
 * refused it by then. What the worker reads back out of this is in `serveWeftWorkerDefaults`.
 *
 * Resolved against the document's own address, because `new URL("./storage-worker.js")` is not a
 * URL: the value an application passes is usually `new URL("./storage-worker.ts", import.meta.url)`,
 * which is absolute, but a relative string is what a `Worker` constructor takes and has to keep
 * meaning the same thing.
 */
function namespacedWorkerUrl(url: URL | string, namespace: string): URL {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  let resolved: URL;
  try {
    resolved = new URL(String(url), base);
  } catch {
    // Not a `WeftOpenError`: every reason in that union names a capability the environment does not
    // have, and this is a value the caller passed. It is also a URL no `Worker` constructor would
    // have accepted either, so nothing is being refused that would otherwise have worked.
    throw new Error(
      `the storage worker's URL could not be resolved: ${String(url)}. weftdb writes this database's ` +
        "namespace into it, which is how the worker knows which OPFS pool is its own.",
    );
  }
  resolved.searchParams.set(WEFT_NAMESPACE_PARAM, namespace);
  return resolved;
}

/**
 * Connects to the broker, which is a `SharedWorker`.
 *
 * A browser without one is refused here, loudly, and in every tab rather than only in the ones that
 * turn out not to hold the worker. That is deliberate. A tab that opened without a broker cannot be
 * given a port and cannot hand one out, so a second tab of the same origin would fail later and
 * somewhere else, with the first tab working perfectly and nothing connecting the two symptoms.
 * There is no smaller database to fall back to either: every tab reaches storage the same way, so a
 * missing broker is the whole of storage missing. One storage topology, one failure site.
 */
function defaultCreateBroker(url: URL | string): BrokerPortLike {
  const constructor = (
    globalThis as {
      SharedWorker?: new (url: URL | string, options?: { type: "module" }) => { readonly port: BrokerPortLike };
    }
  ).SharedWorker;
  if (constructor === undefined) {
    throw new WeftOpenError(
      "no-broker",
      "this environment has no SharedWorker constructor. weftdb needs one to hand a MessagePort from a " +
        "tab that wants the database to the tab that holds it: a BroadcastChannel cannot carry a " +
        "transferable, and nothing else in a browser can. Pass `createBroker` to supply one.",
    );
  }
  return new constructor(url, { type: "module" }).port;
}
