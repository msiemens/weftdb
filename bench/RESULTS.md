# weftdb benchmarks

Generated 2026-08-24T21:56:32.736Z by `node bench/run.ts`, in 68.0s.

| Machine  |                                                   |
| -------- | ------------------------------------------------- |
| CPU      | Intel(R) Core(TM) Ultra 7 265H (16 logical cores) |
| Memory   | 31.4 GiB                                          |
| Platform | win32 x64                                         |
| Node     | v24.9.0 (V8 13.6.233.10-node.27)                  |

## Headline

| Measurement                                          |        Median |           p95 | Iterations | What is measured                                                                                              |
| ---------------------------------------------------- | ------------: | ------------: | ---------: | ------------------------------------------------------------------------------------------------------------- |
| Local create (row with six fields)                   | 138,900 ops/s | 111,700 ops/s |         25 | 500 creates per sample into a fresh in-memory client; each create enqueues 10 protocol ops                    |
| Local update, last-writer-wins field                 | 368,400 ops/s | 202,600 ops/s |         25 | 200 updates per sample across distinct rows of a 1000-row client with a drained outbox                        |
| Query 10,000 rows, unchanged (cached result)         |       1.19 ms |       1.71 ms |         25 | the subscription engine still filters and sorts every row before it can tell the result is unchanged          |
| Edit visible on a second device, pushed by the relay |      0.162 ms |      0.282 ms |        200 | device B is subscribed with a cursor, so the relay sends the batch unasked; timing ends when B has applied it |
| Edit visible on a second device over HTTP            |       2.25 ms |       3.79 ms |        200 | device A runs a full session (handshake, push, pull) and then device B does; five requests in all             |
| Push 10,000 ops over HTTP                            | 167,400 ops/s | 122,500 ops/s |         30 | one push of a 10000-op outbox into a fresh in-memory scope, over 127.0.0.1                                    |
| Apply a 1,000-row snapshot to an empty device        |       9.22 ms |      10.21 ms |         25 | every record is folded into the local store and into the device's clock                                       |
| One edit with a 1,000-row store attached             |       1.00 ms |       1.50 ms |         20 | a single field update, including the durable write it triggers                                                |

## Methodology

Every case times its own critical section with `performance.now()`; whatever it takes to set the
case up — seeding a client, starting a relay, opening a database — happens outside that region and
is not counted. Each case runs a number of warmup samples that are measured and thrown away, then
the sampled iterations reported in the table.

`median` and `p95` are nearest-rank percentiles of the samples, with no interpolation, so both are
measurements that actually happened rather than an average of two that did. Where the unit is a
rate, the rate is derived from the duration distribution: `median` is the rate at the median
duration and **`p95` is the rate at the 95th-percentile — that is, the slowest — duration**. For a
rate, therefore, p95 is the pessimistic tail and is always the lower of the two numbers.

There is no benchmarking library here. The repository takes no runtime dependencies, runs its tests
on `node:test` and its storage on `node:sqlite`, and a benchmark suite is not the place to break
that; the run must also work with no network access at all. What a library would have added over
this harness is adaptive sample counts and calibrated subtraction of its own overhead. Instead the
overhead is measured and published — see _Cost of one empty timed region_ under Harness. Every
duration reported elsewhere is orders of magnitude above it, so nothing here is the timer.

The suite is self-contained: no fixture the repository does not carry, and no network traffic that
leaves `127.0.0.1`. Relays are started on an ephemeral loopback port with their keepalive turned
off, so no ping timer can fire inside a timed region. SQLite cases run against real files under the
OS temp directory, which are deleted when the group ends.

Sizes are sanity checks as much as data points: a case measured at 100, 1,000 and 10,000 rows is one
whose cost can be seen to scale with its input rather than with the harness.

Running the whole suite twice on this machine moves the typical median by about 5%. The cases whose
sample lasts only a millisecond or two — the smallest relay batches — move by more than that, and
their p95 says more about how the host scheduled the process than about the relay. Quote the median.

## What these numbers do not mean

- **Loopback is not the internet.** Every relay number here was taken over `127.0.0.1`, where a
  round trip costs tens of microseconds. Real devices are separated by tens of milliseconds of
  network that this suite cannot and does not measure. Read the sync numbers as _the cost weftdb
  adds to a round trip_, never as the round trip.
- **One relay process is not a cluster.** The relay measured here is a single Node process serving
  a single scope with no other traffic on it. Nothing here says what happens under concurrent load,
  across several scopes, or behind a load balancer — and the relay is documented as single-process:
  several sharing a database would need the scope advance to travel between them, which is not
  built.
- **In-memory is not durable.** Except in the Durable relay group, the relay keeps its state in
  memory. The durable numbers are the honest ones for a deployment that must survive a power cut,
  and they are much slower, because a push is committed with `synchronous = FULL` before it is
  acknowledged.
- **One machine, one process, one run.** These are medians from one process on the machine named
  above, with V8 warm and garbage collection left to itself. Another machine, another Node version
  or a laptop on battery will produce different numbers.
- **Byte sizes are uncompressed.** Snapshot sizes are the bytes the protocol produces. Nothing here
  measures transfer encoding, and a relay behind gzip or brotli would send considerably less.
- **The dataset is one shape.** Every row is a demo todo: six fields, an eight-line prose note, a
  string rank. A schema with wider rows, larger values or many collections will not match these
  numbers.
- **Convergence excludes startup.** The convergence clock starts at the first edit and stops when
  every device holds identical state; starting the relay and opening the transports is setup and is
  not in the number.
- **Convergence is quantised.** Devices settle in whole sync rounds, so a history that needs one
  more round than the last costs a whole round more. That is why the disjoint convergence cases have
  a much wider median-to-p95 spread than anything else here; it is the shape of the workload, not
  jitter.
- **A 100-op relay batch is too small to time well.** That sample is around two milliseconds, so a
  single scheduling hiccup on the host dominates its p95. It is published because the three sizes
  together show how per-request overhead is amortised, not because its tail means anything.

## All results

### Harness

| Measurement                    |       Median |          p95 | Iterations | What is measured                                                                |
| ------------------------------ | -----------: | -----------: | ---------: | ------------------------------------------------------------------------------- |
| Cost of one empty timed region | 0.0000835 ms | 0.0000888 ms |         25 | two performance.now() calls and a subtraction, averaged over 100,000 per sample |

### Local writes

| Measurement                                |        Median |           p95 | Iterations | What is measured                                                                           |
| ------------------------------------------ | ------------: | ------------: | ---------: | ------------------------------------------------------------------------------------------ |
| Local create (row with six fields)         | 138,900 ops/s | 111,700 ops/s |         25 | 500 creates per sample into a fresh in-memory client; each create enqueues 10 protocol ops |
| Local update, last-writer-wins field       | 368,400 ops/s | 202,600 ops/s |         25 | 200 updates per sample across distinct rows of a 1000-row client with a drained outbox     |
| Local update, diff3 prose field            | 148,900 ops/s |  65,760 ops/s |         25 | 200 updates per sample across distinct rows of a 1000-row client with a drained outbox     |
| Local update with 0 unsent ops queued      | 377,900 ops/s | 287,900 ops/s |         25 | 50 updates per sample to one field of a synced row, behind 0 unsent ops                    |
| Local update with 1,000 unsent ops queued  | 330,300 ops/s | 119,200 ops/s |         25 | 50 updates per sample to one field of a synced row, behind 1000 unsent ops                 |
| Local update with 10,000 unsent ops queued | 296,700 ops/s | 179,200 ops/s |         25 | 50 updates per sample to one field of a synced row, behind 10000 unsent ops                |

### Local reads

| Measurement                                  |    Median |       p95 | Iterations | What is measured                                                                                         |
| -------------------------------------------- | --------: | --------: | ---------: | -------------------------------------------------------------------------------------------------------- |
| Query 100 rows, unchanged (cached result)    | 0.0172 ms | 0.0377 ms |         25 | the subscription engine still filters and sorts every row before it can tell the result is unchanged     |
| Query 100 rows, cold engine                  | 0.0572 ms | 0.0731 ms |         25 | a fresh subscription engine per sample, so every row is filtered, sorted and materialized                |
| Re-query 100 rows after one row changed      | 0.0265 ms | 0.0637 ms |         25 | the cached result no longer matches, so the engine rebuilds the result and computes the delta against it |
| listRows over 100 rows                       | 0.0404 ms | 0.0649 ms |         25 | every row is copied into a fresh materialized row, with no identity cache in the way                     |
| Query 1,000 rows, unchanged (cached result)  | 0.0857 ms |  0.205 ms |         25 | the subscription engine still filters and sorts every row before it can tell the result is unchanged     |
| Query 1,000 rows, cold engine                |  0.521 ms |  0.623 ms |         25 | a fresh subscription engine per sample, so every row is filtered, sorted and materialized                |
| Re-query 1,000 rows after one row changed    |  0.181 ms |  0.222 ms |         25 | the cached result no longer matches, so the engine rebuilds the result and computes the delta against it |
| listRows over 1,000 rows                     |  0.374 ms |  0.457 ms |         25 | every row is copied into a fresh materialized row, with no identity cache in the way                     |
| Query 10,000 rows, unchanged (cached result) |   1.19 ms |   1.71 ms |         25 | the subscription engine still filters and sorts every row before it can tell the result is unchanged     |
| Query 10,000 rows, cold engine               |   8.79 ms |  14.80 ms |         25 | a fresh subscription engine per sample, so every row is filtered, sorted and materialized                |
| Re-query 10,000 rows after one row changed   |   5.23 ms |   8.60 ms |         25 | the cached result no longer matches, so the engine rebuilds the result and computes the delta against it |
| listRows over 10,000 rows                    |   4.32 ms |   5.54 ms |         25 | every row is copied into a fresh materialized row, with no identity cache in the way                     |

### Merge

| Measurement                                     |        Median |           p95 | Iterations | What is measured                                                          |
| ----------------------------------------------- | ------------: | ------------: | ---------: | ------------------------------------------------------------------------- |
| diff3 prose merge, disjoint edits               | 384,200 ops/s | 311,500 ops/s |         25 | 20-line document, one line changed on each side, 2000 merges per sample   |
| diff3 prose merge, conflicting edits            | 397,600 ops/s | 348,000 ops/s |         25 | 20-line document, one line changed on each side, 2000 merges per sample   |
| Last-writer-wins field write through the server | 965,000 ops/s | 426,300 ops/s |         25 | 2000 single-op pushes per sample against an in-process server, no network |

### Snapshot

| Measurement                                   |       Median |          p95 | Iterations | What is measured                                                                                                                               |
| --------------------------------------------- | -----------: | -----------: | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Build a snapshot of 100 rows                  |   0.00880 ms |    0.0218 ms |         25 | the server scans every record it holds and keeps the ones in this scope; it holds one scope here, so the scan and the answer are the same size |
| Order and encode a 100-row snapshot           |      1.28 ms |      2.89 ms |         20 | records are sorted into key order and written as NDJSON; no digest is taken                                                                    |
| Digest a 100-row snapshot body                |      1.06 ms |      1.61 ms |         20 | SHA-256 in portable TypeScript, so that a browser client and a Node relay agree without either taking a dependency                             |
| Content-address a 100-row snapshot            |      2.82 ms |      3.19 ms |         20 | what GET /snapshot does: the digest and the body, each of which encodes the snapshot, so the encoding happens twice                            |
| Apply a 100-row snapshot to an empty device   |     0.838 ms |      1.22 ms |         25 | every record is folded into the local store and into the device's clock                                                                        |
| Snapshot body for 100 rows                    |    226,900 B |    226,900 B |          1 | the NDJSON encoding the digest is taken over, uncompressed                                                                                     |
| /snapshot response for 100 rows               |    263,600 B |    263,600 B |          1 | the envelope as the relay sends it: the NDJSON body and the digest of those bytes                                                              |
| Build a snapshot of 1,000 rows                |     0.131 ms |     0.238 ms |         25 | the server scans every record it holds and keeps the ones in this scope; it holds one scope here, so the scan and the answer are the same size |
| Order and encode a 1,000-row snapshot         |     13.29 ms |     14.48 ms |         20 | records are sorted into key order and written as NDJSON; no digest is taken                                                                    |
| Digest a 1,000-row snapshot body              |     11.00 ms |     16.53 ms |         20 | SHA-256 in portable TypeScript, so that a browser client and a Node relay agree without either taking a dependency                             |
| Content-address a 1,000-row snapshot          |     26.28 ms |     29.05 ms |         20 | what GET /snapshot does: the digest and the body, each of which encodes the snapshot, so the encoding happens twice                            |
| Apply a 1,000-row snapshot to an empty device |      9.22 ms |     10.21 ms |         25 | every record is folded into the local store and into the device's clock                                                                        |
| Snapshot body for 1,000 rows                  |  2,287,000 B |  2,287,000 B |          1 | the NDJSON encoding the digest is taken over, uncompressed                                                                                     |
| /snapshot response for 1,000 rows             |  2,652,000 B |  2,652,000 B |          1 | the envelope as the relay sends it: the NDJSON body and the digest of those bytes                                                              |
| Build a snapshot of 5,000 rows                |     0.751 ms |     0.927 ms |         25 | the server scans every record it holds and keeps the ones in this scope; it holds one scope here, so the scan and the answer are the same size |
| Order and encode a 5,000-row snapshot         |     76.60 ms |     94.27 ms |         20 | records are sorted into key order and written as NDJSON; no digest is taken                                                                    |
| Digest a 5,000-row snapshot body              |     57.69 ms |     65.89 ms |         20 | SHA-256 in portable TypeScript, so that a browser client and a Node relay agree without either taking a dependency                             |
| Content-address a 5,000-row snapshot          |       139 ms |       159 ms |         20 | what GET /snapshot does: the digest and the body, each of which encodes the snapshot, so the encoding happens twice                            |
| Apply a 5,000-row snapshot to an empty device |     48.57 ms |     58.69 ms |         25 | every record is folded into the local store and into the device's clock                                                                        |
| Snapshot body for 5,000 rows                  | 11,520,000 B | 11,520,000 B |          1 | the NDJSON encoding the digest is taken over, uncompressed                                                                                     |
| /snapshot response for 5,000 rows             | 13,340,000 B | 13,340,000 B |          1 | the envelope as the relay sends it: the NDJSON body and the digest of those bytes                                                              |

### Persistence

| Measurement                              |   Median |      p95 | Iterations | What is measured                                                                                                                                                 |
| ---------------------------------------- | -------: | -------: | ---------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save a 100-row scope to SQLite           | 0.617 ms | 0.797 ms |         20 | the store rewrites the whole scope rather than the rows that changed: one transaction that deletes every row and writes it back, committed with synchronous=FULL |
| One edit with a 100-row store attached   | 0.980 ms |  1.10 ms |         20 | a single field update, including the durable write it triggers                                                                                                   |
| Hydrate a 100-row client from SQLite     | 0.617 ms | 0.940 ms |         20 | every row, tombstone and queued op is read back and decoded; the file is warm in the OS cache                                                                    |
| Save a 1,000-row scope to SQLite         | 0.736 ms |  1.02 ms |         20 | the store rewrites the whole scope rather than the rows that changed: one transaction that deletes every row and writes it back, committed with synchronous=FULL |
| One edit with a 1,000-row store attached |  1.00 ms |  1.50 ms |         20 | a single field update, including the durable write it triggers                                                                                                   |
| Hydrate a 1,000-row client from SQLite   |  4.94 ms |  7.41 ms |         20 | every row, tombstone and queued op is read back and decoded; the file is warm in the OS cache                                                                    |
| Save a 5,000-row scope to SQLite         |  1.32 ms |  1.98 ms |         20 | the store rewrites the whole scope rather than the rows that changed: one transaction that deletes every row and writes it back, committed with synchronous=FULL |
| One edit with a 5,000-row store attached |  1.58 ms |  1.95 ms |         20 | a single field update, including the durable write it triggers                                                                                                   |
| Hydrate a 5,000-row client from SQLite   | 24.45 ms | 32.30 ms |         20 | every row, tombstone and queued op is read back and decoded; the file is warm in the OS cache                                                                    |

### Sync round trip

| Measurement                                              |    Median |       p95 | Iterations | What is measured                                                                                              |
| -------------------------------------------------------- | --------: | --------: | ---------: | ------------------------------------------------------------------------------------------------------------- |
| Edit visible on a second device, in process              | 0.0102 ms | 0.0221 ms |        200 | both devices share a heap and call the server directly; no serialization, no socket                           |
| One HTTP request to the relay (handshake)                |  0.702 ms |   1.08 ms |        200 | a single POST /handshake over 127.0.0.1, answered by the in-memory relay                                      |
| Edit visible on a second device over HTTP                |   2.25 ms |   3.79 ms |        200 | device A runs a full session (handshake, push, pull) and then device B does; five requests in all             |
| One WebSocket request to the relay (handshake)           | 0.0537 ms | 0.0722 ms |        200 | the same handshake over an already-open socket, so no connection is set up per request                        |
| Edit visible on a second device over a WebSocket session |  0.284 ms |  0.581 ms |        200 | device B asks for the change rather than being sent it — what a poller does when its timer fires              |
| Edit visible on a second device, pushed by the relay     |  0.162 ms |  0.282 ms |        200 | device B is subscribed with a cursor, so the relay sends the batch unasked; timing ends when B has applied it |

### Relay throughput

| Measurement                                   |            Median |               p95 | Iterations | What is measured                                                                        |
| --------------------------------------------- | ----------------: | ----------------: | ---------: | --------------------------------------------------------------------------------------- |
| Push 100 ops in process                       |     666,700 ops/s |     472,600 ops/s |         30 | no serialization and no socket; the floor the two transports below are measured against |
| Push 100 ops over HTTP                        |      58,470 ops/s |       3,877 ops/s |         30 | one push of a 100-op outbox into a fresh in-memory scope, over 127.0.0.1                |
| Push 100 ops over a WebSocket                 |     101,100 ops/s |       5,949 ops/s |         30 | one push of a 100-op outbox into a fresh in-memory scope, over 127.0.0.1                |
| Pull 100 records over HTTP                    | 135,400 records/s |   6,819 records/s |         30 | one GET /pull from a cursor of zero; the records are decoded but not applied            |
| Catch a device up on 100 records over HTTP    |  74,070 records/s |   5,992 records/s |         30 | a full session on an empty device: handshake, pull, and applying every record locally   |
| Push 1,000 ops in process                     |     708,700 ops/s |     337,200 ops/s |         30 | no serialization and no socket; the floor the two transports below are measured against |
| Push 1,000 ops over HTTP                      |      85,060 ops/s |      35,350 ops/s |         30 | one push of a 1000-op outbox into a fresh in-memory scope, over 127.0.0.1               |
| Push 1,000 ops over a WebSocket               |     198,300 ops/s |      49,540 ops/s |         30 | one push of a 1000-op outbox into a fresh in-memory scope, over 127.0.0.1               |
| Pull 1,000 records over HTTP                  | 338,200 records/s |  37,950 records/s |         30 | one GET /pull from a cursor of zero; the records are decoded but not applied            |
| Catch a device up on 1,000 records over HTTP  | 236,300 records/s |  34,340 records/s |         30 | a full session on an empty device: handshake, pull, and applying every record locally   |
| Push 10,000 ops in process                    |     490,500 ops/s |     412,100 ops/s |         30 | no serialization and no socket; the floor the two transports below are measured against |
| Push 10,000 ops over HTTP                     |     167,400 ops/s |     122,500 ops/s |         30 | one push of a 10000-op outbox into a fresh in-memory scope, over 127.0.0.1              |
| Push 10,000 ops over a WebSocket              |     171,800 ops/s |     112,000 ops/s |         30 | one push of a 10000-op outbox into a fresh in-memory scope, over 127.0.0.1              |
| Pull 10,000 records over HTTP                 | 414,300 records/s | 227,500 records/s |         30 | one GET /pull from a cursor of zero; the records are decoded but not applied            |
| Catch a device up on 10,000 records over HTTP | 305,200 records/s | 194,500 records/s |         30 | a full session on an empty device: handshake, pull, and applying every record locally   |

### Durable relay

| Measurement                                                  |       Median |          p95 | Iterations | What is measured                                                                        |
| ------------------------------------------------------------ | -----------: | -----------: | ---------: | --------------------------------------------------------------------------------------- |
| Push 100 ops to a SQLite-backed relay                        | 23,600 ops/s |  4,334 ops/s |         20 | one push into an empty scope, committed with synchronous=FULL before it is acknowledged |
| Push 1,000 ops to a SQLite-backed relay                      | 34,220 ops/s | 26,040 ops/s |         20 | one push into an empty scope, committed with synchronous=FULL before it is acknowledged |
| Push 10,000 ops to a SQLite-backed relay                     | 53,590 ops/s | 46,090 ops/s |         20 | one push into an empty scope, committed with synchronous=FULL before it is acknowledged |
| Push one new row into a durable scope holding 1,000 records  |      2.31 ms |      2.90 ms |         20 | 10 ops on the wire either way; only the size of the scope around them differs           |
| Push one new row into a durable scope holding 10,000 records |      2.95 ms |     18.45 ms |         20 | 10 ops on the wire either way; only the size of the scope around them differs           |

### Convergence

| Measurement                           |   Median |      p95 | Iterations | What is measured                                                                                                          |
| ------------------------------------- | -------: | -------: | ---------: | ------------------------------------------------------------------------------------------------------------------------- |
| 2 devices, 10 new rows each, converge | 13.80 ms | 36.58 ms |         20 | each device creates its own rows offline, then all of them sync through one relay until every device holds the same state |
| 2 devices editing one field, converge |  4.58 ms |  5.62 ms |         20 | every device writes the same field of the same row while offline; the highest stamp wins and the rest learn it            |
| 4 devices, 10 new rows each, converge | 28.13 ms | 57.95 ms |         20 | each device creates its own rows offline, then all of them sync through one relay until every device holds the same state |
| 4 devices editing one field, converge |  9.93 ms | 16.03 ms |         20 | every device writes the same field of the same row while offline; the highest stamp wins and the rest learn it            |
| 8 devices, 10 new rows each, converge | 81.55 ms |   116 ms |         20 | each device creates its own rows offline, then all of them sync through one relay until every device holds the same state |
| 8 devices editing one field, converge | 18.83 ms | 22.14 ms |         20 | every device writes the same field of the same row while offline; the highest stamp wins and the rest learn it            |

## The file this is generated from

`bench/results.json` carries the same numbers with one flat object per case: `id`, `group`,
`label`, `unit`, `median`, `p95`, `iterations`, `note`, plus the machine block above.
