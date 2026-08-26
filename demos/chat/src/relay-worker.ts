// The relay this demo syncs through: one `WeftServer` in a `SharedWorker` of the visitor's own
// browser, serving a port to each tab. It is what tells a tab that the room has moved, which is
// how a message posted next door lands here without anyone asking for it.
import "weftdb-demo-shared/relay-worker-entry";
