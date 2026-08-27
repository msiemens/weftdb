// One `WeftServer` runs in a `SharedWorker` of the visitor's own browser and serves a port to
// each tab. A static page has no server behind it, so this is where a real deployment's relay
// would run instead.
import "weftdb-demo-shared/relay-worker-entry";
