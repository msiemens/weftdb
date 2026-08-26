// The sync socket. It carries the protocol in both directions: the requests a session makes —
// answered by the same handler the HTTP surface uses, so there is one implementation and one
// place authorization is decided — and the relay's unsolicited "this scope is at sequence N",
// which a device answers with the sync it would otherwise have run on a timer.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ScopeId } from "weftdb/core";
import { requiredCount, requiredOps } from "./relay.ts";
import type { AuthContext, SyncArguments, SyncOperation, SyncOperations, SyncResults, TokenVerifier } from "./relay.ts";
import {
  CLOSE,
  decodeFrame,
  encodeClose,
  encodeFrame,
  encodeText,
  MAX_PAYLOAD_BYTES,
  OPCODE,
  type Frame,
  type Opcode,
} from "./websocket-frames.ts";

/** RFC 6455's fixed handshake salt. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PROTOCOL = "weft.v1";
const TOKEN_PROTOCOL_PREFIX = "weft.token.";

/** Sent when a scope moves and this connection has not said where its cursor is. */
export interface ScopeAdvanced {
  readonly type: "advanced";
  readonly scopeId: ScopeId;
  readonly serverSeq: number;
}

/**
 * Sent when a scope moves and this connection has subscribed with a cursor: the records it is
 * missing, rather than a note telling it to ask. A device learns about a change in one message
 * instead of two, and the batch goes through the client's ordinary pull path — it is the same
 * batch the same `/pull` would have answered with, delivered without being asked.
 */
export interface ScopeBatch {
  readonly type: "batch";
  readonly batch: unknown;
}

/** What a client sends to start receiving batches, and to say where it has got to. */
export interface SubscribeRequest {
  readonly type: "subscribe";
  readonly lastServerSeq: number;
}

/**
 * A request carried on the socket. It names the operation it wants — the socket reaches the
 * protocol directly rather than describing a route for someone to fetch, so there is no method,
 * no path and no query string to parse on a connection that has none of those things. The four
 * shapes are the protocol's four calls, and they are carried out by the same `SyncOperations`
 * the HTTP surface calls.
 */
export type SocketRequest = {
  readonly [Op in SyncOperation]: { readonly id: string; readonly op: Op } & SyncArguments[Op];
}[SyncOperation];

export type SocketResponse = {
  readonly [Op in SyncOperation]: {
    readonly type: "response";
    readonly id: string;
    readonly op: Op;
    readonly result: SyncResults[Op];
  };
}[SyncOperation];

/** A request that could not be carried out. Nothing on a socket has a status code. */
export interface SocketFailure {
  readonly type: "failure";
  readonly id: string;
  readonly reason: string;
}

/**
 * A large answer — a snapshot, mostly — goes out in pieces so that everything else has a turn
 * between them. One socket carries every request and every wake-up, and a megabyte written in
 * one go is a megabyte during which nothing else on that connection moves.
 */
export interface SocketChunk {
  readonly type: "chunk";
  readonly id: string;
  readonly index: number;
  readonly last: boolean;
  /** A slice of the JSON result; the pieces concatenate back into it exactly. */
  readonly data: string;
  /** Set when the pieces reassemble into an unsolicited batch rather than an answer. */
  readonly for?: "batch";
}

/** Big enough that ordinary answers are never split, small enough to yield often. */
export const CHUNK_BYTES = 32 * 1024;

export interface SyncSocketOptions {
  readonly verifier: TokenVerifier;
  /** The protocol's four calls, so one connection carries whole sync sessions. */
  readonly operations: SyncOperations;
  /** Reads what a scope has beyond a cursor, which is what a subscribed connection is sent. */
  readonly pull: (scopeId: ScopeId, lastServerSeq: number) => { readonly serverSeq: number };
  /**
   * How often to ping. A connection dropped by an idle middlebox looks exactly like a healthy
   * one until something is written to it, so the server writes something on purpose.
   */
  readonly keepaliveMs?: number;
}

/** Long enough that a normal connection is never mistaken for a dead one. */
export const DEFAULT_KEEPALIVE_MS = 30_000;

interface Subscriber {
  readonly id: string;
  /** Settled at the upgrade; every request on this connection is carried out under it. */
  readonly auth: AuthContext;
  readonly socket: Duplex;
  alive: boolean;
  /**
   * How far this connection has been sent, once it has asked for batches. Undefined means it
   * has not, so it is told that the scope moved and fetches for itself.
   */
  cursor: number | undefined;
  /**
   * A message being delivered across several frames. RFC 6455 lets a peer split a data frame
   * wherever it likes, and browsers do — so a hub that only ever read whole frames would leave
   * a fragmented request unanswered and the client waiting on a reply that is never coming.
   */
  fragment: { opcode: Opcode; chunks: Buffer[]; bytes: number } | undefined;
}

/**
 * Who is listening to what. A subscriber is bound to the scope its token names, so a broadcast
 * cannot reach anyone the token would not have let in through the HTTP surface either.
 */
export class SyncSocketHub {
  readonly #subscribers = new Map<string, Subscriber>();
  readonly #verifier: TokenVerifier;
  readonly #keepaliveMs: number;
  readonly #operations: SyncOperations;
  readonly #pull: SyncSocketOptions["pull"];
  #keepalive: ReturnType<typeof setInterval> | undefined;

  constructor(options: SyncSocketOptions) {
    this.#verifier = options.verifier;
    this.#keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.#operations = options.operations;
    this.#pull = options.pull;
  }

  /**
   * One round of the keepalive: anything that has not answered the previous ping is gone, and
   * everyone else is pinged and marked unanswered until they say otherwise.
   */
  sweep(): void {
    for (const subscriber of [...this.#subscribers.values()]) {
      if (!subscriber.alive) {
        this.#drop(subscriber, CLOSE.goingAway, "no response to keepalive");
        continue;
      }
      subscriber.alive = false;
      try {
        subscriber.socket.write(encodeFrame(OPCODE.ping, Buffer.alloc(0)));
      } catch {
        this.#drop(subscriber, CLOSE.internal, "socket error");
      }
    }
  }

  #startKeepalive(): void {
    if (this.#keepalive !== undefined || this.#keepaliveMs <= 0) return;
    this.#keepalive = setInterval(() => this.sweep(), this.#keepaliveMs);
    // A relay with no subscribers should still be able to exit.
    (this.#keepalive as { unref?: () => void }).unref?.();
  }

  #stopKeepalive(): void {
    if (this.#keepalive === undefined || this.#subscribers.size > 0) return;
    clearInterval(this.#keepalive);
    this.#keepalive = undefined;
  }

  get size(): number {
    return this.#subscribers.size;
  }

  /** Everyone currently listening to a scope, for tests and for shutdown accounting. */
  subscribers(scopeId: ScopeId): number {
    return [...this.#subscribers.values()].filter((subscriber) => subscriber.auth.scopeId === scopeId).length;
  }

  /**
   * Completes the upgrade, or refuses it. Browsers cannot set headers on a WebSocket, so the
   * token rides in the subprotocol list rather than the query string, where it would land in
   * every access log between here and the client.
   */
  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const key = request.headers["sec-websocket-key"];
    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const token = offered.find((value) => value.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length);

    if (typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return refuse(socket, "400 Bad Request");
    }
    if (!offered.includes(PROTOCOL) || token === undefined) return refuse(socket, "400 Bad Request");
    const auth = await this.#verifier.verify(token);
    if (auth === undefined) return refuse(socket, "401 Unauthorized");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept(key)}`,
        // Only the version is echoed: a server must not echo a subprotocol it was not offered,
        // and echoing the token back would put it somewhere it does not need to be.
        `Sec-WebSocket-Protocol: ${PROTOCOL}`,
        "\r\n",
      ].join("\r\n"),
    );

    // The token is not kept: it was a way to establish who this is, and that is now settled.
    this.#attach({ id: randomUUID(), auth, socket, alive: true, cursor: undefined, fragment: undefined }, head);
    return true;
  }

  /**
   * Tells everyone attached to this scope what changed. A connection that has subscribed with a
   * cursor is sent the records it is missing; one that has not is told the scope moved and
   * fetches for itself.
   */
  advanced(scopeId: ScopeId, serverSeq: number): void {
    const announcement = encodeText(JSON.stringify({ type: "advanced", scopeId, serverSeq } satisfies ScopeAdvanced));
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.auth.scopeId !== scopeId) continue;
      if (subscriber.cursor === undefined) {
        subscriber.socket.write(announcement);
        continue;
      }
      this.#sendBatch(subscriber, scopeId, subscriber.cursor);
    }
  }

  /**
   * Sends what a connection is missing and records how far it has been sent. The cursor moves
   * on the send rather than on an acknowledgement: a socket that dies before the batch lands
   * takes the record of it with it, and the client re-subscribes from where it really is.
   */
  #sendBatch(subscriber: Subscriber, scopeId: ScopeId, from: number): void {
    const batch = this.#pull(scopeId, from);
    // How far the scope has actually reached, not how far the client claimed to be. Keeping the
    // higher of the two would preserve a cursor beyond the end of the scope, and every batch
    // after it would be empty for as long as the connection lasted.
    subscriber.cursor = batch.serverSeq;
    const message: ScopeBatch = { type: "batch", batch };
    const encoded = JSON.stringify(message);
    if (encoded.length <= CHUNK_BYTES) {
      subscriber.socket.write(encodeText(encoded));
      return;
    }
    // A batch big enough to block the connection goes out in pieces like any other answer,
    // under an id nothing is waiting on.
    void this.#writeChunks(subscriber, `batch-${subscriber.cursor}`, JSON.stringify(batch), true);
  }

  /** Drops every connection. Called when the relay closes, so no socket outlives its server. */
  close(): void {
    for (const subscriber of [...this.#subscribers.values()]) {
      this.#drop(subscriber, CLOSE.goingAway, "server shutting down");
    }
    if (this.#keepalive !== undefined) clearInterval(this.#keepalive);
    this.#keepalive = undefined;
  }

  #attach(subscriber: Subscriber, head: Buffer): void {
    this.#subscribers.set(subscriber.id, subscriber);
    this.#startKeepalive();
    // TCP splits wherever it likes, so bytes accumulate here until a whole frame is present.
    let pending: Buffer = Buffer.from(head);

    subscriber.socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const read = decodeFrame(pending, true);
        if (read.status === "partial") return;
        if (read.status === "invalid") {
          this.#drop(subscriber, CLOSE.protocolError, read.reason);
          return;
        }
        pending = read.rest;
        if (!this.#handle(subscriber, read.frame)) return;
      }
    });

    const forget = (): void => {
      this.#subscribers.delete(subscriber.id);
      this.#stopKeepalive();
    };
    subscriber.socket.on("close", forget);
    subscriber.socket.on("end", forget);
    // A dead peer must not take the process with it: the socket is simply gone.
    subscriber.socket.on("error", () => this.#drop(subscriber, CLOSE.internal, "socket error"));
  }

  /** Returns false when the connection is finished and the read loop should stop. */
  #handle(subscriber: Subscriber, frame: Frame): boolean {
    const { opcode, payload, fin } = frame;
    if (opcode === OPCODE.close) {
      this.#drop(subscriber, CLOSE.normal, "");
      return false;
    }
    // Control frames are answered where they arrive: they are never fragmented, and they may sit
    // between the pieces of a message that is.
    if (opcode === OPCODE.ping) {
      subscriber.socket.write(encodeFrame(OPCODE.pong, payload));
      return true;
    }
    if (opcode === OPCODE.pong) {
      subscriber.alive = true;
      return true;
    }

    // Anything from the peer says the connection is alive, whatever else it says.
    subscriber.alive = true;
    const assembled = this.#assemble(subscriber, opcode, payload, fin);
    if (assembled === "invalid") return false;
    if (assembled === undefined) return true;
    if (assembled.opcode === OPCODE.text) this.#serve(subscriber, assembled.payload);
    return true;
  }

  /**
   * Gathers a message that arrived in pieces. Returns the whole message once the final frame is
   * in, undefined while more is expected, and "invalid" when the connection has been dropped for
   * breaking the framing rules.
   */
  #assemble(
    subscriber: Subscriber,
    opcode: Opcode,
    payload: Buffer,
    fin: boolean,
  ): { readonly opcode: Opcode; readonly payload: Buffer } | undefined | "invalid" {
    const started = subscriber.fragment;
    if (opcode === OPCODE.continuation) {
      if (started === undefined) {
        this.#drop(subscriber, CLOSE.protocolError, "continuation frame with nothing to continue");
        return "invalid";
      }
      if (started.bytes + payload.length > MAX_PAYLOAD_BYTES) {
        this.#drop(subscriber, CLOSE.tooLarge, "fragmented message exceeds the payload limit");
        return "invalid";
      }
      started.chunks.push(payload);
      started.bytes += payload.length;
      if (!fin) return undefined;
      subscriber.fragment = undefined;
      return { opcode: started.opcode, payload: Buffer.concat(started.chunks) };
    }

    if (started !== undefined) {
      this.#drop(subscriber, CLOSE.protocolError, "a new message began before the last one finished");
      return "invalid";
    }
    if (fin) return { opcode, payload };
    subscriber.fragment = { opcode, chunks: [payload], bytes: payload.length };
    return undefined;
  }

  /**
   * Carries out a request that arrived on the socket. The connection was authenticated once, at
   * the upgrade, and its `AuthContext` decides the scope for everything that follows — so a
   * request names what it wants and nothing about who is asking.
   */
  #serve(subscriber: Subscriber, payload: Buffer): void {
    let message: Partial<SocketRequest & SubscribeRequest>;
    try {
      message = JSON.parse(payload.toString("utf8")) as Partial<SocketRequest & SubscribeRequest>;
    } catch {
      return;
    }

    if (message.type === "subscribe") {
      // The client says where it has got to, and everything from there on arrives without
      // being asked for. It is sent immediately as well: whatever moved while it was away is
      // exactly what it does not know it is missing.
      //
      // A subscription is the only request whose argument outlives it, so a cursor that is not a
      // sequence number is a connection that stays open and silently receives nothing for as long
      // as it lasts, with nothing to tell it so. `Infinity` and `NaN` fall back to the start of
      // the scope, which sends more than the client needed rather than less; a cursor merely
      // ahead of the relay is brought back by the batch that follows, which records how far the
      // scope has actually reached.
      const claimed = message.lastServerSeq;
      const from = typeof claimed === "number" && Number.isSafeInteger(claimed) && claimed >= 0 ? claimed : 0;
      subscriber.cursor = from;
      this.#sendBatch(subscriber, subscriber.auth.scopeId, from);
      return;
    }

    if (typeof message.id !== "string") return;
    const id = message.id;

    try {
      const result = this.#carryOut(this.#operations, subscriber.auth, message);
      const encoded = JSON.stringify(result ?? null);
      if (encoded.length <= CHUNK_BYTES) {
        subscriber.socket.write(encodeText(JSON.stringify({ type: "response", id, op: message.op, result })));
        return;
      }
      // Written across several turns of the event loop, so a wake-up or another device's
      // answer can go out between the pieces instead of queueing behind all of it.
      void this.#writeChunks(subscriber, id, encoded);
    } catch (error) {
      const failure: SocketFailure = {
        type: "failure",
        id,
        reason: error instanceof Error ? error.message : "the request could not be carried out",
      };
      try {
        subscriber.socket.write(encodeText(JSON.stringify(failure)));
      } catch {
        // The peer is gone; the read side will notice and clean up.
      }
    }
  }

  /** Names an operation, or refuses to guess at one. */
  #carryOut(
    operations: SyncOperations,
    auth: AuthContext,
    message: Partial<SocketRequest>,
  ): SyncResults[SyncOperation] {
    switch (message.op) {
      case "handshake": {
        const schemaHash = required(message.schemaHash, "schemaHash");
        if (typeof schemaHash !== "string" || schemaHash.length === 0)
          throw new Error("schemaHash must be a non-empty string");
        return operations.handshake(auth, {
          schemaHash,
          schemaVersion: requiredCount(message.schemaVersion, "schemaVersion", 1),
          lastServerSeq: requiredCount(message.lastServerSeq, "lastServerSeq", 0),
        });
      }
      case "push": {
        return operations.push(auth, { ops: [...requiredOps(message.ops)] });
      }
      case "pull": {
        return operations.pull(auth, { lastServerSeq: requiredCount(message.lastServerSeq, "lastServerSeq", 0) });
      }
      case "snapshot": {
        return operations.snapshot(auth, {});
      }
      default: {
        throw new Error(`unknown operation: ${String(message.op)}`);
      }
    }
  }

  async #writeChunks(subscriber: Subscriber, id: string, encoded: string, forBatch = false): Promise<void> {
    const total = Math.ceil(encoded.length / CHUNK_BYTES);
    for (let index = 0; index < total; index += 1) {
      // The subscriber going away mid-answer is ordinary; the rest simply is not sent.
      if (!this.#subscribers.has(subscriber.id)) return;
      const chunk: SocketChunk = {
        type: "chunk",
        id,
        index,
        last: index === total - 1,
        data: encoded.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
        // Says what the pieces are for, because nothing is waiting on an id for a batch
        // nobody asked for.
        ...(forBatch ? { for: "batch" as const } : {}),
      };
      try {
        subscriber.socket.write(encodeText(JSON.stringify(chunk)));
      } catch {
        return;
      }
      // Yielding is the whole point: it is what lets anything else reach the socket.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  #drop(subscriber: Subscriber, code: number, reason: string): void {
    if (!this.#subscribers.delete(subscriber.id)) return;
    this.#stopKeepalive();
    try {
      subscriber.socket.write(encodeClose(code, reason));
    } catch {
      // The socket is already gone, which is the state this close is reaching for.
    }
    subscriber.socket.destroy();
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function accept(key: string): string {
  return createHash("sha1").update(`${key}${GUID}`).digest("base64");
}

function refuse(socket: Duplex, status: string): boolean {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
  return false;
}

export { PROTOCOL as WAKEUP_PROTOCOL, TOKEN_PROTOCOL_PREFIX };
