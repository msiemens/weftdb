// What is left of an application's data layer once the library and codegen have taken their
// halves. Row types, decoding, queries, mutators and hooks come from `src/generated`, which
// `weft generate` writes from the schema; the database, the worker that holds it and the sync
// session all come from `openWeftDatabase`. What is genuinely this application's is here: which
// scope this visitor is on, the heartbeat that keeps this tab's device record current, and what a
// row looks like once the client's own knowledge is added to it.
import { deviceId as toDeviceId, rowId, type DeviceId, type RowId } from "weftdb/core";
import type { SessionStatus, StorageLike, WeftClientMirror } from "weftdb/client";
import { openDemoDatabase, DemoSync, type DemoDatabase, type DemoOpenOverrides } from "weftdb-demo-shared/open";
import { tabIdentity, type TabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "./schema.ts";
import { DEMO } from "./scope.ts";
import relayWorkerUrl from "./relay-worker.ts?sharedworker&url";
import storageWorkerUrl from "./storage-worker.ts?sharedworker&url";
import {
  decodeDevices,
  decodeMessages,
  devicesMutators,
  devicesQuery,
  devicesTable,
  messagesMutators,
  messagesQuery,
  messagesTable,
  type DevicesMutators,
  type DevicesRow,
  type MessagesMutators,
  type MessagesRow,
} from "./generated/bindings.ts";

export { devicesQuery, messagesQuery, useDevicesQuery, useMessages } from "./generated/bindings.ts";
export type { DevicesRow, MessagesRow } from "./generated/bindings.ts";

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
  readonly database: DemoDatabase;
  readonly now?: (() => number) | undefined;
}

export interface WindowLike {
  readonly sessionStorage: StorageLike;
  readonly localStorage: StorageLike;
}

export class ChatStore {
  readonly identity: TabIdentity;
  readonly database: DemoDatabase;
  /**
   * What the React hooks read from and what the mutators write through: the mirror of the client
   * the storage worker holds. It is a `WeftSource`, so `use<Collection>` and `use<Collection>Query`
   * both work over it — the second because there is a real SQLite on the other side of the port for
   * a compiled statement to run against.
   */
  readonly source: WeftClientMirror;
  /** This tab as the relay knows it, minted by `openWeftDatabase` under this tab's namespace. */
  readonly deviceId: DeviceId;
  readonly messages: MessagesMutators;
  readonly devices: DevicesMutators;
  /** The status pills, the online toggle, and the two verbs the header's buttons call. */
  readonly connection: DemoSync;
  readonly now: () => number;

  constructor(options: ChatStoreOptions) {
    this.identity = options.identity;
    this.database = options.database;
    this.source = options.database.weft.source;
    this.deviceId = toDeviceId(this.source.deviceId);
    this.connection = new DemoSync(options.database);
    this.now = options.now ?? (() => Date.now());
    // No `notify` callback: the worker's echo wakes the subscriptions when the change arrives, and
    // a callback fired when the mutator returned would wake them before there was anything new.
    this.messages = messagesMutators(this.source);
    this.devices = devicesMutators(this.source);
  }

  /**
   * Opens this tab's database.
   *
   * The scope comes from local storage, so every tab of this browser joins the same room while
   * another visitor gets their own. The namespace comes from session storage, so **each tab is a
   * database of its own** — its own client in the storage worker, its own file and its own
   * device id — which is what puts a second chip on the device strip when you open a second tab.
   */
  static async open(window: WindowLike, overrides?: DemoOpenOverrides): Promise<ChatStore> {
    const identity = await tabIdentity(window.sessionStorage, window.localStorage, { demo: DEMO });
    const database = await openDemoDatabase({
      schema,
      scopeId: identity.scopeId,
      namespace: `weftdb-demo/${DEMO}/${identity.deviceId}`,
      worker: storageWorkerUrl,
      relayWorker: relayWorkerUrl,
      ...(overrides === undefined ? {} : { overrides }),
    });
    return new ChatStore({ identity, database });
  }

  /** Starts the heartbeat that puts this tab on the device strip. */
  start(): () => void {
    void this.touch();
    const timer = setInterval(() => void this.touch(), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }

  /**
   * Rewrites this tab's device record. The first one creates the row and every one after it is
   * an update, which is the whole difference between this collection and the message log: a
   * device record is a current value, a message is a fact that already happened.
   */
  async touch(): Promise<void> {
    const id = String(this.deviceId);
    const values = { label: this.identity.label, last_seen: this.now() };
    if (this.source.getRow(devicesTable, rowId(id)) === undefined) {
      await this.devices.create(id, values);
      return;
    }
    await this.devices.update(id, values);
  }

  /** Adds what only the client knows to a decoded message. */
  view(row: MessagesRow): MessageView {
    return {
      ...row,
      dirty: this.source.isRowDirty(messagesTable, rowId(row.id)),
      mine: row.device === String(this.deviceId),
    };
  }

  /**
   * The device strip: everything that has ever joined this room, in the order the statement that
   * selected it put them.
   *
   * That order is a total one over a key the row cannot change — a device id is written when the
   * row is created and is immutable after it — so the strip holds still while heartbeats land.
   * `last_seen` is the value every heartbeat rewrites, which makes it the one field a stable order
   * cannot read. What is added here is the pair of facts the row itself cannot carry: whether the
   * heartbeat is recent enough to call the device present, and whether it is this tab.
   */
  presence(rows: readonly DevicesRow[]): readonly DeviceView[] {
    const cutoff = this.now() - PRESENT_MS;
    return rows.map((row) => ({
      ...row,
      here: row.last_seen >= cutoff,
      self: row.id === String(this.deviceId),
    }));
  }

  /** The log outside a render, ordered as the page shows it. */
  rows(): readonly MessageView[] {
    return this.source.engine
      .getSnapshot(messagesQuery("created"), this.source.rows.values())
      .rows.map((row) => this.view(decodeMessages(row)));
  }

  /** The device records outside a render. */
  deviceRows(): readonly DevicesRow[] {
    return this.source.engine
      .getSnapshot(devicesQuery("id"), this.source.rows.values())
      .rows.map((row) => decodeDevices(row));
  }

  status(): StoreStatus {
    return this.connection.status();
  }

  subscribeStatus(listener: () => void): () => void {
    return this.connection.subscribe(listener);
  }

  get online(): boolean {
    return this.connection.online;
  }

  setOnline(online: boolean): void {
    this.connection.setOnline(online);
  }

  async discardQuarantine(): Promise<void> {
    await this.connection.discardQuarantine();
  }

  /** Posts a message. Append-class rows carry no update, so this is the only write there is. */
  async send(body: string): Promise<void> {
    const trimmed = body.trim();
    if (trimmed === "") return;
    await this.messages.create(newMessageId(), {
      body: trimmed,
      device: String(this.deviceId),
      author: this.identity.label,
    });
  }

  async sync(): Promise<void> {
    await this.connection.sync();
  }

  async dispose(): Promise<void> {
    await this.database.dispose();
  }
}

export function newMessageId(): RowId {
  return rowId(`message-${crypto.randomUUID()}`);
}
