// The two worker modules reach the page as URLs rather than as imports, because
// `openWeftDatabase` constructs the `SharedWorker` itself and a `SharedWorker` is identified by the
// URL every tab names. Vite's `?sharedworker&url` suffix bundles the module as a worker of its own
// and points the URL at that bundle. A plain
// `new URL("./storage-worker.ts", import.meta.url)` says nothing about the file being code, so the
// build would emit it untransformed and hand the browser TypeScript.
declare module "*?sharedworker&url" {
  const url: string;
  export default url;
}
