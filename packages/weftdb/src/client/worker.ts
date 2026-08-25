import type { CompiledQuery } from "./query.ts";

export type WorkerRequest =
  | { readonly id: number; readonly type: "open"; readonly scopeId: string }
  | { readonly id: number; readonly type: "execute"; readonly query: CompiledQuery }
  | { readonly id: number; readonly type: "close" };

export type WorkerRequestBody =
  | { readonly type: "open"; readonly scopeId: string }
  | { readonly type: "execute"; readonly query: CompiledQuery }
  | { readonly type: "close" };

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<WorkerResponse>) => void): void;
}

export class OpfsWorkerTransport {
  readonly #worker: WorkerLike;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();

  constructor(worker: WorkerLike) {
    this.#worker = worker;
    this.#worker.addEventListener("message", this.#onMessage);
  }

  open(scopeId: string): Promise<unknown> {
    return this.#send({ type: "open", scopeId });
  }

  execute(query: CompiledQuery): Promise<unknown> {
    return this.#send({ type: "execute", query });
  }

  close(): Promise<unknown> {
    return this.#send({ type: "close" });
  }

  dispose(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    for (const pending of this.#pending.values()) pending.reject(new Error("worker transport disposed"));
    this.#pending.clear();
  }

  #send(message: WorkerRequestBody): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage(withRequestId(id, message));
    });
  }

  readonly #onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const pending = this.#pending.get(event.data.id);
    if (pending === undefined) return;
    this.#pending.delete(event.data.id);
    if (event.data.ok) pending.resolve(event.data.value);
    else pending.reject(new Error(event.data.error));
  };
}

function withRequestId(id: number, message: WorkerRequestBody): WorkerRequest {
  switch (message.type) {
    case "open":
      return { ...message, id };
    case "execute":
      return { ...message, id };
    case "close":
      return { ...message, id };
  }
}
