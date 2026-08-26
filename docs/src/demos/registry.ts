/*
 * The demos the docs site carries.
 *
 * One entry per demo. Adding a second — a relational app, a live chat — is an entry here, a
 * component under `./<slug>/`, and one line in the map in `pages/demos/[slug].astro`. Nothing
 * else: the routes and the sidebar links are both derived from this list.
 *
 * This file is imported by `astro.config.mjs` to build the sidebar, so it must stay free of
 * component imports — data only, or loading the config would pull React into it.
 *
 * Each demo is a workspace package under `demos/`, kept there rather than moved under `docs/`:
 * ten test files and the benchmark fixtures import them by package name, and a demo is a fixture
 * as much as it is documentation.
 */

export interface DemoEntry {
  /** URL segment, and the key the route map matches on. */
  readonly slug: string;
  readonly title: string;
  /** One line, used as the page description. */
  readonly blurb: string;
}

export const DEMOS: readonly DemoEntry[] = [
  {
    slug: "todo",
    title: "Todo list",
    blurb: "One browser tab is one device, with its own outbox and its own clock.",
  },
  {
    slug: "issues",
    title: "Issue tracker",
    blurb: "Projects, issues and comments, joined through the relationships the schema declares.",
  },
  {
    slug: "chat",
    title: "Live chat room",
    blurb: "An append-only message log, pushed to every open tab over the sync socket.",
  },
];

/** The one a route is for, or undefined if the slug is not a demo. */
export function findDemo(slug: string): DemoEntry | undefined {
  return DEMOS.find((demo) => demo.slug === slug);
}
