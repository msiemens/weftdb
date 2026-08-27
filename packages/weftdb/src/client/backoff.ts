// Reconnection timing for a client's socket to the relay.
//
// Not in the package's exports map, so the schedule stays an implementation detail a caller
// cannot depend on.

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
