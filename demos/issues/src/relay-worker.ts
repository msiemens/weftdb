// The relay this demo syncs through: one `WeftServer` in a `SharedWorker` of the visitor's own
// browser, serving a port to each tab. A static page has no server behind it, and this is what
// stands in for one — the deployment, not the transport.
import "weftdb-demo-shared/relay-worker-entry";
