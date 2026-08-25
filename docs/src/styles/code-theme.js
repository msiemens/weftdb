/*
 * Syntax highlighting in the colours the design already has.
 *
 * `site/main.js` highlights the landing page with a hand-rolled grammar that recognises exactly
 * five things: comments, strings, numbers, keywords, and capitalised identifiers. These two
 * themes hold Expressive Code — which has a full TextMate grammar and could paint a dozen
 * distinctions — to the same five, so a sample in the docs and the same sample on the landing
 * page are the same picture.
 *
 * Its reasoning, from that file: "Six colours would be a different design from the one this page
 * is; these four sit on `--sunken` at 5.5:1 or better in both themes, which is the whole reason
 * they are palette tokens rather than editor-theme colours." Types and constructors are marked
 * by weight rather than a fifth colour.
 *
 * The values are literal because a TextMate theme cannot hold a `var()`. The backgrounds are the
 * exception — `styleOverrides.codeBackground` in `astro.config.mjs` puts `--sunken` back over
 * them — so what is written here is only ever the ink.
 */

/** @param {{ name: string, type: 'light' | 'dark', ink: string, ink2: string, sunken: string, accent: string, ok: string, warn: string }} p */
function loomTheme(p) {
  return {
    name: p.name,
    type: p.type,
    colors: {
      "editor.background": p.sunken,
      "editor.foreground": p.ink,
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: p.ink2, fontStyle: "italic" },
      },
      {
        scope: [
          "string",
          "constant.other.symbol",
          "punctuation.definition.string",
          "string.template",
          "meta.embedded.line",
        ],
        settings: { foreground: p.ok },
      },
      {
        scope: ["constant.numeric", "constant.language", "constant.character.escape"],
        settings: { foreground: p.warn },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.control",
          "keyword.operator.new",
          "keyword.operator.expression",
          "variable.language",
          "punctuation.definition.template-expression",
        ],
        settings: { foreground: p.accent },
      },
      {
        // Types and constructors are marked by weight rather than a fifth colour.
        scope: [
          "entity.name.type",
          "entity.name.class",
          "entity.other.inherited-class",
          "support.type",
          "support.class",
        ],
        settings: { foreground: p.ink, fontStyle: "bold" },
      },
      {
        // Everything the grammar knows about but the design does not distinguish.
        scope: [
          "variable",
          "entity.name.function",
          "support.function",
          "meta.object-literal.key",
          "punctuation",
          "keyword.operator",
        ],
        settings: { foreground: p.ink },
      },
    ],
  };
}

export const loomLight = loomTheme({
  name: "loom-light",
  type: "light",
  ink: "#191813",
  ink2: "#5a554a",
  sunken: "#f1eee5",
  accent: "#2e3a8e",
  ok: "#1e6b45",
  warn: "#7a5312",
});

export const loomDark = loomTheme({
  name: "loom-dark",
  type: "dark",
  ink: "#f0ede4",
  ink2: "#a69f91",
  sunken: "#232119",
  accent: "#9ea9ff",
  ok: "#6fd39c",
  warn: "#e8b45c",
});
