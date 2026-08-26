// What is left of an application's data layer once the library and codegen have taken their
// halves. Rows, decoding, mutators, hooks, reordering and the relationship accessors come from
// `src/generated`, which `weft generate` writes from the schema; the database, the worker that
// holds it and the sync session all come from `openWeftDatabase`. What is genuinely this
// application's is here: which scope this visitor is on, how a row looks once the client's own
// knowledge is added to it, and the tracker a first visit arrives at.
import {
  deviceId as toDeviceId,
  hasConflictMarkers,
  rankBetween,
  rankString,
  rowId,
  type DeviceId,
  type RowId,
  type TableName,
} from "weftdb/core";
import type { SessionStatus, StorageLike, WeftClientMirror } from "weftdb/client";
import { openDemoDatabase, DemoSync, type DemoDatabase, type DemoOpenOverrides } from "weftdb-demo-shared/open";
import { tabIdentity, type TabIdentity } from "weftdb-demo-shared/identity";
import { schema } from "./schema.ts";
import { DEMO } from "./scope.ts";
import relayWorkerUrl from "./relay-worker.ts?sharedworker&url";
import storageWorkerUrl from "./storage-worker.ts?sharedworker&url";
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
} from "./generated/bindings.ts";
import { mapCommentsRow } from "./generated/nested-mappers.ts";

export {
  commentsQuery,
  issuesQuery,
  projectsQuery,
  useComments,
  useIssues,
  useIssuesQuery,
  useProjects,
} from "./generated/bindings.ts";
export type { CommentsRow, IssuesRow, ProjectsRow } from "./generated/bindings.ts";
export {
  comments_issueRelation,
  issues_commentsRelation,
  issues_projectRelation,
  projects_issuesRelation,
} from "./generated/relationships.ts";

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
  readonly database: DemoDatabase;
}

export interface WindowLike {
  readonly sessionStorage: StorageLike;
  readonly localStorage: StorageLike;
}

export class IssueStore {
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
  readonly projects: ProjectsMutators;
  readonly issues: IssuesMutators;
  readonly comments: CommentsMutators;
  /** The status pills, the online toggle, and the two verbs the header's buttons call. */
  readonly connection: DemoSync;

  constructor(options: IssueStoreOptions) {
    this.identity = options.identity;
    this.database = options.database;
    this.source = options.database.weft.source;
    this.deviceId = toDeviceId(this.source.deviceId);
    this.connection = new DemoSync(options.database);
    // No `notify` callback: the worker's echo wakes the subscriptions when the change arrives, and
    // a callback fired when the mutator returned would wake them before there was anything new.
    this.projects = projectsMutators(this.source);
    this.issues = issuesMutators(this.source);
    this.comments = commentsMutators(this.source);
  }

  /**
   * Opens this tab's database and seeds it on a first visit.
   *
   * The scope comes from local storage, so every tab of this browser opens the same tracker while
   * another visitor opens their own. The namespace comes from session storage, so **each tab is a
   * database of its own** — its own client in the storage worker, its own file and its own
   * device id — which is what makes a second tab a second device rather than a second view.
   */
  static async open(window: WindowLike, overrides?: DemoOpenOverrides): Promise<IssueStore> {
    const identity = tabIdentity(window.sessionStorage, window.localStorage, { demo: DEMO });
    const database = await openDemoDatabase({
      schema,
      scopeId: identity.scopeId,
      namespace: `weftdb-demo/${DEMO}/${identity.deviceId}`,
      worker: storageWorkerUrl,
      relayWorker: relayWorkerUrl,
      ...(overrides === undefined ? {} : { overrides }),
    });
    const store = new IssueStore({ identity, database });
    void store.seed(window.localStorage);
    return store;
  }

  /**
   * Writes the starting rows, once per visitor.
   *
   * The guard is a local-storage key beside the scope's own, which is what makes this once per
   * visitor rather than once per tab: a second tab of the same browser reads the same key, and a
   * visitor who deletes the seeded rows does not get them back.
   *
   * A device that hydrates empty is not evidence of a fresh scope, because every new tab is a new
   * device and hydrates empty until it has synced. The key is what decides; the row count only
   * keeps a cleared key from seeding a scope that already has rows.
   */
  async seed(local: StorageLike): Promise<void> {
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
      projectRank = rankBetween(projectRank === null ? null : rankString(projectRank), null, this.deviceId);
      await this.projects.create(projectId, { name: project.name, rank: projectRank });

      for (const issue of project.issues) {
        const issueId = newIssueId();
        issueRank = rankBetween(issueRank === null ? null : rankString(issueRank), null, this.deviceId);
        await this.issues.create(issueId, {
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
          commentRank = rankBetween(commentRank === null ? null : rankString(commentRank), null, this.deviceId);
          await this.comments.create(newCommentId(), {
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
    return () => undefined;
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
    return this.source.engine
      .getSnapshot(projectsQuery("rank"), this.source.rows.values())
      .rows.map((row) => decodeProjects(row));
  }

  /** Every issue outside a render, in rank order. */
  issueRows(): readonly IssuesRow[] {
    return this.source.engine
      .getSnapshot(issuesQuery("rank"), this.source.rows.values())
      .rows.map((row) => decodeIssues(row));
  }

  /** One issue's comments outside a render, in the order the thread reads. */
  commentRows(issueId: string): readonly CommentsRow[] {
    return this.source.engine
      .getSnapshot(commentsQuery("rank"), this.source.rows.values())
      .rows.map((row) => decodeComments(row))
      .filter((row) => row.issue_id === issueId);
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

  /** A rank that puts a new project at the end of the rail. */
  nextProjectRank(): string {
    return nextProjectsRank(this.projectRows(), this.deviceId);
  }

  /**
   * A rank that puts a new issue after every issue there is, not merely after its own project's.
   *
   * `rank` orders the whole collection, so minting from one project's slice gives the first issue
   * of every project the same rank, and the unfiltered list then falls back to comparing row ids.
   * Ranking against all of them keeps a new issue last in its project and last overall.
   */
  nextIssueRank(): string {
    return nextIssuesRank(this.issueRows(), this.deviceId);
  }

  /** A rank that puts a new comment at the end of its issue's thread. */
  nextCommentRank(issueId: string): string {
    const last = this.commentRows(issueId).at(-1);
    return rankBetween(last === undefined ? null : rankString(last.rank), null, this.deviceId);
  }

  /**
   * Moves an issue one place within the list it is being shown in.
   *
   * The rows are the caller's rather than read back here, because the list on screen is what the
   * arrows move within: it has been narrowed by the rail's project and by the status filter, and a
   * move computed against every issue in the scope would land the row between two the person cannot
   * see. Reordering writes one field, the row's new rank, so two devices reordering at once do not
   * undo each other.
   */
  async moveIssue(rows: readonly IssuesRow[], index: number, direction: "up" | "down"): Promise<void> {
    await moveIssues(this.issues, rows, index, direction, this.deviceId);
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

  #dirty(table: TableName, id: string): boolean {
    return this.source.isRowDirty(table, rowId(id));
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
