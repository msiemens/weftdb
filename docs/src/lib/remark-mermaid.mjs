/*
 * Turns a ```mermaid fence into an empty element carrying its own source, for the client script in
 * `src/scripts/mermaid.js` to draw into.
 *
 * This one runs at the Markdown stage rather than the HTML one, unlike the three plugins beside it,
 * for two reasons:
 *
 *   - Expressive Code is a remark plugin, and Shiki has a `mermaid` grammar, so by the time a rehype
 *     plugin sees the page the fence is already a syntax-highlighted `pre` full of `span`s. Reading
 *     the diagram back out of that means re-assembling it from the highlighter's line structure,
 *     which is both wasted work and a thing that breaks the next time that structure changes.
 *     Claiming the fence first is what keeps Expressive Code on the code blocks it is for.
 *   - The source comes out in an attribute rather than as text. `rehypeGlossary` and
 *     `rehypeWordmark` both rewrite text nodes, so a graph with `weftdb` or a glossary term in a
 *     node label is out of their reach by construction, not by being on their skip list — and a
 *     diagram whose source had `<span>`s injected into it does not parse.
 *
 * The element is left empty on purpose: the diagram is drawn in the browser, so there is nothing
 * meaningful to put in it, and a placeholder would only be something to remove.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** @returns {(tree: unknown) => void} */
export function remarkMermaid() {
  return (tree) => claim(tree);
}

/** @param {any} node */
function claim(node) {
  if (node === null || typeof node !== "object" || !Array.isArray(node.children)) return;

  for (const [index, child] of node.children.entries()) {
    if (child?.type === "code" && child.lang === "mermaid") {
      // A raw HTML node rather than an mdast one with `data.hName`: the escaping below is four
      // characters and obvious, where the other route depends on which of `mdast-util-to-hast`'s
      // handlers happens to apply `data` to what it returns.
      node.children[index] = {
        type: "html",
        value: `<div class="mermaid-diagram" data-mermaid="${escape(child.value)}"></div>`,
      };
      continue;
    }
    claim(child);
  }
}

/** Enough for a value inside double quotes, which is where this one goes. @param {string} value */
function escape(value) {
  return value.replaceAll(/[&<>"]/gu, (character) => ESCAPES[character] ?? character);
}
