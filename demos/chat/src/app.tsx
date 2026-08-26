// The page. A chat room, one device per tab, with the relay pushing over a WebSocket. Two
// things are on show: the message log is append-class, so a message is written once and is
// immutable from the next transaction on, and the socket means a message typed in one tab lands
// in another without either of them asking for it.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  useDevicesQuery,
  useMessages,
  type ChatStore,
  type DeviceView,
  type MessageView,
  type StoreStatus,
} from "./store.ts";

export function App({ store }: { readonly store: ChatStore }): ReactNode {
  useEffect(() => store.start(), [store]);
  // Straight from `weft generate`: a hook per collection, rows already decoded into the type the
  // schema describes. `created` is stamped when the row is written and never changes, so it is
  // the log's order as well as its timestamp.
  const messages = useMessages(store.source, "created").map((row) => store.view(row));
  // A compiled statement rather than the collection sorted afterwards: the strip's order is a
  // total one over the device id, and SQLite in the storage worker is where that ordering belongs.
  // The `where` is the guard the sort could not be: a device row whose label has not arrived yet —
  // a create still crossing, or a partial pull — would otherwise render as a nameless chip.
  const devices = store.presence(
    useDevicesQuery(store.source, (statement) => statement.where("label", "!=", "").orderBy("id")),
  );
  const status = useStatus(store);

  return (
    <main>
      <Header store={store} status={status} />
      {status.quarantined > 0 ? (
        <Quarantine store={store} count={status.quarantined} reasons={status.quarantineReasons} />
      ) : null}
      <Presence devices={devices} />
      {/* Log and composer are one surface: it is a single conversation, and the styling reads it
          that way. */}
      <section className="room">
        <Log messages={messages} />
        <Composer store={store} />
      </section>
      <Guide />
    </main>
  );
}

function Header({ store, status }: { readonly store: ChatStore; readonly status: StoreStatus }): ReactNode {
  return (
    <header>
      <div className="title">
        {/* The span is the wordmark's one flourish — `db` in the accent. It leaves `textContent`
            as "weftdb", which is what a screen reader and the tests both read. */}
        <h1>
          weft<span>db</span>
        </h1>
        <p>
          Open this page in a second tab. Each tab is a separate device in the same room, and a message posted in one
          arrives in the other over the sync socket.
        </p>
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
        {/* Syncing turns over several times a second while messages are landing, so it shares a
            chip with the connection rather than mounting one of its own; `.connection` reserves
            the width of the longest of the three words, so the row's width does not move
            either. */}
        <span
          className="badge connection"
          title={
            status.live
              ? "The relay tells this tab the moment anything changes."
              : "No sync socket, so this tab is asking every few seconds instead."
          }
        >
          {status.syncing ? "syncing…" : status.live ? "live" : "polling"}
        </span>
        <span className="badge">cursor {status.cursor}</span>
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
  row_absent: "the row is no longer on the server: deleted and then purged.",
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
  readonly store: ChatStore;
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
            <code>{reason}</code>: {WHY[reason] ?? "the server refused it."}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => store.discardQuarantine()}>
        Discard them and take the server's version
      </button>
    </section>
  );
}

/**
 * Who else is in the room. Each tab rewrites one device row every few seconds; a row whose last
 * heartbeat is older than the window reads as gone. That is the mutable half of the schema, and
 * it is the opposite of the log below it: a device record is a current value, and only its
 * newest writer is interesting.
 */
function Presence({ devices }: { readonly devices: readonly DeviceView[] }): ReactNode {
  if (devices.length === 0) return null;

  return (
    <section className="presence">
      <h2>Devices</h2>
      <ul>
        {devices.map((device) => (
          <li key={device.id} className={device.here ? "badge here" : "badge gone"}>
            {device.label}
            {device.self ? " (this tab)" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Log({ messages }: { readonly messages: readonly MessageView[] }): ReactNode {
  const log = useRef<HTMLOListElement>(null);

  // A message arriving from another tab is only useful if it is on screen, and the newest one
  // sits at the bottom. Scrolling the log rather than the page leaves the composer where it is.
  useEffect(() => {
    const element = log.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  return (
    <ol className="log" ref={log}>
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      {messages.length === 0 ? (
        <li className="empty">No messages yet. Say something, then open a second tab.</li>
      ) : null}
    </ol>
  );
}

function Message({ message }: { readonly message: MessageView }): ReactNode {
  return (
    <li className={message.mine ? "message mine" : "message"}>
      <div className="meta">
        <span className="who">{message.author}</span>
        <time dateTime={message.created}>{clockTime(message.created)}</time>
        {message.dirty ? <span className="badge warn small">unsent</span> : null}
      </div>
      <p className="body">{message.body}</p>
    </li>
  );
}

function Composer({ store }: { readonly store: ChatStore }): ReactNode {
  const [body, setBody] = useState("");
  const send = (): void => {
    if (body.trim() === "") return;
    void store.send(body);
    setBody("");
  };

  return (
    <div className="composer">
      <input
        value={body}
        placeholder="Message this room"
        aria-label="Message"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") send();
        }}
      />
      <button type="button" className="primary" onClick={send}>
        Send
      </button>
    </div>
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
          wrapper lets `.guide-open button` reach the dialog's own button and repaint it. */}
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
          <strong>Open a second tab.</strong> It is a second device with its own outbox. Post in one and it appears in
          the other as soon as the relay pushes, with no poll in between.
        </li>
        <li>
          <strong>Watch the devices strip.</strong> Close a tab and its chip goes quiet within 15 seconds, because its
          heartbeat stops arriving.
        </li>
        <li>
          <strong>Go offline in one tab.</strong> Keep posting. The messages land in the outbox and the unsent count
          climbs; come back online and they drain in order.
        </li>
        <li>
          <strong>Post from both tabs while both are offline.</strong> Every message survives. Append-class rows are
          written once, so two devices writing at the same moment produce two rows rather than one overwriting the
          other.
        </li>
        <li>
          <strong>Reload.</strong> Local storage is the state, not a cache: unsent messages are still there afterwards.
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

/** `HH:MM` in the reader's own zone, from the ISO string the row was stamped with. */
function clockTime(created: string): string {
  const at = new Date(created);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function useStatus(store: ChatStore): StoreStatus {
  return useSyncExternalStore(
    (listener) => store.subscribeStatus(listener),
    () => store.status(),
  );
}
