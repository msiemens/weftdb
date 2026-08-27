// Each worker module reaches the page as a URL instead of an import, because `openWeftDatabase`
// constructs the `SharedWorker` itself, and a `SharedWorker` is identified by the URL every tab
// names. Vite's `?sharedworker&url` suffix makes those URLs real in a build. The module is bundled
// as a worker of its own, and the URL points at the bundle. A
// `new URL("./storage-worker.ts", import.meta.url)` says nothing about the file being code, so the
// build emits it untransformed and the browser is handed TypeScript.
declare module "*?sharedworker&url" {
  const url: string;
  export default url;
}
