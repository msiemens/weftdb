// The page. A shared todo list, one device per tab, talking to the relay over HTTP. Nothing
// here is scripted: open a second tab, take one offline, edit the same note line in both, and
// watch what the merge does when it comes back.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Diff3EditorBuffer } from "weftdb/client";
import { fieldName, hasConflictMarkers, rowId as toRowId, tableName } from "weftdb/core";
import { newTodoId, useTodoEventsQuery, useTodos, type StoreStatus, type TodoStore, type TodoView } from "./store.ts";

export function App({ store }: { readonly store: TodoStore }): ReactNode {
  useEffect(() => store.start(), [store]);
  // Straight from `weft generate`: a hook per collection, rows already decoded into the type
  // the schema describes. What the client knows and the schema does not — unsent work, a
  // conflicted merge — is added on top.
  const todos = useTodos(store.source, "rank").map((row) => store.view(row));
  const status = useStatus(store);

  return (
    <main>
      <Header store={store} status={status} />
      {status.quarantined > 0 ? (
        <Quarantine store={store} count={status.quarantined} reasons={status.quarantineReasons} />
      ) : null}
      {/* Composer, rows and empty state are one surface: it is a single list, and the styling
          reads it that way. */}
      <section className="list">
        <Composer store={store} />
        <ol className="todos">
          {todos.map((todo, index) => (
            <TodoItem key={todo.id} store={store} todo={todo} index={index} total={todos.length} />
          ))}
        </ol>
        {todos.length === 0 ? <p className="empty">Nothing on the list. Add something.</p> : null}
      </section>
      <Activity store={store} />
      <Guide />
    </main>
  );
}

function Header({ store, status }: { readonly store: TodoStore; readonly status: StoreStatus }): ReactNode {
  return (
    <header>
      <div className="title">
        {/* The span is the wordmark's one flourish — `db` in the accent. It leaves `textContent`
            as "weftdb", which is what a screen reader and the tests both read. */}
        <h1>
          weft<span>db</span>
        </h1>
        {/* The subtitle's job is to get a second tab open. Nothing on this page demonstrates
            anything until there are two of them. */}
        <p>Open this page in a second tab. Each tab is a separate device, and the list below syncs between them.</p>
      </div>
      <div className="badges">
        <span className="badge device">{store.identity.label}</span>
        <button
          type="button"
          className={status.online ? "badge toggle ok" : "badge toggle warn"}
          onClick={() => store.setOnline(!status.online)}
        >
          {status.online ? "online" : "offline"}
        </button>
        {/* Syncing is the state that turns over most often, several times a second while the
            list is being edited. It shares a chip with the connection rather than mounting one
            of its own, so the commonest change on the page cannot alter how many chips there
            are; `.connection` reserves the width of the longest of the three words, so it does
            not change the row's width either. */}
        <span
          className="badge connection"
          title={
            status.live
              ? "The relay tells this tab the moment anything changes."
              : "No wake-up socket, so this tab is asking every few seconds instead."
          }
        >
          {status.syncing ? "syncing…" : status.live ? "live" : "polling"}
        </span>
        <span className="badge">cursor {status.cursor}</span>
        {/* The rest are real state changes rather than per-sync churn, and they come last so
            appearing appends to the row instead of pushing what is already there along. */}
        {status.pending > 0 ? <span className="badge warn">{status.pending} unsent</span> : null}
        {status.lastError !== undefined ? (
          <span className="badge bad" title={status.lastError}>
            relay unreachable
          </span>
        ) : null}
      </div>
    </header>
  );
}

const WHY: Record<string, string> = {
  row_absent: "the row is no longer on the server — deleted and then purged.",
  row_exists: "the row was created again elsewhere, so this is a different row now.",
  merge_required: "the server moved on from the version this edit was written against.",
  rebase_exhausted: "the edit was rebased onto the server's version repeatedly and still did not fit.",
  append_class_violation: "the row is append-only and cannot be changed after it is written.",
  base_field_violation: "the edit touches a field that is fixed when a row is created.",
  clock_skew: "this device's clock is too far ahead of the server's.",
  scope_mismatch: "the edit belongs to a different scope than this session.",
};

function Quarantine({
  store,
  count,
  reasons,
}: {
  readonly store: TodoStore;
  readonly count: number;
  readonly reasons: readonly string[];
}): ReactNode {
  return (
    <section className="quarantine">
      <p>
        <strong>
          {count} change{count === 1 ? "" : "s"} could not be applied.
        </strong>{" "}
        They were set aside rather than dropped or forced through, and nothing is retried behind your back.
      </p>
      <ul className="reasons">
        {reasons.map((reason) => (
          <li key={reason}>
            <code>{reason}</code> — {WHY[reason] ?? "the server refused it."}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => store.discardQuarantine()}>
        Discard them and take the server's version
      </button>
    </section>
  );
}

function Composer({ store }: { readonly store: TodoStore }): ReactNode {
  const [title, setTitle] = useState("");
  const add = (): void => {
    const trimmed = title.trim();
    if (trimmed === "") return;
    const id = newTodoId();
    store.todos.create(id, {
      title: trimmed,
      notes: "",
      done: false,
      rank: store.nextRank(),
      due_at: null,
      auto_delete_days: null,
    });
    store.todoEvents.create(`event-${crypto.randomUUID()}`, {
      todo_id: id,
      kind: "added",
      actor: store.identity.label,
    });
    setTitle("");
  };

  return (
    <div className="composer">
      <input
        value={title}
        placeholder="Add something to the list"
        aria-label="New todo"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
      />
      <button type="button" className="primary" onClick={add}>
        Add
      </button>
    </div>
  );
}

function TodoItem({
  store,
  todo,
  index,
  total,
}: {
  readonly store: TodoStore;
  readonly todo: TodoView;
  readonly index: number;
  readonly total: number;
}): ReactNode {
  const [notesOpen, setNotesOpen] = useState(false);
  // A conflict arriving from another tab opens the notes whether or not you asked, because a
  // merge you cannot see is one you cannot resolve.
  const showNotes = notesOpen || todo.conflicted;

  return (
    <li className={todo.done ? "todo done" : "todo"}>
      <div className="line">
        <button
          type="button"
          className={todo.done ? "check on" : "check"}
          aria-label={todo.done ? `Mark ${todo.title} not done` : `Mark ${todo.title} done`}
          onClick={() => {
            store.todos.update(todo.id, { done: !todo.done });
            // Event-log ids are minted per write: two tabs ticking the same row at the same
            // moment are two entries in history, not one write racing another.
            store.todoEvents.create(`event-${crypto.randomUUID()}`, {
              todo_id: todo.id,
              kind: todo.done ? "reopened" : "completed",
              actor: store.identity.label,
            });
          }}
        >
          {todo.done ? "✓" : ""}
        </button>
        <TitleField store={store} todo={todo} />
        <div className="row-actions">
          {todo.dirty ? <span className="badge warn small">unsent</span> : null}
          <button
            type="button"
            aria-label={`Move ${todo.title} up`}
            disabled={index === 0}
            onClick={() => store.moveUp(index)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${todo.title} down`}
            disabled={index === total - 1}
            onClick={() => store.moveDown(index)}
          >
            ↓
          </button>
          <button
            type="button"
            className={showNotes ? "notes-toggle open" : "notes-toggle"}
            aria-label={`Notes for ${todo.title}`}
            onClick={() => setNotesOpen(!notesOpen)}
          >
            notes
          </button>
          <button
            type="button"
            className="danger"
            aria-label={`Delete ${todo.title}`}
            onClick={() => store.todos.delete(todo.id)}
          >
            ×
          </button>
        </div>
      </div>
      {showNotes ? <Notes store={store} todo={todo} /> : null}
    </li>
  );
}

function TitleField({ store, todo }: { readonly store: TodoStore; readonly todo: TodoView }): ReactNode {
  const field = useBufferedField(todo.id, "title", todo.title, (title) => store.todos.update(todo.id, { title }));
  return (
    <input
      className="todo-title"
      value={field.value}
      aria-label={`Title of ${todo.title}`}
      onChange={(event) => field.onChange(event.target.value)}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
    />
  );
}

function Notes({ store, todo }: { readonly store: TodoStore; readonly todo: TodoView }): ReactNode {
  const field = useBufferedField(todo.id, "notes", todo.notes, (notes) => store.todos.update(todo.id, { notes }));
  return (
    <div className={todo.conflicted ? "notes conflicted" : "notes"}>
      <textarea
        value={field.value}
        rows={Math.max(3, field.value.split("\n").length)}
        placeholder="Notes merge line by line, so two tabs can write here at once."
        aria-label={`Notes for ${todo.title}`}
        onChange={(event) => field.onChange(event.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
      {hasConflictMarkers(todo.notes) ? (
        <p className="hint bad">
          Two tabs edited the same line. Both versions are kept verbatim — edit the markers away to resolve it; there is
          no conflict record left behind afterwards.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The last few things anyone did, newest first.
 *
 * A compiled statement rather than the whole collection sliced afterwards: `useTodoEventsQuery`
 * takes the ordering, the direction and the bound down to SQLite in the storage worker, so what
 * crosses the port is the eight rows this list renders instead of every event the scope has ever
 * recorded. The `where` names the kinds this panel is about, which is what the buttons below write.
 */
function Activity({ store }: { readonly store: TodoStore }): ReactNode {
  const entries = useTodoEventsQuery(store.source, (statement) =>
    statement.where("kind", "in", ACTIVITY_KINDS).orderBy("created", "desc").limit(ACTIVITY_ROWS),
  );
  if (entries.length === 0) return null;

  return (
    <section className="activity">
      <h2>Activity</h2>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="who">{entry.actor}</span>
            <span className="what">{entry.kind}</span>
          </li>
        ))}
      </ul>
      <p className="hint">
        Append-only rows: written once, never edited, so two tabs writing history at the same moment always agree on it
        without anything to merge.
      </p>
    </section>
  );
}

/**
 * The guide is a modal rather than a panel: it is read once, at the start, and then it is in the
 * way of the thing it is describing. `<dialog>` is used natively for it, which is where Escape,
 * the focus trap and the inert backdrop come from — none of that is worth reimplementing.
 */
function Guide(): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);

  /**
   * `close()` takes the dialog out of the top layer immediately, so it has to be held open for
   * as long as the stylesheet's closing animation. The marker is set with `setAttribute` rather
   * than through React state: a class React owns would be reconciled away by the next store
   * update, which lands often here, and the dialog would blink out mid-animation. The close
   * itself runs off a timer rather than `animationend`, because an animation that never fires
   * must not leave a modal stuck open over the page.
   */
  const close = (): void => {
    const element = dialog.current;
    if (element === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.close();
      return;
    }
    element.setAttribute("data-closing", "");
    setTimeout(() => {
      element.removeAttribute("data-closing");
      element.close();
    }, GUIDE_CLOSE_MS);
  };

  return (
    <>
      <footer className="guide-open">
        <button type="button" onClick={() => dialog.current?.showModal()}>
          Things worth trying
        </button>
      </footer>
      {/* A sibling of the trigger, not a child of it: nesting the dialog inside the trigger's
          wrapper let `.guide-open button` reach the dialog's own button and repaint it. */}
      <dialog
        className="guide"
        ref={dialog}
        // Escape closes a dialog outright, which would skip the animation, so it is taken over.
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        // A click on the backdrop is dispatched to the dialog itself, so "outside" has to be
        // measured rather than assumed — the dialog's own padding is inside its box too.
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const box = event.currentTarget.getBoundingClientRect();
          const outside =
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom;
          if (outside) close();
        }}
      >
        <GuideBody onClose={close} />
      </dialog>
    </>
  );
}

function GuideBody({ onClose }: { readonly onClose: () => void }): ReactNode {
  return (
    <>
      <h2>Things worth trying</h2>
      <ul>
        <li>
          <strong>Open a second tab.</strong> It is a second device with its own outbox. Add something in one and it
          appears in the other within a poll.
        </li>
        <li>
          <strong>Go offline in one tab.</strong> Keep editing — the list stays live and the unsent count climbs. Come
          back online and it drains.
        </li>
        <li>
          <strong>Edit different fields.</strong> Offline in both: rename in one, tick done in the other. Both survive,
          because merging is per field.
        </li>
        <li>
          <strong>Edit different note lines.</strong> Same row, different lines — diff3 merges the prose without asking
          anyone.
        </li>
        <li>
          <strong>Edit the same note line.</strong> Both versions come back behind markers. Resolving is just another
          edit.
        </li>
        <li>
          <strong>Delete under an unsent edit.</strong> Edit a row offline while the other tab deletes it. Your edit is
          quarantined, not silently dropped.
        </li>
        <li>
          <strong>Reload.</strong> Local storage is the state, not a cache: unsent work is still there afterwards.
        </li>
      </ul>
      <button type="button" className="primary" onClick={onClose}>
        Close
      </button>
    </>
  );
}

/** How long the guide's closing animation runs for, in step with the stylesheet. */
const GUIDE_CLOSE_MS = 130;
/** What the activity panel shows, and how much of it. Both are bound parameters of one statement. */
const ACTIVITY_KINDS = ["added", "completed", "reopened"];
const ACTIVITY_ROWS = 8;
/** How long a field waits after the last keystroke before it becomes a transaction. */
const COMMIT_IDLE_MS = 600;
const TODOS = tableName("todos");

/**
 * A text field that behaves the way a text field has to in a syncing app. Typing is local
 * until you pause, so a word is one transaction rather than six; and a value arriving from
 * another tab while you are typing is held by `Diff3EditorBuffer` until you leave the field,
 * so nothing rewrites the text under your caret mid-word.
 */
function useBufferedField(
  id: string,
  field: string,
  value: string,
  commit: (next: string) => void,
): {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
} {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const buffer = useRef(new Diff3EditorBuffer());
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    for (const edit of buffer.current.receiveRemote({
      tableName: TODOS,
      rowId: toRowId(id),
      fieldName: fieldName(field),
      value,
    })) {
      committed.current = edit.value;
      setDraft(edit.value);
    }
  }, [value, id, field]);

  useEffect(
    () => () => {
      if (idle.current !== undefined) clearTimeout(idle.current);
    },
    [],
  );

  const send = (next: string): void => {
    if (idle.current !== undefined) clearTimeout(idle.current);
    if (next === committed.current) return;
    committed.current = next;
    commit(next);
  };

  return {
    value: draft,
    onChange: (next) => {
      setDraft(next);
      if (idle.current !== undefined) clearTimeout(idle.current);
      idle.current = setTimeout(() => send(next), COMMIT_IDLE_MS);
    },
    onFocus: () => buffer.current.focus(),
    onBlur: () => {
      const edited = draft !== committed.current;
      send(draft);
      const held = buffer.current.blur();
      // Nothing of your own to keep, so whatever arrived while you were here applies now.
      const last = held.at(-1);
      if (!edited && last !== undefined) {
        committed.current = last.value;
        setDraft(last.value);
      }
    },
  };
}

function useStatus(store: TodoStore): StoreStatus {
  return useSyncExternalStore(
    (listener) => store.subscribeStatus(listener),
    () => store.status(),
  );
}
