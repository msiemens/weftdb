export interface ProjectsMutation {
  readonly name?: string;
  readonly rank?: string;
}
export interface ProjectsMutators {
  create(id: string, values: ProjectsMutation): void;
  update(id: string, values: ProjectsMutation): void;
  delete(id: string): void;
}

export interface IssuesMutation {
  readonly project_id?: string;
  readonly title?: string;
  readonly body?: string;
  readonly status?: "open" | "started" | "closed";
  readonly rank?: string;
}
export interface IssuesMutators {
  create(id: string, values: IssuesMutation): void;
  update(id: string, values: IssuesMutation): void;
  delete(id: string): void;
}

export interface CommentsMutation {
  readonly issue_id?: string;
  readonly body?: string;
  readonly rank?: string;
  readonly author__label?: string;
  readonly author__device?: string;
}
export interface CommentsMutators {
  create(id: string, values: CommentsMutation): void;
}
