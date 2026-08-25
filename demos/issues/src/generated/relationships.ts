import type { Database } from "./database.d.ts";

export function projects_issuesRelation() {
  return {
    sourceTable: "projects",
    targetTable: "issues",
    localField: "id",
    foreignField: "project_id",
    many: true,
  } satisfies { readonly sourceTable: string; readonly targetTable: string; readonly localField: string; readonly foreignField: string; readonly many: boolean };
}
export type ProjectsIssuesResult = readonly Database["issues"][];

export function issues_projectRelation() {
  return {
    sourceTable: "issues",
    targetTable: "projects",
    localField: "project_id",
    foreignField: "id",
    many: false,
  } satisfies { readonly sourceTable: string; readonly targetTable: string; readonly localField: string; readonly foreignField: string; readonly many: boolean };
}
export type IssuesProjectResult = Database["projects"] | null;

export function issues_commentsRelation() {
  return {
    sourceTable: "issues",
    targetTable: "comments",
    localField: "id",
    foreignField: "issue_id",
    many: true,
  } satisfies { readonly sourceTable: string; readonly targetTable: string; readonly localField: string; readonly foreignField: string; readonly many: boolean };
}
export type IssuesCommentsResult = readonly Database["comments"][];

export function comments_issueRelation() {
  return {
    sourceTable: "comments",
    targetTable: "issues",
    localField: "issue_id",
    foreignField: "id",
    many: false,
  } satisfies { readonly sourceTable: string; readonly targetTable: string; readonly localField: string; readonly foreignField: string; readonly many: boolean };
}
export type CommentsIssueResult = Database["issues"] | null;
