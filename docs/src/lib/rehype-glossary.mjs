/*
 * Marks the first mention of a glossary term on each page, so a reader meeting a word for the
 * first time can see what it means without leaving the paragraph.
 *
 * The terms and their one-line meanings are read from the glossary itself, so there is one place
 * a definition lives. A page that introduces a term does not have to remember to gloss it, and a
 * definition cannot drift between the glossary and the page that happens to repeat it.
 *
 * What it deliberately leaves alone:
 *
 *   - the glossary page, which is where the definitions come from
 *   - anything inside `code`, `pre` or `kbd`, where a term is being quoted as an identifier and
 *     must stay copyable as written. `diff3` and `fracIndex` are always written that way, so they
 *     are never marked
 *   - link text, where a dotted underline would fight the link's own
 *   - headings, which are navigation rather than prose
 *   - every mention after the first, which is the point: a term is introduced once
 */

import { readFileSync } from "node:fs";

const SKIP = new Set(["code", "pre", "kbd", "a", "abbr", "h1", "h2", "h3", "h4", "h5", "h6"]);
const GLOSSARY = new URL("../content/docs/reference/glossary.md", import.meta.url);

/** @type {{ readonly pattern: RegExp; readonly meanings: ReadonlyMap<string, string> } | undefined} */
let loaded;

/** @returns {(tree: unknown, file: { readonly path?: string }) => void} */
export function rehypeGlossary() {
  return (tree, file) => {
    const path = typeof file?.path === "string" ? file.path.replaceAll("\\", "/") : "";
    if (path.endsWith("/reference/glossary.md")) return;
    const { pattern, meanings } = load();
    // Per file, so "first mention" means first on this page rather than first in the build.
    visit(tree, meanings, pattern, new Set());
  };
}

function load() {
  if (loaded !== undefined) return loaded;
  const meanings = new Map();
  for (const line of readFileSync(GLOSSARY, "utf8").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    // A table row is `| term | meaning | page |`, which splits to five cells with empty ends.
    if (cells.length !== 5 || cells[1] === undefined || cells[2] === undefined) continue;
    const term = plain(cells[1]);
    const meaning = plain(cells[2]);
    if (term.length === 0 || meaning.length === 0 || term === "Term" || term.startsWith("-")) continue;
    for (const form of forms(term)) meanings.set(form.toLowerCase(), meaning);
  }

  // Longest first, so `tombstone floor` is matched before `tombstone` and a plural before its
  // singular. Alternation in JavaScript takes the first branch that matches, not the longest.
  const alternatives = [...meanings.keys()]
    .sort((left, right) => right.length - left.length)
    .map(escape)
    .join("|");
  loaded = { pattern: new RegExp(`\\b(?:${alternatives})\\b`, "giu"), meanings };
  return loaded;
}

/** The singular a page might write, and the plural it might write instead. @param {string} term */
function forms(term) {
  if (/(?:s|ss|sh|ch|x|z)$/iu.test(term)) return [term];
  return [term, `${term}s`];
}

/** Markdown reduced to the text a `title` attribute can carry. @param {string} cell */
function plain(cell) {
  return cell
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replaceAll("`", "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/** @param {string} value */
function escape(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * @param {any} node
 * @param {ReadonlyMap<string, string>} meanings
 * @param {RegExp} pattern
 * @param {Set<string>} used
 */
function visit(node, meanings, pattern, used) {
  if (node === null || typeof node !== "object" || !Array.isArray(node.children)) return;
  if (typeof node.tagName === "string" && SKIP.has(node.tagName)) return;

  const replaced = [];
  let changed = false;

  for (const child of node.children) {
    if (child?.type !== "text") {
      visit(child, meanings, pattern, used);
      replaced.push(child);
      continue;
    }
    const parts = split(child.value, meanings, pattern, used);
    if (parts === undefined) {
      replaced.push(child);
      continue;
    }
    changed = true;
    replaced.push(...parts);
  }

  if (changed) node.children = replaced;
}

/**
 * One text node split into the runs around each first mention and the `abbr` elements between
 * them. Returns undefined when nothing in it is a term being met for the first time, so the node
 * is left as it was rather than rebuilt.
 *
 * @param {string} value
 * @param {ReadonlyMap<string, string>} meanings
 * @param {RegExp} pattern
 * @param {Set<string>} used
 */
function split(value, meanings, pattern, used) {
  const out = [];
  let last = 0;

  // The pattern is global, so its `lastIndex` carries between calls. Resetting is what keeps a
  // mention at the start of the next paragraph from being skipped.
  pattern.lastIndex = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    const text = match[0];
    const key = text.toLowerCase();
    const meaning = meanings.get(key);
    // A term keys on its own form, but a page that writes both the singular and the plural has
    // still only introduced one term, so the entry is claimed under the meaning it resolved to.
    if (meaning === undefined || used.has(meaning)) continue;
    used.add(meaning);
    if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
    out.push({
      type: "element",
      tagName: "abbr",
      // The casing the page wrote is preserved, so a sentence opening with the term still reads.
      properties: { className: ["glossary-term"], title: meaning },
      children: [{ type: "text", value: text }],
    });
    last = match.index + text.length;
  }

  if (out.length === 0) return undefined;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}
