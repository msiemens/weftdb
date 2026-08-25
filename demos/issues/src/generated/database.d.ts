export interface Database {
  projects: {
    id: string;
    scope_id: string;
    created: string;
    name: string;
    rank: string;
  };
  issues: {
    id: string;
    scope_id: string;
    created: string;
    project_id: string;
    title: string;
    body: string;
    status: "open" | "started" | "closed";
    rank: string;
  };
  comments: {
    id: string;
    scope_id: string;
    created: string;
    issue_id: string;
    body: string;
    rank: string;
    author__label: string;
    author__device: string;
  };
}
