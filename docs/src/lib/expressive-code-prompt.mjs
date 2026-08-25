// `@expressive-code/core` is a transitive dependency, brought in through Starlight rather than
// installed directly, so pnpm's strict `node_modules` will not resolve it by name. Starlight
// re-exports the whole Expressive Code API (including this hast helper) for exactly this case.
import { addClassName } from "@astrojs/starlight/expressive-code/hast";
import { isInlineStyleAnnotation } from "@astrojs/starlight/expressive-code";

/*
 * Shell blocks on this site are authored as a transcript: a `$ ` prompt in front of each
 * command, and the command's own output on the lines after it, all in one fenced block. Two
 * things are wrong with rendering that literally:
 *
 *   - the `$ ` is part of the code text, so the block's copy button hands over `$ npx weft
 *     ...`, which no shell can run as-is
 *   - the whole block is one shell grammar, so relay log output gets tokenised as if it were
 *     shell syntax — colourful, and meaningless
 *
 * `preprocessCode` runs before syntax highlighting, so it is where a command line's prompt can
 * be stripped from the text the highlighter (and the copy button) ever sees, while still
 * leaving something for `postprocessRenderedLine` to hang a CSS-only prompt on. Whether a line
 * counts as output is decided in the same pass, and used later to strip that line's syntax
 * annotations in `postprocessAnnotations` — the same hook and technique Expressive Code's own
 * indent-detection plugin uses to remove highlighting it doesn't want.
 *
 * A command can span multiple lines via a trailing backslash, the way a real shell reads it.
 * Every line pulled in that way is still command text — it keeps its highlighting and stays in
 * the copied output — but only the line that opened the command carries a prompt.
 */

const SHELL_LANGUAGES = new Set(["sh", "bash", "shell", "zsh"]);
const PROMPT = "$ ";

// `ExpressiveCodeLine` instances are unique for the lifetime of one block's render and are
// never shared across blocks, so a plain `WeakSet` is enough to carry this pass's
// classification through to the later hooks without threading it through the engine's own
// per-block data.
const commandLines = new WeakSet();
const promptLines = new WeakSet();
const outputLines = new WeakSet();

/** @param {string} text */
function endsWithContinuation(text) {
  return text.endsWith("\\");
}

/** @param {import("@astrojs/starlight/expressive-code").ExpressiveCodeBlock} codeBlock */
function classify(codeBlock) {
  const lines = codeBlock.getLines();
  // Most `sh` blocks on the site are a command with no output shown. Touching those would
  // gain nothing and risks breaking a block nobody meant as a transcript.
  if (!lines.some((line) => line.text.startsWith(PROMPT))) return;

  let inContinuation = false;
  for (const line of lines) {
    if (inContinuation) {
      // A continuation line keeps whatever indentation it was written with — it is still
      // shell syntax, just not the line that opened the command.
      commandLines.add(line);
      inContinuation = endsWithContinuation(line.text);
      continue;
    }
    if (line.text.startsWith(PROMPT)) {
      // Stripped here, before the syntax highlighter or the copy button ever see it.
      line.editText(0, PROMPT.length, "");
      commandLines.add(line);
      promptLines.add(line);
      inContinuation = endsWithContinuation(line.text);
      continue;
    }
    outputLines.add(line);
  }
}

export function expressiveCodePrompt() {
  return {
    name: "weft prompt/output split",
    baseStyles: `
      /*
       * The prompt is drawn as content, not text: pseudo-element content is not part of the
       * DOM text a copy button reads or a mouse selection can grab, which is what keeps it
       * visible without being copyable.
       */
      /*
       * The pseudo-element goes on \`.code\`, not on \`.ec-line\` itself: \`.ec-line\` is a grid
       * container (\`grid-template-areas: 'gutter code'\`), so a \`::before\` placed on it would
       * become an unplaced grid item instead of inline content, landing wherever the auto
       * placement algorithm puts it rather than in front of the command text. Expressive
       * Code's own diff markers (\`.ec-line.ins .code::before\`) use the same \`.code::before\`
       * placement for the same reason.
       */
      .weft-prompt .code::before {
        content: "${PROMPT}";
        color: var(--ink-3);
        user-select: none;
      }

      /*
       * Unhighlighting output actually happens by deleting its syntax-highlighting
       * annotations in the \`postprocessAnnotations\` hook, before this CSS ever runs. This
       * rule is only a defensive fallback in case some other annotation still sets a color
       * on a token inside one of these lines.
       */
      .weft-output,
      .weft-output * {
        color: inherit;
      }
    `,
    hooks: {
      preprocessCode(context) {
        if (!SHELL_LANGUAGES.has(context.codeBlock.language)) return;
        classify(context.codeBlock);
      },
      postprocessAnnotations(context) {
        for (const line of context.codeBlock.getLines()) {
          if (!outputLines.has(line)) continue;
          for (const annotation of line.getAnnotations()) {
            if (isInlineStyleAnnotation(annotation)) line.deleteAnnotation(annotation);
          }
        }
      },
      postprocessRenderedLine(context) {
        const { line, renderData } = context;
        if (commandLines.has(line)) addClassName(renderData.lineAst, "weft-cmd");
        if (promptLines.has(line)) addClassName(renderData.lineAst, "weft-prompt");
        if (outputLines.has(line)) addClassName(renderData.lineAst, "weft-output");
      },
    },
  };
}
