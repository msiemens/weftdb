/*
 * The chat demo, mounted as an Astro island.
 *
 * `demos/chat/src/main.tsx` is the standalone version of this file: it finds `#root` and renders
 * the same tree. Here Astro owns the root, so all that is left is opening the store and handing
 * it to `App` — deliberately nothing else, so what a reader sees at `/demos/chat` is the same
 * application `pnpm --filter weftdb-demo-chat dev` runs rather than a second copy that can drift.
 *
 * `ChatStore.open(window)` reads what this tab left in local storage last time, so it can only
 * run in the browser. The route mounts this with `client:only="react"` for that reason: there is
 * no server-rendered version of a store that is defined by what is already on the device.
 */
import { StrictMode, useState } from "react";
import { App } from "weftdb-demo-chat/app";
import { ChatStore } from "weftdb-demo-chat";
import "weftdb-demo-chat/style.css";

export default function ChatDemo() {
  // Lazily, and once: under StrictMode a store opened in the render body would be opened twice.
  const [store] = useState(() => ChatStore.open(window));

  return (
    <StrictMode>
      <App store={store} />
    </StrictMode>
  );
}
