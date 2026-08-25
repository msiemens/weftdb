/*
 * Highlighting for the landing page, without a library — `site/main.js`'s grammar, moved to the
 * build.
 *
 * Two grammars, because there are two kinds of sample on this page — TypeScript and shell — and
 * a rule that fits both fits neither.
 *
 * What changed in the move: the original walked the DOM and replaced each sample's text with
 * spans on load, which meant a reader with JavaScript off got no highlighting and everybody else
 * got a frame of unstyled code first. Astro renders at build time, so the spans are in the HTML
 * that ships. The tokens still wrap the sample's own text and nothing else, so `textContent` is
 * the sample exactly as written and the copy button keeps handing over source rather than markup.
 *
 * The docs pages are highlighted by Expressive Code instead, held to these same five
 * distinctions by the themes in `../styles/code-theme.js`.
 */

const GRAMMARS = {
  ts: [
    ["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//y],
    ["string", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y],
    ["number", /\b\d[\d_]*(?:\.\d+)?\b/y],
    [
      "keyword",
      /\b(?:import|export|from|as|const|let|var|function|return|type|interface|readonly|await|async|new|class|extends|implements|for|of|in|if|else|switch|case|try|catch|finally|throw|typeof|void|null|undefined|true|false|this|default|satisfies)\b/y,
    ],
    // Types and constructors: an identifier that starts with a capital.
    ["type", /\b[A-Z][A-Za-z0-9_]*\b/y],
  ],
  shell: [
    ["comment", /#[^\n]*/y],
    ["string", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y],
    // A flag, and the NAME= of an environment variable set in front of a command.
    ["keyword", /--?[A-Za-z][\w-]*|\b[A-Z][A-Z0-9_]*(?==)/y],
    ["number", /\b\d[\d_]*\b/y],
  ],
};

/** @param {string} text */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Marks up one sample. Returns HTML for the inside of a `<code>` element.
 *
 * @param {string} source the sample exactly as written
 * @param {"ts" | "shell"} lang
 * @returns {string}
 */
export function highlight(source, lang) {
  const rules = GRAMMARS[lang];
  let html = "";
  let index = 0;
  let plain = "";

  while (index < source.length) {
    let matched = null;
    for (const [kind, pattern] of rules) {
      pattern.lastIndex = index;
      const found = pattern.exec(source);
      if (found !== null) {
        matched = { kind, text: found[0] };
        break;
      }
    }
    if (matched === null) {
      plain += source[index];
      index += 1;
      continue;
    }
    // Runs of ordinary text are appended in one go rather than a span per character.
    if (plain !== "") {
      html += escapeHtml(plain);
      plain = "";
    }
    html += `<span class="tok-${matched.kind}">${escapeHtml(matched.text)}</span>`;
    index += matched.text.length;
  }
  if (plain !== "") html += escapeHtml(plain);

  return html;
}
