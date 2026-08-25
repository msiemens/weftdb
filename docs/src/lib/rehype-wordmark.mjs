/*
 * Renders every prose mention of the project as the wordmark: `weft` in bold, `db` in the accent.
 *
 * Doing it here rather than by hand means a page can write `weftdb` in plain Markdown and never
 * carry presentation in its source. It also means the treatment cannot drift between pages, which
 * hand-marking guarantees it eventually would.
 *
 * What it deliberately leaves alone:
 *
 *   - anything inside `code`, `pre` or `kbd`, where `weftdb` is a package name being quoted
 *     literally and must stay copyable as written
 *   - a longer word containing it, so `weftdb-cli` and `weftdb-demo-todo` are untouched
 *   - headings, where the surrounding type is already doing the work and a second weight would
 *     fight it
 *   - link text, where the accent would compete with the link colour
 */

const WORD = /\bweftdb\b/gi;
const SKIP = new Set(["code", "pre", "kbd", "a", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Wraps every table in its own scroll box.
 *
 * Starlight makes the `table` itself `display: block; overflow: auto` so a wide one scrolls. That
 * works, but it also means the element is a content-width block, so a border, a radius or a
 * background put on it paints a panel that does not follow the table's edges. The landing page
 * already solved this by putting the panel on a wrapper and leaving the table a table; this gives
 * the documentation the same wrapper to hang it on.
 *
 * @returns {(tree: unknown) => void}
 */
export function rehypeTableScroll() {
  return (tree) => wrapTables(tree);
}

/** @param {any} node */
function wrapTables(node) {
  if (node === null || typeof node !== "object" || !Array.isArray(node.children)) return;

  for (const [index, child] of node.children.entries()) {
    if (child?.type === "element" && child.tagName === "table") {
      node.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-scroll"] },
        children: [child],
      };
      continue;
    }
    wrapTables(child);
  }
}

/** @returns {(tree: unknown) => void} */
export function rehypeWordmark() {
  return (tree) => visit(tree, null);
}

/**
 * @param {any} node
 * @param {string | null} parentTag
 */
function visit(node, parentTag) {
  if (node === null || typeof node !== "object") return;
  if (!Array.isArray(node.children)) return;

  const tag = typeof node.tagName === "string" ? node.tagName : parentTag;
  if (typeof node.tagName === "string" && SKIP.has(node.tagName)) return;

  const replaced = [];
  let changed = false;

  for (const child of node.children) {
    if (child?.type !== "text" || !WORD.test(child.value)) {
      visit(child, tag);
      replaced.push(child);
      continue;
    }
    changed = true;
    replaced.push(...split(child.value));
  }

  if (changed) node.children = replaced;
}

/**
 * Splits one text node into the runs around each mention and the wordmark elements between them.
 *
 * @param {string} value
 */
function split(value) {
  const out = [];
  let last = 0;

  // `WORD` is global, so its `lastIndex` carries between calls. Resetting is what keeps a second
  // mention in the same paragraph from being skipped.
  WORD.lastIndex = 0;
  for (let match = WORD.exec(value); match !== null; match = WORD.exec(value)) {
    if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
    // The casing the page wrote is preserved, so a sentence opening with `Weftdb` still reads.
    const text = match[0];
    out.push({
      type: "element",
      tagName: "span",
      properties: { className: ["wordmark"] },
      children: [
        { type: "text", value: text.slice(0, 4) },
        {
          type: "element",
          tagName: "span",
          properties: { className: ["wordmark-thread"] },
          children: [{ type: "text", value: text.slice(4) }],
        },
      ],
    });
    last = match.index + text.length;
  }

  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}
