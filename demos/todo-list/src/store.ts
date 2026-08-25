// What is left of an application's data layer once the library and codegen have taken their
// halves. Rows, decoding, mutators, hooks and reordering come from `src/generated`, which
// `weft generate` writes from the schema; syncing, connectivity and status come from
// `WeftSession`. What is genuinely this application's is here: which storage it uses, who this
// tab is, and what a row looks like once the client's own knowledge is added to it.
import { hasConflictMarkers, rowId, type RowId } from "weftdb/core";
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
import { rowMapSource } from "weftdb-react";
import { tabIdentity, type TabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "./schema.ts";
import { DEMO } from "./scope.ts";
import {
  decodeTodos,
  moveTodos,
  nextTodosRank,
  todoEventsMutators,
  todosMutators,
  todosQuery,
  type TodoEventsMutators,
  type TodosMutators,
  type TodosRow,
  type WeftSource,
} from "./generated/bindings.ts";

export { todoEventsQuery, todosQuery, useTodoEvents, useTodos } from "./generated/bindings.ts";
export type { TodoEventsRow, TodosRow } from "./generated/bindings.ts";
export type { BroadcastChannelLike } from "weftdb/client";

const HASH = schemaHash(schema);

/** A row as the list needs it: the generated row type plus what only the client knows. */
export interface TodoView extends TodosRow {
  /** Local work the server has not acknowledged. */
  readonly dirty: boolean;
  /** The notes hold diff3 markers, so two tabs edited the same line while apart. */
  readonly conflicted: boolean;
}

export type StoreStatus = SessionStatus;

export interface TodoStoreOptions {
  readonly identity: TabIdentity;
  readonly client: WeftClient;
  /** Used whenever the socket is not up — the same session, over HTTP. */
  readonly transport: AsyncSyncTransport;
  readonly channel?: BroadcastChannelLike | undefined;
  /** Where the relay's sync socket is. Omitted means HTTP and a poll, which still works. */
  readonly socketUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * Where the mark that this visitor's scope has been seeded is kept. It belongs in the storage
   * the scope itself lives in, so every tab of one browser reads the same mark. Omitted means the
   * store seeds nothing, which is what a test driving its own rows wants.
   */
  readonly seedStorage?: StorageLike | undefined;
}

export interface WindowLike {
  readonly sessionStorage: StorageLike;
  readonly localStorage: StorageLike;
}

/** Namespaces the mark, alongside the keys `weftdb-demo-shared/identity` writes. */
const SEED_MARK = `weftdb-demo/${DEMO}/seeded`;

interface SeedTodo {
  readonly title: string;
  readonly notes: string;
  readonly done: boolean;
}

/**
 * The list a visitor arrives to, in the order it is shown. Two of the rows carry several lines of
 * notes, which is what diff3 has to have to merge two devices writing at once, and one is done, so
 * the list shows both states before anything is clicked.
 */
const SEED: readonly SeedTodo[] = [
  {
    title: "Run the relay against the staging database",
    notes: "Listens on 8787.\nTokens come from WEFT_TOKENS.",
    done: true,
  },
  {
    title: "Write the migration notes",
    notes: "List the fields the schema adds.\nSay what happens to rows written before the change.",
    done: false,
  },
  {
    title: "Measure sync over a slow connection",
    notes: "Throttle one tab to 3G.\nRecord how long the unsent count takes to drain.",
    done: false,
  },
  {
    title: "Reorder the backlog",
    notes: "Blocked work goes last.",
    done: false,
  },
];

export class TodoStore {
  readonly identity: TabIdentity;
  readonly client: WeftClient;
  readonly engine = new SubscriptionEngine();
  /**
   * What the React hooks read from. Storage here is `localStorage`, so there is no SQLite for a
   * statement-backed read to run against and `use<Collection>Query` raises rather than quietly
   * matching nothing. Held rather than rebuilt per read, so a component's subscription survives
   * a render.
   */
  readonly source: WeftSource;
  readonly todos: TodosMutators;
  readonly todoEvents: TodoEventsMutators;
  readonly session: WeftSession;
  readonly #seedStorage: StorageLike | undefined;

  constructor(options: TodoStoreOptions) {
    this.identity = options.identity;
    this.client = options.client;
    this.source = rowMapSource({ engine: this.engine, rows: options.client.rows }, options.client.scopeId);
    this.#seedStorage = options.seedStorage;
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
    this.todos = todosMutators(options.client, changed);
    this.todoEvents = todoEventsMutators(options.client, changed);
  }

  /** Opens the state this tab left behind, or a fresh client on a first visit. */
  static open(window: WindowLike): TodoStore {
    // The scope comes from local storage, so every tab of this browser opens the same list while
    // another visitor opens their own. The device comes from session storage, so each tab is a
    // device of its own.
    const identity = tabIdentity(window.sessionStorage, window.localStorage, { demo: DEMO });
    const persistence = new WebStorageClientStore(window.localStorage, schema, `weftdb-demo/${DEMO}`);
    return new TodoStore({
      identity,
      client: persistence.hydrate(identity.scopeId, identity.deviceId),
      transport: httpTransport({ baseUrl: "/api", token: identity.token }),
      seedStorage: window.localStorage,
      // Same origin as the page, so the dev server's proxy carries the upgrade too.
      socketUrl: `${location.origin.replace(/^http/u, "ws")}/api/sync`,
      // Named for the scope, so two demos in two tabs do not wake each other's sessions.
      channel:
        typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(`weftdb-demo/${identity.scopeId}`),
    });
  }

  start(): () => void {
    this.#seed();
    return this.session.start();
  }

  /**
   * Gives a visitor a list to look at on their first visit, written through the same mutators the
   * page's own composer uses, so the rows sync and merge like anything typed in.
   *
   * The mark is what decides, not the row count: it lives in local storage beside the scope it
   * names, which every tab of one browser shares, so a second tab finds the list already seeded
   * and so does a reload. Deleting the rows leaves them deleted, and emptying the list is a state
   * the visitor asked for rather than one to fill back in. The whole of it is synchronous and runs
   * before the session opens, so a pull cannot land between the mark being read and the rows being
   * written.
   */
  #seed(): void {
    const storage = this.#seedStorage;
    if (storage === undefined) return;
    const key = `${SEED_MARK}/${this.identity.scopeId}`;
    if (storage.getItem(key) !== null) return;
    storage.setItem(key, "1");
    // A scope holding rows already has a list, whether they were typed here or hydrated from
    // storage this mark has outlived.
    if (this.rows().length > 0) return;
    for (const seed of SEED) {
      const id = newTodoId();
      this.todos.create(id, {
        title: seed.title,
        notes: seed.notes,
        done: seed.done,
        // Read per row, so each lands after the last and `SEED`'s order is the order shown.
        rank: this.nextRank(),
        due_at: null,
        auto_delete_days: null,
      });
      this.todoEvents.create(`event-${crypto.randomUUID()}`, {
        todo_id: id,
        kind: "added",
        actor: this.identity.label,
      });
    }
  }

  /** The list outside a render — for the handlers that need to know where a row sits. */
  rows(): readonly TodoView[] {
    return this.engine
      .getSnapshot(todosQuery("rank"), this.client.rows.values())
      .rows.map((row) => this.view(decodeTodos(row)));
  }

  /** Adds what only the client knows to a decoded row. */
  view(row: TodosRow): TodoView {
    return {
      ...row,
      dirty: this.client.isRowDirty(todosQuery().tableName, rowId(row.id)),
      conflicted: hasConflictMarkers(row.notes),
    };
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

  /** A rank that puts a new row at the end of the list. */
  nextRank(): string {
    return nextTodosRank(this.rows(), this.identity.deviceId);
  }

  moveUp(index: number): void {
    moveTodos(this.todos, this.rows(), index, "up", this.identity.deviceId);
  }

  moveDown(index: number): void {
    moveTodos(this.todos, this.rows(), index, "down", this.identity.deviceId);
  }

  discardQuarantine(): void {
    this.session.discardQuarantine();
  }

  async sync(): Promise<void> {
    await this.session.sync();
  }

  changed(): void {
    this.session.changed();
  }
}

export function newTodoId(): RowId {
  return rowId(`todo-${crypto.randomUUID()}`);
}
