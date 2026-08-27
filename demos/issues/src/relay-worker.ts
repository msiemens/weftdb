// This demo syncs through one `WeftServer` inside a `SharedWorker` in the visitor's own browser,
// serving a port to each tab. A static page has no server behind it, so this worker fills that
// role for the demo.
import "weftdb-demo-shared/relay-worker-entry";
