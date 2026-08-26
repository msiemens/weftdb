// The sync session over a WebSocket. One connection carries both directions: the requests a
// session makes, and the relay's unsolicited "this scope moved" — so a device is told when to
// sync and does it without opening anything.
//
// This is a `AsyncSyncTransport` like any other. The session logic above it — what a handshake
// outcome means, what to do with a rejection, when a snapshot is needed — is the same code the
// HTTP transport runs, which is the same code the specification and the property suite are
// about. Only the way bytes move changes.
import type { ScopeId, WeftOp } from "weftdb/core";
import type { HandshakeRequest, PullBatch } from "weftdb/server";
import type { SyncArguments, SyncOperation, SyncResults } from "weftdb/server/relay";
import { snapshotFromEnvelope } from "weftdb/server/snapshot";
import { FIRST_RETRY_MS, nextRetryMs } from "./backoff.ts";
import type { AsyncSyncTransport } from "./transport.ts";

/** The relay saying a scope has moved. It carries the cursor to catch up to and nothing else. */
export interface ScopeAdvanced {
  readonly type: "advanced";
  readonly scopeId: ScopeId;
  readonly serverSeq: number;
}

/** The slice of the DOM `WebSocket` this needs, so a test can supply its own. */
export interface WebSocketLike {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
  send?(data: string): void;
  close(): void;
  readonly readyState: number;
}

export type WebSocketFactory = (url: string, protocols: readonly string[]) => WebSocketLike;

/**
 * The two subprotocols a connection offers: the dialect, and the credential.
 *
 * The token travels as a subprotocol because a browser's `WebSocket` constructor takes no headers,
 * and a query string would put the credential in the relay's access log. The relay declares the same
 * pair for itself in `server/websocket.ts`; the strings are on the wire, so changing one is changing
 * a protocol and both ends move together.
 */
export const WAKEUP_PROTOCOL = "weft.v1";
export const TOKEN_PROTOCOL_PREFIX = "weft.token.";

/** What arrives on the socket, before it has been established which of the kinds it is. */
interface IncomingMessage {
  readonly type?: string;
  readonly id?: string;
  readonly op?: string;
  readonly result?: unknown;
  readonly reason?: string;
  readonly scopeId?: ScopeId;
  readonly serverSeq?: number;
  readonly batch?: unknown;
  /** Chunked answers: a slice of the JSON result, and whether it is the final one. */
  readonly index?: number;
  readonly last?: boolean;
  readonly data?: string;
  /** Set on chunks that reassemble into an unsolicited batch rather than an answer. */
  readonly for?: string;
}

export interface SocketTransportOptions {
  readonly url: string;
  readonly token: string;
  /** Called when the relay says the scope moved, and again whenever the socket reconnects. */
  readonly onWake?: (advanced: ScopeAdvanced | undefined) => void;
  /**
   * Called with a batch the relay sent unasked, once this connection has subscribed. It is the
   * same batch a pull would have returned, so a caller applies it the same way — which is what
   * keeps one path responsible for merging, however the records arrived.
   */
  readonly onBatch?: (batch: PullBatch) => void;
  /**
   * Where this client has got to. Given one, the transport subscribes on every connect and the
   * relay sends what changed instead of a note saying that something did.
   */
  readonly cursor?: () => number;
  readonly onStatusChange?: (connected: boolean) => void;
  readonly WebSocket?: WebSocketFactory;
  /** How long a request waits before it is treated as a connection that has gone quiet. */
  readonly timeoutMs?: number;
}

export interface SocketTransport extends AsyncSyncTransport {
  readonly connected: boolean;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface Pending {
  readonly resolve: (body: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class SocketClosedError extends Error {
  constructor(reason: string) {
    super(`weft socket: ${reason}`);
    this.name = "SocketClosedError";
  }
}

export class SocketRequestError extends Error {
  constructor(operation: string, reason: string) {
    super(`the relay refused ${operation}: ${reason}`);
    this.name = "SocketRequestError";
  }
}

/**
 * Opens the socket and keeps it open. Requests made while it is down fail rather than queue:
 * the outbox is already the queue, and a sync that failed is one the client will run again.
 */
export function connectSocketTransport(options: SocketTransportOptions): SocketTransport {
  const factory =
    options.WebSocket ?? ((url, protocols) => new WebSocket(url, [...protocols]) as unknown as WebSocketLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, Pending>();
  /** Pieces of answers too big to send in one message, held until the last piece lands. */
  const chunks = new Map<string, string[]>();
  const state = { connected: false, closed: false, retryMs: FIRST_RETRY_MS };

  const settle = (id: string, encoded: string): void => {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    try {
      waiting.resolve(JSON.parse(encoded));
    } catch {
      waiting.reject(new SocketClosedError("an answer arrived in pieces that do not parse"));
    }
  };
  let socket: (WebSocketLike & { send?: (data: string) => void }) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let counter = 0;

  const setConnected = (connected: boolean): void => {
    if (state.connected === connected) return;
    state.connected = connected;
    options.onStatusChange?.(connected);
  };

  const failAll = (reason: string): void => {
    for (const [id, request] of [...pending]) {
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new SocketClosedError(reason));
    }
    // Half of a chunked answer is worth nothing, and the request that wanted it is already
    // failed; keeping the pieces would only mean fitting them to a later request's id.
    chunks.clear();
  };

  const open = (): void => {
    if (state.closed) return;
    let current: WebSocketLike & { send?: (data: string) => void };
    try {
      current = factory(options.url, [WAKEUP_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${options.token}`]);
    } catch {
      reconnect("could not open");
      return;
    }
    socket = current;

    current.addEventListener("open", () => {
      state.retryMs = FIRST_RETRY_MS;
      setConnected(true);
      if (options.onBatch !== undefined && options.cursor !== undefined) {
        // Saying where this client has got to is what turns "something changed" into the
        // change itself, and it is said on every connect because what happened while the
        // socket was down is exactly what this client does not know it is missing.
        try {
          current.send?.(JSON.stringify({ type: "subscribe", lastServerSeq: options.cursor() }));
        } catch {
          // The socket died between opening and this; the reconnect will subscribe again.
        }
        return;
      }
      // Without a subscription there is nothing to send, so a fresh connection catches up the
      // way a timer would have.
      options.onWake?.(undefined);
    });

    current.addEventListener("message", (event: { readonly data: unknown }) => {
      if (typeof event.data !== "string") return;
      let message: IncomingMessage;
      try {
        message = JSON.parse(event.data) as IncomingMessage;
      } catch {
        return;
      }
      if (message.type === "advanced" && typeof message.serverSeq === "number" && message.scopeId !== undefined) {
        options.onWake?.({ type: "advanced", scopeId: message.scopeId, serverSeq: message.serverSeq });
        return;
      }
      if (message.type === "batch") {
        // Records that arrived without being asked for, applied by the same code that applies
        // the ones that were.
        if (message.batch !== undefined) options.onBatch?.(message.batch as PullBatch);
        return;
      }
      if (typeof message.id !== "string") return;
      // A large answer arrives in pieces so that other traffic gets a turn between them; the
      // pieces are held until the last one and then parsed as the one body they are.
      if (message.type === "chunk" && typeof message.data === "string") {
        const held = [...(chunks.get(message.id) ?? []), message.data];
        chunks.set(message.id, held);
        if (message.last !== true) return;
        chunks.delete(message.id);
        if (message.for === "batch") {
          try {
            options.onBatch?.(JSON.parse(held.join("")) as PullBatch);
          } catch {
            // Pieces that do not reassemble into a batch are dropped; the next sync fetches it.
          }
          return;
        }
        settle(message.id, held.join(""));
        return;
      }
      if (message.type !== "response" && message.type !== "failure") return;
      const waiting = pending.get(message.id);
      if (waiting === undefined) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.type === "failure") {
        waiting.reject(new SocketRequestError(message.op ?? "the request", message.reason ?? "no reason given"));
        return;
      }
      waiting.resolve(message.result);
    });

    const dropped = (): void => {
      if (socket !== current) return;
      socket = undefined;
      setConnected(false);
      failAll("connection closed");
      reconnect("connection closed");
    };
    current.addEventListener("close", dropped);
    current.addEventListener("error", dropped);
  };

  const reconnect = (_reason: string): void => {
    if (state.closed) return;
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(open, state.retryMs);
    (retry as { unref?: () => void }).unref?.();
    // Backing off keeps a relay that is down from being hammered by every open tab at once.
    state.retryMs = nextRetryMs(state.retryMs);
  };

  /**
   * Asks for one of the protocol's four calls by name. The socket carries the operation, not a
   * description of a route to fetch — so the result's type follows from the operation asked for
   * rather than from what a caller believes a path returns.
   */
  const send = async <Op extends SyncOperation>(op: Op, argument: SyncArguments[Op]): Promise<SyncResults[Op]> => {
    const current = socket;
    if (current?.send === undefined || !state.connected) throw new SocketClosedError("not connected");
    counter += 1;
    const id = `r${counter}`;
    return new Promise<SyncResults[Op]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A request that never came back means the connection is not carrying traffic, whatever
        // its state says; dropping it forces a reconnect rather than waiting forever.
        reject(new SocketClosedError("request timed out"));
        current.close();
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        current.send?.(JSON.stringify({ id, op, ...argument }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new SocketClosedError("send failed"));
      }
    });
  };

  open();

  return {
    get connected() {
      return state.connected;
    },
    handshake: async (request: HandshakeRequest) =>
      await send("handshake", {
        schemaHash: request.schemaHash,
        schemaVersion: request.schemaVersion,
        lastServerSeq: request.lastServerSeq,
      }),
    push: async (_scopeId: ScopeId, ops: WeftOp[]) => await send("push", { ops }),
    pull: async (_scopeId: ScopeId, lastServerSeq: number) => await send("pull", { lastServerSeq }),
    // The relay sends the bytes and their digest; the records are read back out of them here,
    // which also checks the content address rather than taking it on trust.
    snapshot: async () => snapshotFromEnvelope(await send("snapshot", {})),
    close: () => {
      state.closed = true;
      if (retry !== undefined) clearTimeout(retry);
      failAll("closed by the client");
      setConnected(false);
      socket?.close();
      socket = undefined;
    },
  };
}
