// What is left of an application's data layer once the library and codegen have taken their
// halves. Rows, decoding, mutators, hooks and reordering come from `src/generated`, which
// `weft generate` writes from the schema; the database, the worker that holds it and the sync
// session all come from `openWeftDatabase`. What is genuinely this application's is here: which
// scope this visitor is on, what a row looks like once the client's own knowledge is added to it,
// and the list a first visit arrives at.
import { deviceId as toDeviceId, hasConflictMarkers, rowId, type DeviceId, type RowId } from "weftdb/core";
import type { SessionStatus, StorageLike, WeftClientMirror } from "weftdb/client";
import {
  openDemoDatabase,
  seedScopeOnce,
  DemoSync,
  type DemoDatabase,
  type DemoOpenOverrides,
} from "weftdb-demo-shared/open";
import { tabIdentity, type TabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "./schema.ts";
import { DEMO } from "./scope.ts";
import relayWorkerUrl from "./relay-worker.ts?sharedworker&url";
import storageWorkerUrl from "./storage-worker.ts?sharedworker&url";
import {
  decodeTodos,
  moveTodos,
  nextTodosRank,
  todoEventsMutators,
  todosMutators,
  todosQuery,
  todosTable,
  type TodoEventsMutators,
  type TodosMutators,
  type TodosRow,
} from "./generated/bindings.ts";

export { todoEventsQuery, todosQuery, useTodoEvents, useTodoEventsQuery, useTodos } from "./generated/bindings.ts";
export type { TodoEventsRow, TodosRow } from "./generated/bindings.ts";

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
  readonly database: DemoDatabase;
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
  readonly todos: TodosMutators;
  readonly todoEvents: TodoEventsMutators;
  /** The status pills, the online toggle, and the two verbs the header's buttons call. */
  readonly connection: DemoSync;
  readonly #seedStorage: StorageLike | undefined;
  #seeding: Promise<void> = Promise.resolve();

  constructor(options: TodoStoreOptions) {
    this.identity = options.identity;
    this.database = options.database;
    this.source = options.database.weft.source;
    this.deviceId = toDeviceId(this.source.deviceId);
    this.connection = new DemoSync(options.database);
    this.#seedStorage = options.seedStorage;
    // No `notify` callback: the worker's echo wakes the subscriptions when the change arrives, and
    // a callback fired when the mutator returned would wake them before there was anything new.
    this.todos = todosMutators(this.source);
    this.todoEvents = todoEventsMutators(this.source);
  }

  /**
   * Opens this tab's database.
   *
   * The scope comes from local storage, so every tab of this browser opens the same list while
   * another visitor opens their own. The namespace comes from session storage, so **each tab is a
   * database of its own** — its own client in the storage worker, its own file and its own device
   * id — which is what makes a second tab a second device rather than a second view.
   */
  static async open(window: WindowLike, overrides?: DemoOpenOverrides): Promise<TodoStore> {
    const identity = tabIdentity(window.sessionStorage, window.localStorage, { demo: DEMO });
    const database = await openDemoDatabase({
      schema,
      scopeId: identity.scopeId,
      namespace: `weftdb-demo/${DEMO}/${identity.deviceId}`,
      worker: storageWorkerUrl,
      relayWorker: relayWorkerUrl,
      ...(overrides === undefined ? {} : { overrides }),
    });
    return new TodoStore({ identity, database, seedStorage: window.localStorage });
  }

  start(): () => void {
    this.#seeding = this.#seed();
    void this.#seeding;
    return () => undefined;
  }

  /**
   * Settles once this tab has decided whether its scope needed seeding, and written the rows if it
   * did. For a test to await: the decision waits on a sync, so a list read before it has settled is
   * a list read before there is one.
   */
  seeded(): Promise<void> {
    return this.#seeding;
  }

  async #seed(): Promise<void> {
    const storage = this.#seedStorage;
    if (storage === undefined) return;
    await seedScopeOnce({
      storage,
      key: `${SEED_MARK}/${this.identity.scopeId}`,
      database: this.database,
      count: () => this.rows().length,
      write: () => this.#writeSeed(),
    });
  }

  /**
   * Writes the list a visitor arrives to, through the same mutators the page's own composer uses,
   * so the rows sync and merge like anything typed in.
   *
   * Each write is awaited, so the next row's rank is taken from a list that already holds the one
   * before it.
   */
  async #writeSeed(): Promise<void> {
    for (const seed of SEED) {
      const id = newTodoId();
      await this.todos.create(id, {
        title: seed.title,
        notes: seed.notes,
        done: seed.done,
        rank: this.nextRank(),
        due_at: null,
        auto_delete_days: null,
      });
      await this.todoEvents.create(`event-${crypto.randomUUID()}`, {
        todo_id: id,
        kind: "added",
        actor: this.identity.label,
      });
    }
  }

  /** The list outside a render — for the handlers that need to know where a row sits. */
  rows(): readonly TodoView[] {
    return this.source.engine
      .getSnapshot(todosQuery("rank"), this.source.rows.values())
      .rows.map((row) => this.view(decodeTodos(row)));
  }

  /** Adds what only the client knows to a decoded row. */
  view(row: TodosRow): TodoView {
    return {
      ...row,
      dirty: this.source.isRowDirty(todosTable, rowId(row.id)),
      conflicted: hasConflictMarkers(row.notes),
    };
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

  /** A rank that puts a new row at the end of the list. */
  nextRank(): string {
    return nextTodosRank(this.rows(), this.deviceId);
  }

  async moveUp(index: number): Promise<void> {
    await moveTodos(this.todos, this.rows(), index, "up", this.deviceId);
  }

  async moveDown(index: number): Promise<void> {
    await moveTodos(this.todos, this.rows(), index, "down", this.deviceId);
  }

  async discardQuarantine(): Promise<void> {
    await this.connection.discardQuarantine();
  }

  async sync(): Promise<void> {
    await this.connection.sync();
  }

  async dispose(): Promise<void> {
    await this.database.dispose();
  }
}

export function newTodoId(): RowId {
  return rowId(`todo-${crypto.randomUUID()}`);
}
