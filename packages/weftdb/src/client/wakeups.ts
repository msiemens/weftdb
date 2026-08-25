// The client half of the wake-up channel. It carries no data: when the relay says a scope has
// moved, the client runs the same sync session it would have run on a timer. That keeps one
// code path responsible for correctness and makes the socket a latency improvement rather than
// a second way for state to arrive.
import type { ScopeId } from "weftdb/shared";
import { FIRST_RETRY_MS, nextRetryMs } from "./backoff.ts";

export interface ScopeAdvanced {
  readonly type: "advanced";
  readonly scopeId: ScopeId;
  readonly serverSeq: number;
}

/** The slice of the DOM `WebSocket` this needs, so a test can supply its own. */
export interface WebSocketLike {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: never) => void): void;
  /** Only the transport sends; a wake-up-only connection never says anything. */
  send?(data: string): void;
  close(): void;
  readonly readyState: number;
}

export type WebSocketFactory = (url: string, protocols: readonly string[]) => WebSocketLike;

export interface WakeupOptions {
  /** Where the relay's socket is mounted, e.g. `/wakeups` behind a dev-server proxy. */
  readonly url: string;
  readonly token: string;
  /** Called when the scope has moved, and again whenever the socket (re)connects. */
  readonly onWake: (advanced: ScopeAdvanced | undefined) => void;
  readonly onStatusChange?: (connected: boolean) => void;
  readonly WebSocket?: WebSocketFactory;
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: never) => void;
}

export const WAKEUP_PROTOCOL = "weft.v1";
export const TOKEN_PROTOCOL_PREFIX = "weft.token.";

export interface WakeupConnection {
  /** Whether a socket is currently open. A page shows this; the sync loop uses it to decide
   * whether it still needs to poll. */
  readonly connected: boolean;
  close(): void;
}

/**
 * Keeps a socket to the relay, reconnecting with backoff. Every connect fires `onWake` with no
 * argument: a socket that has just come up cannot know what happened while it was down, so the
 * client syncs once rather than assuming it missed nothing.
 */
export function connectWakeups(options: WakeupOptions): WakeupConnection {
  const factory = options.WebSocket ?? defaultFactory;
  const schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const cancel = options.clearTimeout ?? ((handle: never) => clearTimeout(handle));

  let socket: WebSocketLike | undefined;
  let retryMs = FIRST_RETRY_MS;
  let retry: unknown;
  let closed = false;
  const state = { connected: false };

  const setConnected = (connected: boolean): void => {
    if (state.connected === connected) return;
    state.connected = connected;
    options.onStatusChange?.(connected);
  };

  const open = (): void => {
    if (closed) return;
    let current: WebSocketLike;
    try {
      current = factory(options.url, [WAKEUP_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${options.token}`]);
    } catch {
      // A URL the environment will not open at all is the same as one that closed immediately.
      reconnect();
      return;
    }
    socket = current;

    current.addEventListener("open", () => {
      retryMs = FIRST_RETRY_MS;
      setConnected(true);
      // Whatever happened while the socket was down is unknown, so catch up once on connect.
      options.onWake(undefined);
    });

    current.addEventListener("message", (event: { readonly data: unknown }) => {
      const advanced = parseAdvanced(event.data);
      if (advanced !== undefined) options.onWake(advanced);
    });

    const dropped = (): void => {
      if (socket !== current) return;
      setConnected(false);
      reconnect();
    };
    current.addEventListener("close", dropped);
    current.addEventListener("error", dropped);
  };

  const reconnect = (): void => {
    if (closed) return;
    socket = undefined;
    if (retry !== undefined) cancel(retry as never);
    retry = schedule(open, retryMs);
    // Backing off keeps a relay that is down from being hammered by every open tab at once.
    retryMs = nextRetryMs(retryMs);
  };

  open();

  return {
    get connected() {
      return state.connected;
    },
    close: () => {
      closed = true;
      if (retry !== undefined) cancel(retry as never);
      setConnected(false);
      socket?.close();
      socket = undefined;
    },
  };
}

function parseAdvanced(data: unknown): ScopeAdvanced | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const message = JSON.parse(data) as Partial<ScopeAdvanced>;
    if (message.type !== "advanced" || typeof message.serverSeq !== "number" || message.scopeId === undefined) {
      return undefined;
    }
    return { type: "advanced", scopeId: message.scopeId, serverSeq: message.serverSeq };
  } catch {
    // A relay that speaks a dialect this build does not know is treated as a bare nudge by
    // the caller, not as a reason to tear the connection down.
    return undefined;
  }
}

const defaultFactory: WebSocketFactory = (url, protocols) =>
  new WebSocket(url, [...protocols]) as unknown as WebSocketLike;
