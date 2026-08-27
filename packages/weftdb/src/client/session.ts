// Everything an application has to do to keep a client in touch with a relay, once. Syncing on
// a timer, syncing again a moment after a local change, preferring the socket while it is up
// and HTTP when it is not, telling the other tabs in this browser, and publishing a status
// object stable enough for `useSyncExternalStore` to compare. None of that is specific to a
// schema or an application, and every application writing it again writes the same bugs into
// it: a status object rebuilt on every read, a channel closed by a cleanup that runs twice, a
// poll that never stops.
import type { SchemaHash } from "weftdb/core";
import type { PullBatch } from "weftdb/server";
import type { WeftClient } from "./index.ts";
import type { AsyncSyncTransport } from "./transport.ts";
import type { SocketTransport } from "./socket-transport.ts";

export interface SessionStatus {
  /** Whether this device is trying to reach the relay at all. */
  readonly online: boolean;
  readonly syncing: boolean;
  /** Local work the server has not acknowledged. */
  readonly pending: number;
  readonly quarantined: number;
  readonly quarantineReasons: readonly string[];
  readonly cursor: number;
  readonly lastError: string | undefined;
  readonly lastSyncedAt: number | undefined;
  /** Whether the relay is telling this device when to sync, or it is back to asking. */
  readonly live: boolean;
}

/** Nudges the other tabs in this browser, which a relay has no reason to know about. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface SessionOptions {
  readonly client: WeftClient;
  readonly schemaHash: SchemaHash;
  /** Used whenever the socket is not up, running the same session over HTTP. */
  readonly transport: AsyncSyncTransport;
  /** Opened by `start` and closed by its cleanup, so a reconnect is the session's business. */
  readonly openSocket?: (handlers: SocketHandlers) => SocketTransport;
  readonly channel?: BroadcastChannelLike | undefined;
  /** Told whenever anything a view reads has moved. */
  readonly onChange?: () => void;
  readonly pollWhileLiveMs?: number;
  readonly pollWhileBlindMs?: number;
  readonly debounceMs?: number;
  readonly now?: () => number;
}

export interface SocketHandlers {
  /** The relay says the scope moved and this client should catch up. */
  readonly onWake: () => void;
  /**
   * The relay sent what changed; it is applied through the ordinary pull path, and the promise
   * settles once it has been committed.
   */
  readonly onBatch: (batch: PullBatch) => Promise<void>;
  readonly onStatusChange: () => void;
  /** Where this client has got to, so the relay can send what it is missing. */
  readonly cursor: () => number;
}

/** Long, because a socket that is up says when to sync and the timer is only a safety net. */
const LIVE_POLL_MS = 60_000;
const BLIND_POLL_MS = 3_000;
const DEBOUNCE_MS = 150;

export class WeftSession {
  readonly client: WeftClient;
  #options: SessionOptions;
  #status: SessionStatus;
  #listeners = new Set<() => void>();
  #socket: SocketTransport | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #online = true;
  #syncing = false;
  #queued = false;
  #lastError: string | undefined;
  #lastSyncedAt: number | undefined;
  /** What is currently allowed to touch the client. See `#alone`. */
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: SessionOptions) {
    this.#options = options;
    this.client = options.client;
    this.#status = this.#read();
    options.channel?.addEventListener("message", () => {
      // Another tab pushed something, so pull it now.
      void this.sync();
    });
  }

  /**
   * Opens the socket and starts the fallback timer. The returned function stops both, but not
   * the channel. The channel belongs to the session, and an effect that runs twice (as React's
   * do in development) would otherwise leave the second run posting to a closed one.
   */
  start(): () => void {
    if (this.#options.openSocket !== undefined) {
      this.#socket = this.#options.openSocket({
        onWake: () => void this.sync(),
        onBatch: (batch) =>
          this.#alone(async () => {
            await this.client.applyPull(batch);
            this.#changed(false);
          }),
        onStatusChange: () => {
          this.#publish();
          this.#restartTimer();
        },
        cursor: () => this.client.lastServerSeq,
      });
    }
    void this.sync();
    this.#restartTimer();
    return () => {
      if (this.#timer !== undefined) clearInterval(this.#timer);
      if (this.#debounce !== undefined) clearTimeout(this.#debounce);
      this.#socket?.close();
      this.#socket = undefined;
    };
  }

  /** Releases what outlives `start`, for a caller that is finished with this session. */
  dispose(): void {
    this.#options.channel?.close();
  }

  status(): SessionStatus {
    return this.#status;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get online(): boolean {
    return this.#online;
  }

  setOnline(online: boolean): void {
    this.#online = online;
    this.#publish();
    if (online) void this.sync();
  }

  /** Drops this device's diverged work and re-derives the rows from the server (§5.5). */
  async discardQuarantine(): Promise<void> {
    await this.#alone(async () => {
      for (const transaction of new Set(this.client.listQuarantine().map((op) => op.txnId))) {
        await this.client.discardQuarantinedTxn(transaction);
      }
    });
    this.changed();
  }

  async sync(): Promise<void> {
    if (!this.#online) return;
    if (this.#syncing) {
      // A session is already in flight; remember that more work arrived behind it.
      this.#queued = true;
      return;
    }
    this.#syncing = true;
    this.#publish();
    try {
      // The socket while it is up, HTTP when it is not. Both run the same session; only the
      // way the four calls travel differs.
      const transport = this.#socket?.connected === true ? this.#socket : this.#options.transport;
      await this.#alone(() => this.client.syncWith(transport, this.#options.schemaHash));
      this.#lastError = undefined;
      this.#lastSyncedAt = (this.#options.now ?? Date.now)();
    } catch (error) {
      // A relay that cannot be reached is an ordinary state for a local-first application. The
      // work stays in the outbox and the page keeps taking edits.
      this.#lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.#syncing = false;
      this.#options.onChange?.();
      this.#publish();
    }
    if (this.#queued) {
      this.#queued = false;
      await this.sync();
    }
  }

  /**
   * Runs one piece of work against the client at a time.
   *
   * Applying a batch and running a sync both read the outbox, rebase against it and write the
   * result through, and neither can be suspended half way through and resumed against a client the
   * other has moved. A subscribed socket routinely delivers a batch while the sync that provoked it
   * is still draining the outbox, so the two overlap in ordinary use.
   */
  #alone<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.#serial.then(work, work);
    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Called after a local change: tell this tab's views, then the relay, then the other tabs. */
  changed(): void {
    this.#changed(true);
  }

  #changed(push: boolean): void {
    this.#options.onChange?.();
    this.#publish();
    if (!push) return;
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      void this.sync().then(() => this.#nudge());
    }, this.#options.debounceMs ?? DEBOUNCE_MS);
  }

  #nudge(): void {
    try {
      this.#options.channel?.postMessage({ at: (this.#options.now ?? Date.now)() });
    } catch {
      // A channel can be closed underneath this by a page being torn down. A nudge that does
      // not land costs the other tabs a poll, which is what they do anyway.
    }
  }

  #restartTimer(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    const live = this.#socket?.connected === true;
    const interval = live
      ? (this.#options.pollWhileLiveMs ?? LIVE_POLL_MS)
      : (this.#options.pollWhileBlindMs ?? BLIND_POLL_MS);
    this.#timer = setInterval(() => void this.sync(), interval);
    // Browsers have no `unref`; Node does, and a poll loop that keeps the process alive turns
    // a test that forgets to stop a session into a hang instead of a clean failure.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  #read(): SessionStatus {
    const quarantined = this.client.listQuarantine();
    return {
      online: this.#online,
      syncing: this.#syncing,
      pending: this.client.outbox.length,
      quarantined: quarantined.length,
      quarantineReasons: [...new Set(quarantined.map((op) => op.reason))].sort(),
      cursor: this.client.lastServerSeq,
      lastError: this.#lastError,
      lastSyncedAt: this.#lastSyncedAt,
      live: this.#socket?.connected === true,
    };
  }

  #publish(): void {
    // A fresh object every time would defeat `useSyncExternalStore`, which compares what it is
    // given by identity, so the status is replaced only when something in it moved.
    const next = this.#read();
    if (sameStatus(this.#status, next)) return;
    this.#status = next;
    for (const listener of this.#listeners) listener();
  }
}

function sameStatus(left: SessionStatus, right: SessionStatus): boolean {
  return (
    left.online === right.online &&
    left.syncing === right.syncing &&
    left.pending === right.pending &&
    left.quarantined === right.quarantined &&
    left.quarantineReasons.join() === right.quarantineReasons.join() &&
    left.cursor === right.cursor &&
    left.lastError === right.lastError &&
    left.lastSyncedAt === right.lastSyncedAt &&
    left.live === right.live
  );
}
