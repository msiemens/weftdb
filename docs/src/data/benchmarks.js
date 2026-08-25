/*
 * Figures from `bench/results.json`, generated 2026-08-24T21:56:32Z by `node bench/run.ts`. Each
 * `key` is the case id in that file, so a later run is spliced in by id rather than by position.
 * Medians, as the harness reports them; RESULTS.md carries the p95 and the conditions beside each.
 *
 * A metric with a null `value` renders as "not measured" rather than as a number.
 *
 * Carried over from `site/main.js`. It rendered these on load; the page component renders them
 * at build time now, so the only way a number appears is still for one to have been measured and
 * written in here — but a reader with JavaScript off sees them, and so does anything that reads
 * the page without running it.
 *
 * The page shows the figures and nothing about where they were taken. The machine, the p95 and
 * the conditions of each case live in RESULTS.md, and the header above is where this file
 * records which run it is quoting.
 */
export const BENCHMARKS = {
  measured: true,
  metrics: [
    {
      key: "local.update.lww",
      label: "for edits made in the app",
      value: "368,400",
      unit: "ops/s",
      note: "Typing never waits for a server to answer.",
    },
    {
      key: "sync.roundtrip.pushed",
      label: "until your change appears elsewhere",
      value: "0.16",
      unit: "ms",
      note: "Two windows open side by side feel like one.",
    },
    {
      key: "read.query.warm.10000",
      label: "to read a list of 10,000 items",
      value: "1.19",
      unit: "ms",
      note: "Long lists stay smooth to scroll and redraw.",
    },
    {
      key: "relay.push.ws.10000",
      label: "for changes sent once back online",
      value: "171,800",
      unit: "ops/s",
      note: "A long stretch offline clears in one go.",
    },
    {
      key: "snapshot.apply.1000",
      label: "to catch up on 1,000 items",
      value: "9.22",
      unit: "ms",
      note: "Opening the app somewhere new fills it in at once.",
    },
    {
      key: "persist.edit.1000",
      label: "to write one edit to disk",
      value: "1.00",
      unit: "ms",
      note: "Nothing is lost if the app closes or the tab reloads.",
    },
  ],
};
