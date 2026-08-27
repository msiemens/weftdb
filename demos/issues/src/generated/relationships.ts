import type { Database } from "./database.d.ts";

// One array for every miss in the file. A fresh `[]` per lookup is a new identity per render,
// which is what a memoised child compares against.
const weftNoRows: readonly never[] = [];

/** The `issues` rows `projects.issues` joins to, in the order given. */
export type ProjectsIssuesResult<Target = Database["issues"]> = readonly Target[];

/**
 * `projects.issues`, over rows the caller already holds.
 *
 * The targets are indexed on `project_id` here, once; the function this returns
 * answers a source row from that index in a single lookup, instead of a fresh filter over every
 * target per call. A source row with nothing on the far side gets the same empty list every time.
 */
export function projects_issuesRelation<Target extends Pick<Database["issues"], "project_id">>(
  targets: readonly Target[],
): (source: Pick<Database["projects"], "id">) => ProjectsIssuesResult<Target> {
  const index = new Map<string, Target[]>();
  for (const target of targets) {
    const key = String(target["project_id"]);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [target]);
    else bucket.push(target);
  }
  return (source) => index.get(String(source["id"])) ?? weftNoRows;
}

/** The `projects` row `issues.project` joins to, or none this device holds. */
export type IssuesProjectResult<Target = Database["projects"]> = Target | undefined;

/**
 * `issues.project`, over rows the caller already holds.
 *
 * The targets are indexed on `id` here, once; the function this returns
 * answers a source row from that index in a single lookup, instead of a fresh filter over every
 * target per call. A row may point at a target this device has not synced, which is what
 * `undefined` is.
 */
export function issues_projectRelation<Target extends Pick<Database["projects"], "id">>(
  targets: readonly Target[],
): (source: Pick<Database["issues"], "project_id">) => IssuesProjectResult<Target> {
  const index = new Map<string, Target>();
  for (const target of targets) {
    const key = String(target["id"]);
    if (!index.has(key)) index.set(key, target);
  }
  return (source) => index.get(String(source["project_id"]));
}

/** The `comments` rows `issues.comments` joins to, in the order given. */
export type IssuesCommentsResult<Target = Database["comments"]> = readonly Target[];

/**
 * `issues.comments`, over rows the caller already holds.
 *
 * The targets are indexed on `issue_id` here, once; the function this returns
 * answers a source row from that index in a single lookup, instead of a fresh filter over every
 * target per call. A source row with nothing on the far side gets the same empty list every time.
 */
export function issues_commentsRelation<Target extends Pick<Database["comments"], "issue_id">>(
  targets: readonly Target[],
): (source: Pick<Database["issues"], "id">) => IssuesCommentsResult<Target> {
  const index = new Map<string, Target[]>();
  for (const target of targets) {
    const key = String(target["issue_id"]);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [target]);
    else bucket.push(target);
  }
  return (source) => index.get(String(source["id"])) ?? weftNoRows;
}

/** The `issues` row `comments.issue` joins to, or none this device holds. */
export type CommentsIssueResult<Target = Database["issues"]> = Target | undefined;

/**
 * `comments.issue`, over rows the caller already holds.
 *
 * The targets are indexed on `id` here, once; the function this returns
 * answers a source row from that index in a single lookup, instead of a fresh filter over every
 * target per call. A row may point at a target this device has not synced, which is what
 * `undefined` is.
 */
export function comments_issueRelation<Target extends Pick<Database["issues"], "id">>(
  targets: readonly Target[],
): (source: Pick<Database["comments"], "issue_id">) => CommentsIssueResult<Target> {
  const index = new Map<string, Target>();
  for (const target of targets) {
    const key = String(target["id"]);
    if (!index.has(key)) index.set(key, target);
  }
  return (source) => index.get(String(source["issue_id"]));
}
