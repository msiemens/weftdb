// The two worker modules reach the page as URLs rather than as imports, because
// `openWeftDatabase` constructs the `SharedWorker` itself and a `SharedWorker` is identified by the
// URL every tab names. Vite's `?sharedworker&url` suffix is what makes those URLs real in a build:
// the module is bundled as a worker of its own and the URL points at the bundle. A
// `new URL("./storage-worker.ts", import.meta.url)` says nothing about the file being code, so the
// build emits it untransformed and the browser is handed TypeScript.
declare module "*?sharedworker&url" {
  const url: string;
  export default url;
}
