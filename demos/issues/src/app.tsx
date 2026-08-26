// The page. An issue tracker with three collections and three relationships between them, one
// device per tab, talking to the relay over HTTP. The list joins each issue to its project and
// counts its comments; the detail view below reads a comment's author out of the nested shape
// the generated mapper produces. Nothing here is scripted: open a second tab, take one offline,
// and edit the same issue body in both.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { Diff3EditorBuffer } from "weftdb/client";
import { fieldName, hasConflictMarkers, rowId as toRowId, tableName, type TableName } from "weftdb/core";
import {
  issues_commentsRelation,
  issues_projectRelation,
  newCommentId,
  newIssueId,
  newProjectId,
  nextStatus,
  projects_issuesRelation,
  useComments,
  useIssues,
  useProjects,
  type CommentView,
  type IssueStore,
  type IssueView,
  type ProjectView,
  type StoreStatus,
} from "./store.ts";

/**
 * Every join the page makes, built once per render from the rows the hooks return.
 *
 * Each accessor comes from `weft generate`: it indexes the rows it is given and hands back a
 * lookup, so the rail's counts and the list's project tags are a lookup per row rather than a
 * scan per row. The generated signatures carry the target row type through, which is why
 * `issuesOfProject` yields `IssueView` and not the bare `IssuesRow` the schema describes.
 */
function joinsOver(
  projects: readonly ProjectView[],
  issues: readonly IssueView[],
  comments: readonly CommentView[],
): {
  /** `issues.project`, a `hasOne`. */
  readonly projectOfIssue: (issue: IssueView) => ProjectView | undefined;
  /** `issues.comments`, a `hasMany`. */
  readonly commentsOfIssue: (issue: IssueView) => readonly CommentView[];
  /** `projects.issues`, a `hasMany`. */
  readonly issuesOfProject: (project: ProjectView) => readonly IssueView[];
} {
  return {
    projectOfIssue: issues_projectRelation(projects),
    commentsOfIssue: issues_commentsRelation(comments),
    issuesOfProject: projects_issuesRelation(issues),
  };
}

type Joins = ReturnType<typeof joinsOver>;

export function App({ store }: { readonly store: IssueStore }): ReactNode {
  useEffect(() => store.start(), [store]);
  // Straight from `weft generate`: a hook per collection, rows already decoded into the type the
  // schema describes. What the client knows and the schema does not — unsent work, a conflicted
  // merge, a comment's nested author — is added on top.
  const projects = useProjects(store.source, "rank").map((row) => store.projectView(row));
  const issues = useIssues(store.source, "rank").map((row) => store.issueView(row));
  const comments = useComments(store.source, "rank").map((row) => store.commentView(row));
  const status = useStatus(store);

  // The accessors carry both sides of each join, so nothing below names a foreign key.
  const joins = joinsOver(projects, issues, comments);

  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [openIssue, setOpenIssue] = useState<string | undefined>(undefined);
  // A project or an issue can be deleted from another tab while it is on screen here, so both
  // selections are checked against the rows that actually arrived rather than trusted.
  const project = projects.find((row) => row.id === filter);
  const shown = project === undefined ? issues : joins.issuesOfProject(project);
  const issue = shown.find((row) => row.id === openIssue);

  return (
    <main>
      <Header store={store} status={status} />
      {status.quarantined > 0 ? (
        <Quarantine store={store} count={status.quarantined} reasons={status.quarantineReasons} />
      ) : null}
      <div className="board">
        <Rail store={store} projects={projects} joins={joins} selected={project?.id} onSelect={setFilter} />
        <section className="list">
          <IssueComposer store={store} projects={projects} selected={project?.id} />
          <ol className="issues">
            {shown.map((row, index) => (
              <IssueRow
                key={row.id}
                store={store}
                issue={row}
                joins={joins}
                index={index}
                total={shown.length}
                project={project?.id}
                open={row.id === openIssue}
                onOpen={() => setOpenIssue(row.id === openIssue ? undefined : row.id)}
              />
            ))}
          </ol>
          {shown.length === 0 ? (
            <p className="empty">
              {projects.length === 0
                ? "No projects yet. Add one on the left, then file an issue against it."
                : "No issues here. File one above."}
            </p>
          ) : null}
        </section>
      </div>
      {issue === undefined ? null : (
        <Detail store={store} issue={issue} joins={joins} onClose={() => setOpenIssue(undefined)} />
      )}
      <Guide />
    </main>
  );
}

function Header({ store, status }: { readonly store: IssueStore; readonly status: StoreStatus }): ReactNode {
  return (
    <header>
      <div className="title">
        {/* The span is the wordmark's one flourish — `db` in the accent. It leaves `textContent`
            as "weftdb", which is what a screen reader and the tests both read. */}
        <h1>
          weft<span>db</span>
        </h1>
        <p>
          Projects hold issues, issues hold comments. Open this page in a second tab: each tab is a separate device, and
          everything below syncs between them.
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
        {/* Syncing shares a chip with the connection rather than mounting one of its own, so the
            commonest change on the page cannot alter how many chips there are; `.connection`
            reserves the width of the longest of the three words. */}
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
  readonly store: IssueStore;
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

/** The projects rail. Each entry carries the count its `hasMany` resolves to. */
function Rail({
  store,
  projects,
  joins,
  selected,
  onSelect,
}: {
  readonly store: IssueStore;
  readonly projects: readonly ProjectView[];
  readonly joins: Joins;
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
}): ReactNode {
  const [name, setName] = useState("");
  const add = (): void => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    store.projects.create(newProjectId(), { name: trimmed, rank: store.nextProjectRank() });
    setName("");
  };

  return (
    <aside className="rail">
      <h2>Projects</h2>
      <ul className="projects">
        <li>
          <button
            type="button"
            className={selected === undefined ? "project on" : "project"}
            onClick={() => onSelect(undefined)}
          >
            <span className="project-name">All projects</span>
          </button>
        </li>
        {projects.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className={project.id === selected ? "project on" : "project"}
              onClick={() => onSelect(project.id)}
            >
              <span className="project-name">{project.name}</span>
              <span className="count">{joins.issuesOfProject(project).length}</span>
            </button>
            <button
              type="button"
              className="danger"
              aria-label={`Delete project ${project.name}`}
              onClick={() => {
                if (project.id === selected) onSelect(undefined);
                store.projects.delete(project.id);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="composer">
        <input
          value={name}
          placeholder="New project"
          aria-label="New project"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
        />
        <button type="button" className="primary" onClick={add}>
          Add
        </button>
      </div>
    </aside>
  );
}

function IssueComposer({
  store,
  projects,
  selected,
}: {
  readonly store: IssueStore;
  readonly projects: readonly ProjectView[];
  readonly selected: string | undefined;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState<string | undefined>(undefined);
  // The rail's filter is the default target, so filing against the project you are looking at
  // takes no second choice. The select still overrides it.
  const projectId = projects.find((row) => row.id === (target ?? selected))?.id ?? projects[0]?.id;
  const add = (): void => {
    const trimmed = title.trim();
    if (trimmed === "" || projectId === undefined) return;
    store.issues.create(newIssueId(), {
      project_id: projectId,
      title: trimmed,
      body: "",
      status: "open",
      rank: store.nextIssueRank(),
    });
    setTitle("");
  };

  return (
    <div className="composer">
      <input
        value={title}
        placeholder={projects.length === 0 ? "Add a project first" : "File an issue"}
        aria-label="New issue"
        disabled={projects.length === 0}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
      />
      <select
        aria-label="Project for the new issue"
        value={projectId ?? ""}
        disabled={projects.length === 0}
        onChange={(event) => setTarget(event.target.value)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <button type="button" className="primary" disabled={projects.length === 0} onClick={add}>
        Add
      </button>
    </div>
  );
}

function IssueRow({
  store,
  issue,
  joins,
  index,
  total,
  project,
  open,
  onOpen,
}: {
  readonly store: IssueStore;
  readonly issue: IssueView;
  readonly joins: Joins;
  readonly index: number;
  readonly total: number;
  readonly project: string | undefined;
  readonly open: boolean;
  readonly onOpen: () => void;
}): ReactNode {
  // The `hasOne` back to the project, and the `hasMany` forward to the comments. A row can point
  // at a project this device has not synced yet, which is why the name has a fallback.
  const owner = joins.projectOfIssue(issue);
  const count = joins.commentsOfIssue(issue).length;

  return (
    <li className={open ? "issue open" : "issue"}>
      <div className="line">
        <button
          type="button"
          className={`status ${issue.status}`}
          aria-label={`Status of ${issue.title} is ${issue.status}`}
          onClick={() => store.issues.update(issue.id, { status: nextStatus(issue.status) })}
        >
          {issue.status}
        </button>
        <TitleField store={store} issue={issue} />
        <span className="meta">
          <span className="project-tag">{owner?.name ?? "unknown project"}</span>
          <span className="comment-count" title={`${count} comment${count === 1 ? "" : "s"}`}>
            {count} ▸
          </span>
        </span>
        <div className="row-actions">
          {/* One chip, never two. A row that is both conflicted and unsent has one thing worth
              acting on, and a second chip beside it widens the row without adding to that. */}
          {issue.conflicted ? (
            <span className="badge bad small">conflict</span>
          ) : issue.dirty ? (
            <span className="badge warn small">unsent</span>
          ) : null}
          <button
            type="button"
            aria-label={`Move ${issue.title} up`}
            disabled={index === 0}
            onClick={() => store.moveIssue(project, index, "up")}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${issue.title} down`}
            disabled={index === total - 1}
            onClick={() => store.moveIssue(project, index, "down")}
          >
            ↓
          </button>
          <button
            type="button"
            className={open ? "notes-toggle open" : "notes-toggle"}
            aria-label={`Open ${issue.title}`}
            onClick={onOpen}
          >
            open
          </button>
          <button
            type="button"
            className="danger"
            aria-label={`Delete ${issue.title}`}
            onClick={() => store.issues.delete(issue.id)}
          >
            ×
          </button>
        </div>
      </div>
    </li>
  );
}

function TitleField({ store, issue }: { readonly store: IssueStore; readonly issue: IssueView }): ReactNode {
  const field = useBufferedField(ISSUES, issue.id, "title", issue.title, (title) =>
    store.issues.update(issue.id, { title }),
  );
  return (
    <input
      className="issue-title"
      value={field.value}
      aria-label={`Title of ${issue.title}`}
      onChange={(event) => field.onChange(event.target.value)}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
    />
  );
}

/**
 * One issue, its project, its body, and the comments its `hasMany` resolves to, as a modal over
 * the list. The list stays where it was: a modal `<dialog>` sits in the top layer and scrolls
 * nothing behind it, so closing puts the reader back on the row they came from.
 */
function Detail({
  store,
  issue,
  joins,
  onClose,
}: {
  readonly store: IssueStore;
  readonly issue: IssueView;
  readonly joins: Joins;
  readonly onClose: () => void;
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const modal = useModal(dialog, onClose);
  const heading = useId();
  const owner = joins.projectOfIssue(issue);
  const thread = joins.commentsOfIssue(issue);

  // It exists only while it is open: the row's control is what decides that, so it opens on mount.
  const { open } = modal;
  useEffect(() => open(), [open]);

  return (
    <dialog
      className="modal detail"
      ref={dialog}
      aria-labelledby={heading}
      onCancel={modal.onCancel}
      onClick={modal.onClick}
    >
      <h2 id={heading}>
        {issue.title}
        <span className="in-project">in {owner?.name ?? "unknown project"}</span>
      </h2>
      <Body store={store} issue={issue} />
      <ol className="comments">
        {thread.map((comment) => (
          <Comment key={comment.id} comment={comment} />
        ))}
      </ol>
      {thread.length === 0 ? <p className="hint">No comments on this issue yet.</p> : null}
      <CommentComposer store={store} issue={issue} />
      <button type="button" className="primary modal-close" onClick={modal.close}>
        Close
      </button>
    </dialog>
  );
}

function Body({ store, issue }: { readonly store: IssueStore; readonly issue: IssueView }): ReactNode {
  const field = useBufferedField(ISSUES, issue.id, "body", issue.body, (body) =>
    store.issues.update(issue.id, { body }),
  );
  return (
    <div className={issue.conflicted ? "body conflicted" : "body"}>
      <textarea
        value={field.value}
        rows={Math.max(3, field.value.split("\n").length)}
        placeholder="The issue body merges line by line, so two tabs can write here at once."
        aria-label={`Body of ${issue.title}`}
        onChange={(event) => field.onChange(event.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
      {hasConflictMarkers(issue.body) ? (
        <p className="hint bad">
          Two tabs edited the same line. Both versions are kept verbatim — edit the markers away to resolve it; there is
          no conflict record left behind afterwards.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A comment. `comment.author` does not exist in the field store: the columns there are
 * `author__label` and `author__device`, and the generated nested mapper folds them into an
 * object on the way out.
 *
 * There is nothing to edit here. `comments` is an event log, so the row is append-class from the
 * transaction that wrote it: the generated mutators carry `create` alone, and the server refuses
 * a later `set` or `delete` whatever a client sends.
 */
function Comment({ comment }: { readonly comment: CommentView }): ReactNode {
  return (
    <li className="comment">
      <div className="byline">
        <span className="who">{comment.author.label}</span>
        <span className="device">{comment.author.device}</span>
        {comment.dirty ? <span className="badge warn small">unsent</span> : null}
      </div>
      <p className="comment-body">{comment.body}</p>
    </li>
  );
}

function CommentComposer({ store, issue }: { readonly store: IssueStore; readonly issue: IssueView }): ReactNode {
  const [body, setBody] = useState("");
  const add = (): void => {
    const trimmed = body.trim();
    if (trimmed === "") return;
    // The author is written flat, one column per nested leaf. The mapper reverses it on read.
    store.comments.create(newCommentId(), {
      issue_id: issue.id,
      body: trimmed,
      rank: store.nextCommentRank(issue.id),
      author__label: store.identity.label,
      author__device: store.identity.deviceId,
    });
    setBody("");
  };

  return (
    <div className="composer">
      <input
        value={body}
        placeholder="Add a comment"
        aria-label="New comment"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
      />
      <button type="button" className="primary" onClick={add}>
        Comment
      </button>
    </div>
  );
}

/**
 * The guide is a modal rather than a panel: it is read once, at the start, and then it is in the
 * way of the thing it is describing.
 */
function Guide(): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const modal = useModal(dialog);
  const heading = useId();

  return (
    <>
      <footer className="guide-open">
        <button type="button" onClick={modal.open}>
          Things worth trying
        </button>
      </footer>
      {/* A sibling of the trigger, not a child of it: nesting the dialog inside the trigger's
          wrapper let `.guide-open button` reach the dialog's own button and repaint it. */}
      <dialog
        className="modal guide"
        ref={dialog}
        aria-labelledby={heading}
        onCancel={modal.onCancel}
        onClick={modal.onClick}
      >
        <h2 id={heading}>Things worth trying</h2>
        <GuideBody onClose={modal.close} />
      </dialog>
    </>
  );
}

function GuideBody({ onClose }: { readonly onClose: () => void }): ReactNode {
  return (
    <>
      <ul>
        <li>
          <strong>Open a second tab.</strong> It is a second device with its own outbox. File an issue in one and it
          appears in the other within a poll.
        </li>
        <li>
          <strong>Watch the joins move.</strong> Comment in one tab and the count on the issue row in the other tab
          follows, because the count is resolved from rows rather than stored on the issue.
        </li>
        <li>
          <strong>Delete a project with issues in it.</strong> The issues stay, and their project name falls back to{" "}
          <code>unknown project</code>. Nothing cascades: a row that points at a missing row is an ordinary state in a
          syncing database.
        </li>
        <li>
          <strong>Go offline in one tab.</strong> Keep filing and commenting — the unsent count climbs. Come back online
          and it drains.
        </li>
        <li>
          <strong>Edit different fields.</strong> Offline in both: rename an issue in one, cycle its status in the
          other. Both survive, because merging is per field.
        </li>
        <li>
          <strong>Edit different lines of one issue body.</strong> diff3 merges the prose without asking anyone. Edit
          the same line and both versions come back behind markers.
        </li>
        <li>
          <strong>Delete an issue under an unsent comment.</strong> The comment is quarantined, not silently dropped.
        </li>
        <li>
          <strong>Reload.</strong> Local storage is the state, not a cache: unsent work is still there afterwards.
        </li>
      </ul>
      <button type="button" className="primary modal-close" onClick={onClose}>
        Close
      </button>
    </>
  );
}

/** How long a modal's closing animation runs for, in step with the stylesheet. */
const MODAL_CLOSE_MS = 130;

interface Modal {
  readonly open: () => void;
  readonly close: () => void;
  /** Escape, taken over so the closing animation is not skipped. */
  readonly onCancel: (event: SyntheticEvent<HTMLDialogElement>) => void;
  /** A click on the backdrop. */
  readonly onClick: (event: ReactMouseEvent<HTMLDialogElement>) => void;
}

/**
 * A modal `<dialog>`, with the two things the element does not do for itself.
 *
 * Escape, the focus trap, the inert backdrop and the top layer are all native, which is why this
 * is a `<dialog>` and not a fixed-position div: none of that is worth reimplementing and most of
 * it is worth getting wrong. What is added here is the closing animation, and returning focus to
 * whatever opened the dialog — the element does that itself in current engines, and recording the
 * opener makes it hold wherever it does not.
 *
 * The element's ref belongs to the caller, which is what keeps a ref out of this hook's return
 * value and off the render path.
 */
function useModal(dialog: RefObject<HTMLDialogElement | null>, onClosed?: () => void): Modal {
  const ref = dialog;
  const opener = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const open = useCallback((): void => {
    const element = ref.current;
    if (element === null || element.open) return;
    // `instanceof HTMLElement` would read a global that exists only in a browser, and this tree
    // is also rendered where it does not. What matters is whether the element can take focus back.
    const active = document.activeElement as Partial<HTMLElement> | null;
    opener.current = typeof active?.focus === "function" ? (active as HTMLElement) : null;
    element.showModal();
  }, [ref]);

  /**
   * `close()` takes the dialog out of the top layer immediately, so it has to be held open for as
   * long as the stylesheet's closing animation. The marker is set with `setAttribute` rather than
   * through React state: a class React owns would be reconciled away by the next store update,
   * which lands often here, and the dialog would blink out mid-animation. The close itself runs
   * off a timer rather than `animationend`, because an animation that never fires must not leave
   * a modal stuck open over the page.
   */
  const close = (): void => {
    const element = ref.current;
    if (element === null) return;
    const finish = (): void => {
      element.removeAttribute("data-closing");
      element.close();
      opener.current?.focus();
      onClosed?.();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    element.setAttribute("data-closing", "");
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(finish, MODAL_CLOSE_MS);
  };

  return {
    open,
    close,
    onCancel: (event) => {
      event.preventDefault();
      close();
    },
    // A click on the backdrop is dispatched to the dialog itself, so "outside" has to be measured
    // rather than assumed — the dialog's own padding is inside its box too.
    onClick: (event) => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      const outside =
        event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) close();
    },
  };
}
/** How long a field waits after the last keystroke before it becomes a transaction. */
const COMMIT_IDLE_MS = 600;
const ISSUES = tableName("issues");

/**
 * A text field that behaves the way a text field has to in a syncing app. Typing is local until
 * you pause, so a word is one transaction rather than six; and a value arriving from another tab
 * while you are typing is held by `Diff3EditorBuffer` until you leave the field, so nothing
 * rewrites the text under your caret mid-word.
 */
function useBufferedField(
  table: TableName,
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
      tableName: table,
      rowId: toRowId(id),
      fieldName: fieldName(field),
      value,
    })) {
      committed.current = edit.value;
      setDraft(edit.value);
    }
  }, [value, table, id, field]);

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

function useStatus(store: IssueStore): StoreStatus {
  return useSyncExternalStore(
    (listener) => store.subscribeStatus(listener),
    () => store.status(),
  );
}
