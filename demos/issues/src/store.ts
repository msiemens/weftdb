// What is left of an application's data layer once the library and codegen have taken their
// halves. Rows, decoding, mutators, hooks and reordering come from `src/generated`, which
// `weft generate` writes from the schema; syncing, connectivity and status come from
// `WeftSession`. What is genuinely this application's is here: which storage it uses, who this
// tab is, how a row looks once the client's own knowledge is added to it, and how the schema's
// relationships are resolved against rows the client already holds.
import { hasConflictMarkers, rankBetween, rankString, rowId, type RowId, type TableName } from "weftdb/core";
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
  commentsMutators,
  commentsQuery,
  commentsTable,
  decodeComments,
  decodeIssues,
  decodeProjects,
  issuesMutators,
  issuesQuery,
  issuesTable,
  moveIssues,
  nextIssuesRank,
  nextProjectsRank,
  projectsMutators,
  projectsQuery,
  projectsTable,
  type CommentsMutators,
  type CommentsRow,
  type IssuesMutators,
  type IssuesRow,
  type ProjectsMutators,
  type ProjectsRow,
  type WeftSource,
} from "./generated/bindings.ts";
import { mapCommentsRow } from "./generated/nested-mappers.ts";

export {
  commentsQuery,
  issuesQuery,
  projectsQuery,
  useComments,
  useIssues,
  useProjects,
} from "./generated/bindings.ts";
export type { CommentsRow, IssuesRow, ProjectsRow } from "./generated/bindings.ts";
export {
  comments_issueRelation,
  issues_commentsRelation,
  issues_projectRelation,
  projects_issuesRelation,
} from "./generated/relationships.ts";
export type { BroadcastChannelLike } from "weftdb/client";

const HASH = schemaHash(schema);

/**
 * The statuses an issue moves between, in the order the button cycles them. `status` is an
 * `S.enum` in the schema, so the row type is the union and this list has to agree with it.
 */
export type Status = IssuesRow["status"];
export const STATUSES: readonly [Status, ...Status[]] = ["open", "started", "closed"];

export function nextStatus(status: Status): Status {
  const index = STATUSES.indexOf(status);
  return STATUSES[(index + 1) % STATUSES.length] ?? STATUSES[0];
}

// --- relationships -------------------------------------------------------------------------

/**
 * A relationship as `weft generate` writes it: the field on each side and whether the far side
 * holds many rows. `src/generated/relationships.ts` has one of these per `S.hasOne` and
 * `S.hasMany` in the schema.
 */
export interface Relationship {
  readonly localField: string;
  readonly foreignField: string;
  readonly many: boolean;
}

/**
 * One relationship, with its target rows indexed by the field it joins on.
 *
 * The descriptor carries both field names, so nothing here names a foreign key and the same class
 * serves every relationship in the schema. Build it once per render from the rows the hooks
 * return; the client already holds them, so a join is a lookup rather than a query.
 */
export class Related<Target extends object> {
  readonly #relationship: Relationship;
  readonly #byForeignField = new Map<string, Target[]>();

  constructor(relationship: Relationship, targets: readonly Target[]) {
    this.#relationship = relationship;
    for (const target of targets) {
      const key = field(target, relationship.foreignField);
      const bucket = this.#byForeignField.get(key);
      if (bucket === undefined) this.#byForeignField.set(key, [target]);
      else bucket.push(target);
    }
  }

  /** Every row on the far side of a `hasMany`, in the order the target rows arrived. */
  all(source: object): readonly Target[] {
    return this.#byForeignField.get(field(source, this.#relationship.localField)) ?? [];
  }

  /**
   * The row on the far side of a `hasOne`, or undefined when the client does not hold it yet.
   * A row can point at a target this device has not synced, so the caller decides what to show.
   */
  one(source: object): Target | undefined {
    if (this.#relationship.many) {
      throw new Error("one() is for a hasOne relationship; this one is a hasMany");
    }
    return this.all(source)[0];
  }
}

/** Reads a field a relationship names. The schema fixes the type; the descriptor is strings. */
function field(row: object, name: string): string {
  const value = (row as Readonly<Record<string, unknown>>)[name];
  return typeof value === "string" ? value : String(value);
}

// --- rows, plus what only the client knows -------------------------------------------------

/** A comment after the generated mapper has folded `author__*` into an object. */
export interface CommentAuthor {
  readonly label: string;
  readonly device: string;
}

export interface NestedComment {
  readonly id: string;
  readonly scope_id: string;
  readonly created: string;
  readonly issue_id: string;
  readonly body: string;
  readonly rank: string;
  readonly author: CommentAuthor;
}

export interface CommentView extends NestedComment {
  /** Local work the server has not acknowledged. */
  readonly dirty: boolean;
}

export interface IssueView extends IssuesRow {
  readonly dirty: boolean;
  readonly conflicted: boolean;
}

export interface ProjectView extends ProjectsRow {
  readonly dirty: boolean;
}

export type StoreStatus = SessionStatus;

export interface IssueStoreOptions {
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

export class IssueStore {
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
  readonly projects: ProjectsMutators;
  readonly issues: IssuesMutators;
  readonly comments: CommentsMutators;
  readonly session: WeftSession;

  constructor(options: IssueStoreOptions) {
    this.identity = options.identity;
    this.client = options.client;
    this.source = rowMapSource({ engine: this.engine, rows: options.client.rows }, options.client.scopeId);
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
    this.projects = projectsMutators(options.client, changed);
    this.issues = issuesMutators(options.client, changed);
    this.comments = commentsMutators(options.client, changed);
  }

  /** Opens the state this tab left behind, or a fresh client on a first visit. */
  static open(window: WindowLike): IssueStore {
    // The scope comes from local storage, so every tab of this browser opens the same tracker
    // while another visitor opens their own. The device comes from session storage, so each tab
    // is a device of its own.
    const identity = tabIdentity(window.sessionStorage, window.localStorage, { demo: DEMO });
    const persistence = new WebStorageClientStore(window.localStorage, schema, `weftdb-demo/${DEMO}`);
    const store = new IssueStore({
      identity,
      client: persistence.hydrate(identity.scopeId, identity.deviceId),
      transport: httpTransport({ baseUrl: "/api", token: identity.token }),
      // Same origin as the page, so the dev server's proxy carries the upgrade too.
      socketUrl: `${location.origin.replace(/^http/u, "ws")}/api/sync`,
      // Named for the scope, so two demos in two tabs do not wake each other's sessions.
      channel:
        typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(`weftdb-demo/${identity.scopeId}`),
    });
    store.seed(window.localStorage);
    return store;
  }

  /**
   * Writes the starting rows, once per visitor.
   *
   * The guard is a local-storage key beside the scope's own, which is what makes this once per
   * visitor rather than once per tab: a second tab of the same browser reads the same key, and a
   * visitor who deletes the seeded rows does not get them back. It runs before `start`, so the
   * rows go into the outbox and reach the relay in the first sync alongside anything else this
   * tab does.
   *
   * A device that hydrates empty is not evidence of a fresh scope, because every new tab is a new
   * device and hydrates empty until it has synced. The key is what decides; the row count only
   * keeps a cleared key from seeding a scope that already has rows.
   */
  seed(local: StorageLike): void {
    const key = `weftdb-demo/${DEMO}/${this.identity.scopeId}/seeded`;
    if (local.getItem(key) !== null) return;
    // Written before the rows, so two tabs opened at the same instant on a first visit have the
    // smallest window in which both can decide to seed. Ids are random, so if both do, the result
    // is duplicate rows rather than a rejected transaction.
    local.setItem(key, new Date().toISOString());
    if (this.projectRows().length > 0) return;

    let projectRank: string | null = null;
    // Rank orders the whole `issues` collection, not one project's slice of it, so the chain runs
    // across the seed rather than restarting per project. Restarting it gives every project's
    // first issue the same rank, and the unfiltered list interleaves them.
    let issueRank: string | null = null;
    for (const project of SEED) {
      const projectId = newProjectId();
      projectRank = rankBetween(projectRank === null ? null : rankString(projectRank), null, this.identity.deviceId);
      this.projects.create(projectId, { name: project.name, rank: projectRank });

      for (const issue of project.issues) {
        const issueId = newIssueId();
        issueRank = rankBetween(issueRank === null ? null : rankString(issueRank), null, this.identity.deviceId);
        this.issues.create(issueId, {
          project_id: projectId,
          title: issue.title,
          body: issue.body,
          status: issue.status,
          rank: issueRank,
        });
        // Ranked in the order they are written, so the thread reads the way the seed reads. The
        // chain is per issue, which is the scope the thread is filtered to.
        let commentRank: string | null = null;
        for (const comment of issue.comments ?? []) {
          commentRank = rankBetween(
            commentRank === null ? null : rankString(commentRank),
            null,
            this.identity.deviceId,
          );
          this.comments.create(newCommentId(), {
            issue_id: issueId,
            body: comment.body,
            rank: commentRank,
            author__label: comment.label,
            author__device: comment.device,
          });
        }
      }
    }
  }

  start(): () => void {
    return this.session.start();
  }

  /** Adds what only the client knows to a decoded project. */
  projectView(row: ProjectsRow): ProjectView {
    return { ...row, dirty: this.#dirty(projectsTable, row.id) };
  }

  issueView(row: IssuesRow): IssueView {
    return {
      ...row,
      dirty: this.#dirty(issuesTable, row.id),
      conflicted: hasConflictMarkers(row.body),
    };
  }

  /**
   * A comment as the page renders it. `mapCommentsRow` comes from `weft generate` and folds the
   * flat `author__label` and `author__device` columns into `author`, so the page reads
   * `comment.author.label` rather than the column names the field store uses.
   */
  commentView(row: CommentsRow): CommentView {
    const nested = mapCommentsRow(row) as unknown as NestedComment;
    return { ...nested, dirty: this.#dirty(commentsTable, row.id) };
  }

  /** The projects outside a render, in rank order — for the handlers that mint a new rank. */
  projectRows(): readonly ProjectsRow[] {
    return this.engine
      .getSnapshot(projectsQuery("rank"), this.client.rows.values())
      .rows.map((row) => decodeProjects(row));
  }

  /** One project's issues outside a render, in rank order. */
  issueRows(projectId?: string): readonly IssuesRow[] {
    const rows = this.engine
      .getSnapshot(issuesQuery("rank"), this.client.rows.values())
      .rows.map((row) => decodeIssues(row));
    return projectId === undefined ? rows : rows.filter((row) => row.project_id === projectId);
  }

  /** One issue's comments outside a render, in the order the thread reads. */
  commentRows(issueId: string): readonly CommentsRow[] {
    return this.engine
      .getSnapshot(commentsQuery("rank"), this.client.rows.values())
      .rows.map((row) => decodeComments(row))
      .filter((row) => row.issue_id === issueId);
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

  /** A rank that puts a new project at the end of the rail. */
  nextProjectRank(): string {
    return nextProjectsRank(this.projectRows(), this.identity.deviceId);
  }

  /**
   * A rank that puts a new issue after every issue there is, not merely after its own project's.
   *
   * `rank` orders the whole collection, so minting from one project's slice gives the first issue
   * of every project the same rank, and the unfiltered list then falls back to comparing row ids.
   * Ranking against all of them keeps a new issue last in its project and last overall.
   */
  nextIssueRank(): string {
    return nextIssuesRank(this.issueRows(), this.identity.deviceId);
  }

  /** A rank that puts a new comment at the end of its issue's thread. */
  nextCommentRank(issueId: string): string {
    const last = this.commentRows(issueId).at(-1);
    return rankBetween(last === undefined ? null : rankString(last.rank), null, this.identity.deviceId);
  }

  /**
   * Moves an issue one place within its own project. Reordering writes one field, the row's new
   * rank, so two devices reordering at once do not undo each other.
   */
  moveIssue(projectId: string | undefined, index: number, direction: "up" | "down"): void {
    moveIssues(this.issues, this.issueRows(projectId), index, direction, this.identity.deviceId);
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

  #dirty(table: TableName, id: string): boolean {
    return this.client.isRowDirty(table, rowId(id));
  }
}

export function newProjectId(): RowId {
  return rowId(`project-${crypto.randomUUID()}`);
}

export function newIssueId(): RowId {
  return rowId(`issue-${crypto.randomUUID()}`);
}

export function newCommentId(): RowId {
  return rowId(`comment-${crypto.randomUUID()}`);
}

interface SeedComment {
  readonly body: string;
  readonly label: string;
  readonly device: string;
}

interface SeedIssue {
  readonly title: string;
  readonly body: string;
  readonly status: Status;
  readonly comments?: readonly SeedComment[];
}

interface SeedProject {
  readonly name: string;
  readonly issues: readonly SeedIssue[];
}

/**
 * What a first visit opens on. Two projects, issues across all three statuses, and one thread, so
 * every join on the page has something to resolve before anyone has typed anything.
 */
const SEED: readonly SeedProject[] = [
  {
    name: "Loom firmware",
    issues: [
      {
        title: "Shuttle stalls at row 12",
        body: "Reproduces on the test warp every time.\nThe stall clears if the beam is re-tensioned by hand.",
        status: "started",
        comments: [
          {
            body: "Happens on the second pass, not the first. The encoder reads 11 when the shuttle is at 12.",
            label: "ada",
            device: "workshop-laptop",
          },
          {
            body: "That matches the off-by-one in the row counter. Sending a patch against 2.1.",
            label: "gerd",
            device: "floor-tablet",
          },
          {
            body: "Patch holds for 400 rows. Leaving this open until it has run a full bolt.",
            label: "ada",
            device: "workshop-laptop",
          },
        ],
      },
      {
        title: "Tension sensor drifts after an hour",
        body: "Reads 4% high once the frame is warm. Recalibrating mid-run corrects it.",
        status: "open",
      },
      {
        title: "Firmware 2.1 release notes",
        body: "Written up and published with the 2.1 tag.",
        status: "closed",
      },
    ],
  },
  {
    name: "Weaving room",
    issues: [
      {
        title: "Warp beam needs re-threading",
        body: "Threads 340 to 360 are crossed.",
        status: "open",
        comments: [
          {
            body: "Booked for Thursday morning, before the indigo run.",
            label: "gerd",
            device: "floor-tablet",
          },
        ],
      },
      {
        title: "Order more indigo weft",
        body: "Two cones left. Lead time is three weeks.",
        status: "started",
      },
    ],
  },
];
