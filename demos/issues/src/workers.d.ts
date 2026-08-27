// `openWeftDatabase` constructs each `SharedWorker` from a URL, and Vite's `?sharedworker&url`
// suffix supplies it. The suffix bundles the module as a worker of its own and resolves the
// import to the URL of that bundle, so the browser receives compiled code instead of the raw
// TypeScript source that a plain `new URL(url, import.meta.url)` would hand it.
declare module "*?sharedworker&url" {
  const url: string;
  export default url;
}
