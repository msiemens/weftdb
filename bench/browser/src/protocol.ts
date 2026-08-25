// What the page and the worker say to each other. The shape follows `weftdb/client`'s own worker
// protocol — a request id, and a reply that is either a value or an error string — so what this
// measures is the protocol the design would actually ship rather than a cheaper stand-in.

/** A todo as a view would receive it: the eight domain fields plus the row's identity. */
export interface DeltaRow {
  readonly id: string;
  readonly scope_id: string;
  readonly created: string;
  readonly title: string;
  readonly notes: string;
  readonly done: boolean;
  readonly rank: string;
  readonly due_at: number | null;
  readonly auto_delete_days: number | null;
}

export interface SampleBudget {
  readonly iterations: number;
  readonly warmup: number;
}

export type BenchRequest =
  /** Boots SQLite and installs the OPFS pool, so the page learns early whether OPFS is reachable. */
  | { readonly id: number; readonly type: "init" }
  /** Replies with nothing, which is the floor of a round trip. */
  | { readonly id: number; readonly type: "ping" }
  /** Replies with a prebuilt delta, so the clock covers structured clone rather than construction. */
  | { readonly id: number; readonly type: "delta"; readonly rows: number }
  /** Opens a database of `size` rows and leaves it open for the cases that follow. */
  | { readonly id: number; readonly type: "prepare"; readonly size: number }
  | { readonly id: number; readonly type: "commit"; readonly size: number; readonly budget: SampleBudget }
  | { readonly id: number; readonly type: "hydrate"; readonly size: number; readonly budget: SampleBudget }
  /** One real update and its commit, answered with the row the edit produced. */
  | { readonly id: number; readonly type: "edit"; readonly size: number }
  | { readonly id: number; readonly type: "dispose" };

export type BenchResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

export interface InitValue {
  /** Whether a synchronous OPFS database could be opened at all. Everything durable depends on it. */
  readonly opfs: boolean;
  readonly detail: string;
}

export interface SamplesValue {
  readonly samples: readonly number[];
}

export interface DeltaValue {
  readonly rows: readonly DeltaRow[];
}
