// Checks docs pages against docs/STYLE.md, mechanically.
//
//   node scripts/style-check.mjs docs/src/content/docs/concepts/scopes.md ...
//
// Reports line numbers and a short excerpt per hit. Heuristic rules are marked "review": they flag
// shapes that are usually violations. It catches the mechanical half of STYLE.md and none of the
// register, so a clean report leaves the register for a reader to judge.
//
// Rules the checker cannot hold, and a reader must: whether a heading is a noun phrase on a concept
// page and a gerund on a guide, whether a sentence is rhetorical contrast, whether a paragraph
// justifies an absent feature, and whether a code sample runs as written.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
let total = 0;

const BANNED = [
  [/—/, "em dash (§2)"],
  [/\b(currently|no longer|previously|originally|used to|recently added|new in|as of)\b/i, "history or recency (§3)"],
  [/\b(simply|just now|elegant|powerful|seamless|blazing|effortless|robustly)\b/i, "editorial adjective (§2)"],
  [/\b(arguably|perhaps|it could be said|somewhat|fairly)\b/i, "hedging (§2)"],
  [/\b(we|our|us|let us|I)\b/, "first person (§1)"],
  [/\b(this page|as mentioned above|we will see|the following section|this guide)\b/i, "meta-commentary (§3)"],
  [/!/, "exclamation mark (§2)"],
  [/\b\w+(ize|ization|izes|ized|yze)\b/, "American spelling (§15) — check it is not an API name"],
  [/\b(behavior|color|authorization)\b/, "American spelling (§15) — allowed only when quoting an API"],
  [
    /\b(two|three|four|five|six|seven|eight|nine|ten) (reasons|things|ways|rules|kinds|parts|steps)\b/i,
    "counts a list before giving it (§2)",
  ],
];

const REVIEW = [
  [/\bis not\b.*[;,]\s*(it|they)\s+(is|are)\b/i, "rhetorical contrast X is not A; it is B (§2)"],
  [/\bnot\b[^.]{0,40}\bbut\b/i, "rhetorical contrast not X but Y (§2)"],
  [/\blike a\b|\bas if\b|\bthink of\b/i, "possible metaphor (§2)"],
];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  const hits = [];
  let inFence = false;
  let inFrontmatter = false;
  let headings = 0;

  lines.forEach((line, index) => {
    const no = index + 1;
    const at = (rule) => hits.push({ no, rule, text: line.trim().slice(0, 72) });

    if (no === 1 && line === "---") {
      inFrontmatter = true;
      return;
    }
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false;
      else if (line.startsWith("description:")) {
        const value = line.slice("description:".length).trim();
        if (value.length > 160) at(`description is ${value.length} chars, limit 160 (§5)`);
        if (!value.endsWith(".")) at("description does not end in a period (§5)");
      }
      return;
    }

    if (/^\s*```/.test(line)) {
      if (!inFence && /^\s*```\s*$/.test(line)) at("code fence declares no language (§7)");
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    // Prose width. Table rows and lines that are one long link are exempt (§4).
    if (line.length > 100 && !line.trim().startsWith("|") && !/^\s*\[.*\]\(.*\)\s*$/.test(line)) {
      at(`line is ${line.length} chars, wrap at 100 (§4)`);
    }

    if (/^#\s/.test(line)) at("H1 — the title supplies it (§5)");
    if (/^#{4,}\s/.test(line)) at("H4 or deeper — split the page instead (§5)");
    if (/^##\s/.test(line)) {
      headings += 1;
      const text = line.replace(/^#+\s*/, "");
      if (/[.:!?]$/.test(text)) at("heading has terminal punctuation (§6)");
      const words = text
        .replace(/`[^`]*`/g, "")
        .split(/\s+/)
        .filter(Boolean);
      const capitalised = words.slice(1).filter((word) => /^[A-Z][a-z]/.test(word));
      if (capitalised.length > 0) at(`heading may be Title Case: ${capitalised.join(", ")} (§6)`);
    }

    // Table body cells must not end in a period (§12).
    if (line.trim().startsWith("|") && !/^\s*\|[\s|:-]+\|\s*$/.test(line)) {
      for (const cell of line.split("|").slice(1, -1)) {
        // The glossary defines each term in a sentence and says so in its own preamble, so §12's
        // rule against a terminal period in a cell does not describe that page.
        if (/\w\.\s*$/.test(cell) && !file.endsWith("reference/glossary.md")) {
          at("table cell ends in a period (§12)");
        }
      }
    }

    for (const [pattern, rule] of BANNED) if (pattern.test(line)) at(rule);
    for (const [pattern, rule] of REVIEW) if (pattern.test(line)) at(`review: ${rule}`);
  });

  // Sentence length (§4), over the prose body with fences and tables removed.
  let fenced = false;
  const prose = lines
    .filter((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced && !line.trim().startsWith("|") && !line.trim().startsWith("#");
    })
    .join(" ");
  for (const sentence of prose.split(/(?<=[.?!])\s+/)) {
    // A code span is one thing a reader takes in whatever its length, so `readonly SqlValue[]` is a
    // word and `PRAGMA cache_size = -65536` is a word. Counting their insides makes a short sentence
    // read as a long one.
    const words = sentence
      .replace(/`[^`]*`/g, "·")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length > 35) {
      hits.push({
        no: "-",
        rule: `sentence of ${words.length} words, split over 35 (§4)`,
        text: sentence.trim().slice(0, 72),
      });
    }
  }

  total += hits.length;
  console.log(`\n${file} — ${hits.length} hit(s), ${headings} H2`);
  for (const hit of hits) console.log(`  ${String(hit.no).padStart(4)}  ${hit.rule}\n        ${hit.text}`);
}

console.log(`\n${total} total`);
