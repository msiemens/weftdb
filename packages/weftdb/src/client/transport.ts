// A sync session is four calls — handshake, push, pull, snapshot — and every decision between
// them is the client's. That makes the calls the only thing a network has to change, so a
// relay reached over HTTP and an in-process `WeftServer` differ here and nowhere else.
import type { ScopeId, WeftOp } from "weftdb/core";
import type { HandshakeRequest, HandshakeResponse, PullBatch, PushAck, Snapshot, WeftServer } from "weftdb/server";
import { snapshotFromEnvelope, type SnapshotEnvelope } from "weftdb/server/snapshot";
import type { Rejection } from "weftdb/core";

export type PushResult =
  | { ok: true; acks: PushAck[] }
  /** `acks` carries the transactions that were applied before the rejection stopped the push. */
  | { ok: false; rejection: Rejection; acks?: PushAck[] };

/** What `WeftClient.syncWith` needs. `WeftServer` satisfies the synchronous shape of this. */
export interface AsyncSyncTransport {
  handshake(request: HandshakeRequest): Promise<HandshakeResponse>;
  push(scopeId: ScopeId, ops: WeftOp[]): Promise<PushResult>;
  pull(scopeId: ScopeId, lastServerSeq: number): Promise<PullBatch>;
  snapshot(scopeId: ScopeId): Promise<Snapshot>;
}

/**
 * A relay on this thread, as a transport. The four calls are the whole of what a session is, so a
 * server reached by a method call and one reached over a network differ here and nowhere else.
 */
export function inProcessTransport(server: WeftServer): AsyncSyncTransport {
  return {
    handshake: async (request) => server.handshake(request),
    push: async (scopeId, ops) => server.push(scopeId, ops),
    pull: async (scopeId, lastServerSeq) => server.pull(scopeId, lastServerSeq),
    snapshot: async (scopeId) => server.snapshot(scopeId),
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  /** Where the relay is mounted, e.g. `/api` behind a dev-server proxy or an absolute origin. */
  readonly baseUrl: string;
  /** Bearer token. The relay derives the scope and device from it, so it also picks the identity. */
  readonly token: string;
  readonly fetch?: FetchLike;
}

/**
 * The relay's HTTP surface, as a transport. The scope travels in the token rather than the
 * request, so the `scopeId` arguments here are the client's own view and are not sent: a client
 * cannot reach a scope its token does not name.
 */
export function httpTransport(options: HttpTransportOptions): AsyncSyncTransport {
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      // 401/403 are configuration, not sync outcomes: a rejection the client should reason
      // about always arrives as a 200 with a body describing it.
      throw new RelayError(response.status, await response.text().catch(() => ""));
    }
    return response.json();
  };

  return {
    handshake: async (request) =>
      (await call("/handshake", { method: "POST", body: JSON.stringify(request) })) as HandshakeResponse,
    push: async (_scopeId, ops) =>
      (await call("/push", { method: "POST", body: JSON.stringify({ ops }) })) as PushResult,
    pull: async (_scopeId, lastServerSeq) => (await call(`/pull?last_server_seq=${lastServerSeq}`)) as PullBatch,
    snapshot: async () => {
      // `/snapshot` answers with the bytes and their digest; the records are read back out of
      // them here, which also checks the content address rather than taking it on trust.
      return snapshotFromEnvelope((await call("/snapshot")) as SnapshotEnvelope);
    },
  };
}

export class RelayError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`relay responded ${status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`);
    this.name = "RelayError";
    this.status = status;
  }
}
