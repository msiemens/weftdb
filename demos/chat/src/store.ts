// What is left of an application's data layer once the library and codegen have taken their
// halves. Row types, decoding, queries, mutators and hooks come from `src/generated`, which
// `weft generate` writes from the schema; syncing, connectivity and status come from
// `WeftSession`. What is genuinely this application's is here: which storage it uses, who this
// tab is, and the heartbeat that keeps its device record current.
import { rowId, type RowId } from "weftdb/core";
import {
  connectSocketTransport,
  httpTransport,
  SubscriptionEngine,
  WebStorageClientStore,
  WeftSession,
  type AsyncSyncTransport,
  type BroadcastChannelLike,
  type SessionStatus,
  type StorageLike,
  type WeftClient,
} from "weftdb/client";
import { schemaHash } from "weftdb/schema";
import { tabIdentity, type TabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "./schema.ts";
import { DEMO } from "./scope.ts";
import {
  decodeDevices,
  decodeMessages,
  devicesMutators,
  devicesQuery,
  devicesTable,
  messagesMutators,
  messagesQuery,
  type DevicesMutators,
  type DevicesRow,
  type MessagesMutators,
  type MessagesRow,
  type WeftSource,
} from "./generated/bindings.ts";

export { devicesQuery, messagesQuery, useDevices, useMessages } from "./generated/bindings.ts";
export type { DevicesRow, MessagesRow } from "./generated/bindings.ts";
export type { BroadcastChannelLike } from "weftdb/client";

const HASH = schemaHash(schema);

/** How often a tab rewrites its own device record. */
export const HEARTBEAT_MS = 5_000;
/** How long after its last heartbeat a device still counts as connected. */
export const PRESENT_MS = 15_000;

/** A message as the log needs it: the generated row type plus what only the client knows. */
export interface MessageView extends MessagesRow {
  /** Local work the server has not acknowledged. */
  readonly dirty: boolean;
  /** Written by this tab. */
  readonly mine: boolean;
}

/** A device record with the two things the row itself cannot say. */
export interface DeviceView extends DevicesRow {
  readonly here: boolean;
  readonly self: boolean;
}

export type StoreStatus = SessionStatus;

export interface ChatStoreOptions {
  readonly identity: TabIdentity;
  readonly client: WeftClient;
  /** Used whenever the socket is not up — the same session, over HTTP. */
  readonly transport: AsyncSyncTransport;
  readonly channel?: BroadcastChannelLike | undefined;
  /** Where the relay's sync socket is. Omitted means HTTP and a poll, which still works. */
  readonly socketUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
}

export interface WindowLike {
  readonly sessionStorage: StorageLike;
  readonly localStorage: StorageLike;
}

export class ChatStore {
  readonly identity: TabIdentity;
  readonly client: WeftClient;
  readonly engine = new SubscriptionEngine();
  readonly messages: MessagesMutators;
  readonly devices: DevicesMutators;
  readonly session: WeftSession;
  readonly now: () => number;

  constructor(options: ChatStoreOptions) {
    this.identity = options.identity;
    this.client = options.client;
    this.now = options.now ?? (() => Date.now());
    this.session = new WeftSession({
      client: options.client,
      schemaHash: HASH,
      transport: options.transport,
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      ...(options.now === undefined ? {} : { now: options.now }),
      // Views read through the engine, so anything that moves the client tells it to look again.
      onChange: () => this.engine.notify(),
      ...(options.socketUrl === undefined
        ? {}
        : {
            // The socket is what this demo is for: the relay says "this scope is now at sequence
            // N" and the session syncs on being told, rather than on a timer.
            openSocket: (handlers) =>
              connectSocketTransport({
                url: options.socketUrl as string,
                token: options.identity.token,
                onWake: () => handlers.onWake(),
                onBatch: handlers.onBatch,
                onStatusChange: handlers.onStatusChange,
                cursor: handlers.cursor,
              }),
          }),
    });
    const changed = (): void => this.session.changed();
    this.messages = messagesMutators(options.client, changed);
    this.devices = devicesMutators(options.client, changed);
  }

  /** Opens the state this tab left behind, or a fresh client on a first visit. */
  static open(window: WindowLike): ChatStore {
    // The scope comes from local storage, so every tab of this browser joins the same room while
    // another visitor gets their own. The device comes from session storage, so each tab is a
    // device of its own.
    const identity = tabIdentity(window.sessionStorage, window.localStorage, { demo: DEMO });
    const persistence = new WebStorageClientStore(window.localStorage, schema, `weftdb-demo/${DEMO}`);
    return new ChatStore({
      identity,
      client: persistence.hydrate(identity.scopeId, identity.deviceId),
      transport: httpTransport({ baseUrl: "/api", token: identity.token }),
      // Same origin as the page, so the dev server's proxy carries the upgrade too.
      socketUrl: `${location.origin.replace(/^http/u, "ws")}/api/sync`,
      // Named for the scope, so two demos in two tabs do not wake each other's sessions.
      channel:
        typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(`weftdb-demo/${identity.scopeId}`),
    });
  }

  /** What the React hooks read from. */
  get source(): WeftSource {
    return { engine: this.engine, rows: this.client.rows };
  }

  /** Starts the session and the heartbeat that puts this tab on the device strip. */
  start(): () => void {
    const stop = this.session.start();
    this.touch();
    const timer = setInterval(() => this.touch(), HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      stop();
    };
  }

  /**
   * Rewrites this tab's device record. The first one creates the row and every one after it is
   * an update, which is the whole difference between this collection and the message log: a
   * device record is a current value, a message is a fact that already happened.
   */
  touch(): void {
    const id = String(this.identity.deviceId);
    const values = { label: this.identity.label, last_seen: this.now() };
    if (this.client.getRow(devicesTable, rowId(id)) === undefined) {
      this.devices.create(id, values);
      return;
    }
    this.devices.update(id, values);
  }

  /** Adds what only the client knows to a decoded message. */
  view(row: MessagesRow): MessageView {
    return {
      ...row,
      dirty: this.client.isRowDirty(messagesQuery().tableName, rowId(row.id)),
      mine: row.device === String(this.identity.deviceId),
    };
  }

  /**
   * The device strip: everything that has ever joined this room, ordered by device id.
   *
   * The order is a total one over a key the row cannot change: a device id is written when the
   * row is created and is immutable after it, so the strip holds still while heartbeats land.
   * `last_seen` is the value every heartbeat rewrites, which makes it the one field a stable
   * order cannot read. Comparison is by code unit rather than `localeCompare`, so two devices
   * in two locales lay the same rows out the same way.
   */
  presence(rows: readonly DevicesRow[]): readonly DeviceView[] {
    const cutoff = this.now() - PRESENT_MS;
    return [...rows]
      .sort((left, right) => compareIds(left.id, right.id))
      .map((row) => ({
        ...row,
        here: row.last_seen >= cutoff,
        self: row.id === String(this.identity.deviceId),
      }));
  }

  /** The log outside a render, ordered as the page shows it. */
  rows(): readonly MessageView[] {
    return this.engine
      .getSnapshot(messagesQuery("created"), this.client.rows.values())
      .rows.map((row) => this.view(decodeMessages(row)));
  }

  /** The device records outside a render. */
  deviceRows(): readonly DevicesRow[] {
    return this.engine.getSnapshot(devicesQuery("id"), this.client.rows.values()).rows.map((row) => decodeDevices(row));
  }

  status(): StoreStatus {
    return this.session.status();
  }

  subscribeStatus(listener: () => void): () => void {
    return this.session.subscribe(listener);
  }

  get online(): boolean {
    return this.session.online;
  }

  setOnline(online: boolean): void {
    this.session.setOnline(online);
  }

  discardQuarantine(): void {
    this.session.discardQuarantine();
  }

  /** Posts a message. Append-class rows carry no update, so this is the only write there is. */
  send(body: string): void {
    const trimmed = body.trim();
    if (trimmed === "") return;
    this.messages.create(newMessageId(), {
      body: trimmed,
      device: String(this.identity.deviceId),
      author: this.identity.label,
    });
  }

  async sync(): Promise<void> {
    await this.session.sync();
  }

  changed(): void {
    this.session.changed();
  }
}

/** Code units, the way `SubscriptionEngine` orders a query, and for the same reason. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function newMessageId(): RowId {
  return rowId(`message-${crypto.randomUUID()}`);
}
