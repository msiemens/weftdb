// Reconnection timing, shared by `connectWakeups` and `connectSocketTransport`. Both may hold a
// socket to the same relay, so the schedule belongs in one place: separate copies would let the
// two drift apart under a tuning change to either.
//
// Not in the package's exports map, so the schedule stays an implementation detail rather than
// something a caller can depend on.

/** The first wait after a connection drops. Short enough that a blip is invisible. */
export const FIRST_RETRY_MS = 500;

/**
 * The ceiling. A relay that has been down for a while is not helped by a client asking harder,
 * and a device that has been asleep should not return to a backlog of its own attempts.
 */
export const MAX_RETRY_MS = 30_000;

/** The next wait, doubling up to the ceiling. Reset to `FIRST_RETRY_MS` once a connection opens. */
export function nextRetryMs(current: number): number {
  return Math.min(current * 2, MAX_RETRY_MS);
}
