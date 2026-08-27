// Checks source comments against CLAUDE.md's "Code comments" section.
//
//   node scripts/comment-check.mjs packages/weftdb/src/client/open.ts ...
//   node scripts/comment-check.mjs --all
//
// `error` marks shapes that are wrong wherever they appear, such as first person, a reference to
// the conversation that produced the code, or a defence of a decision. `review` marks shapes that
// are usually wrong and sometimes right and so need a reader, such as `no longer`, which describes
// the code's past when it names a module and the system's present when it names a document that has
// closed.
//
// It catches wording. It cannot catch a sentence that is grammatical, on topic, and carries nothing,
// which is the most common fault of all, so a clean report is a floor.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ERRORS = [
  [/\b(we|our|ours|us|let's|I'm|I've|I'll)\b/i, "first person"],
  [
    /\b(as requested|as discussed|as asked|per review|per the discussion|we decided|the user wants|you asked)\b/i,
    "names the conversation",
  ],
  [/\b(on purpose|deliberately|intentionally)\b/i, "defends a decision"],
  [
    /\b(used to be|used to have|used to call|used to live|used to return|was replaced by|has been replaced|this now does|it now does|now that we)\b/i,
    "the code's own past",
  ],
  [/\b(for now|leaving this|TODO from|FIXME from|revisit later)\b/i, "a note to a reviewer"],
  [/\b(two|three|four|five|six|seven|eight|nine|ten)\s+things\b/i, "counts what follows"],
];

const REVIEW = [
  [/\bno longer\b/i, "`no longer` — the system's present, or the code's past?"],
  [/\brather than\b/i, "rhetorical contrast — state the positive with `because`"],
  [/,\s*not\s+\w/, "rhetorical contrast `X, not Y`"],
  [/\bnot\b[^.]{0,40}\bbut\b/i, "rhetorical contrast `not X but Y`"],
  [
    /^(this is|that is|the whole|the point|the key|the interesting|note that|it is worth|worth noting)\b/i,
    "announces that what follows matters",
  ],
  [/\b(previously|originally|formerly)\b/i, "possible history"],
  [
    /\b(two|three|four|five|six)\s+(reasons|ways|kinds|levels|parts|steps|forms|senses|properties|members|checks|rules|halves|maps|passes)\b|\btwice over\b|\bthere are (two|three|four|five)\b|\bin (two|three|four) (ways|places|senses)\b/i,
    "counts what follows — is the number load-bearing?",
  ],
];

// Punctuation that lets a sentence defer its work. An em dash bolts a second clause on without
// saying how it relates to the first, and a colon promises an explanation the reader is then left
// to assemble. Both let a draft sound finished while the relation between its halves goes unwritten.
// Write the relation instead. A full stop where the thought ended, `because` where the second half
// is the reason, a comma and a conjunction where the halves are one thought.
//
// A colon still earns its place introducing a list or a quoted sample, so colons are left to a
// reader and dashes are not.
const PROSE = [
  [/[—–]/, "error", "em or en dash — write the relation the dash is standing in for"],
  [/[a-z)`][ ]?:[ ]+[a-z]/, "review", "colon defers the explanation — is it introducing a list?"],
];

const FILLER = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "once",
  "one",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

/** `ensureSchema` → `ensure schema`, `MAX_BACKOFF_MS` → `max backoff ms`. */
function words(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_#]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !FILLER.has(word));
}

/**
 * A summary that says what the identifier under it already says.
 *
 * `The schema, installed once.` over `ensureSchema()` carries nothing a reader did not have from the
 * name. Length alone does not decide it: `The ceiling.` over a backoff constant names what the value
 * is, which its name may not. So this compares the summary's content words against the declaration's
 * and fires when the summary adds none of its own.
 */
function restatesDeclaration(text, declaration) {
  if (declaration === undefined) return false;
  const first = text.split(/(?<=\.)\s/)[0] ?? text;
  if (!first.endsWith(".") || /`/.test(first)) return false;
  const summary = words(first.replace(/[.,]/g, ""));
  if (summary.length === 0 || summary.length > 5) return false;
  const declared = new Set(words(declaration));
  return summary.some((word) => declared.has(word)) && summary.every((word) => declared.has(word) || word.length < 4);
}

/** The identifier a comment sits above, if the next line of code declares one. */
function declaredBelow(lines, index) {
  for (let cursor = index; cursor < Math.min(index + 3, lines.length); cursor += 1) {
    const line = lines[cursor]?.trim() ?? "";
    if (line === "" || line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) continue;
    // Modifiers first, or `private async ensureSchema()` reports its name as `async`.
    const bare = line.replace(
      /^(?:export\s+|declare\s+|private\s+|public\s+|protected\s+|static\s+|readonly\s+|abstract\s+|async\s+|override\s+)+/,
      "",
    );
    const match =
      /^(?:function|class|interface|type|const|let|enum|get|set)\s+([A-Za-z_#][\w#]*)/.exec(bare) ??
      /^([A-Za-z_#][\w#]*)\s*[(<:=]/.exec(bare);
    return match?.[1];
  }
  return undefined;
}

/**
 * A `/** *\/` block that documents nothing, because the next thing in the file is another one.
 *
 * TypeScript attaches the block immediately before a declaration and ignores anything earlier, so
 * the first of two in a row is read by nobody and shown by no editor. Two were found in this tree,
 * both well written and both attached to nothing.
 *
 * A blank line after a doc block is not the same fault: a file header is written that way.
 */
function orphanedDoc(sourceLines, entry) {
  if (entry.doc !== true) return false;
  for (let index = entry.end; index < sourceLines.length; index += 1) {
    const line = (sourceLines[index] ?? "").trim();
    if (line === "") continue;
    return line.startsWith("/**");
  }
  return false;
}

/**
 * Section numbers `DESIGN.md` answers to.
 *
 * Headings carry their own number (`### 5.10 …`). Section 9's invariants are an ordered markdown
 * list, so its numbers exist only once rendered, and what can be checked there is how far the list
 * runs. Suffixed references like `9.23b` name a part of an invariant and are checked as `9.23`.
 */
function designSections() {
  // Both numbered specifications answer to `§`. `docs/STYLE.md` is cited by the prose checker beside
  // this one, and a number either document has is a number a comment may name.
  const sources = ["DESIGN.md", "docs/STYLE.md"].flatMap((path) => {
    try {
      return [readFileSync(path, "utf8")];
    } catch {
      return [];
    }
  });
  if (sources.length === 0) return undefined;
  const lines = sources.join("\n").split("\n");
  const headings = new Set();
  const listed = new Map();
  let section;
  for (const raw of lines) {
    const heading = /^#{2,4}\s+(\d+(?:\.\d+)*)\.?\s+\S/.exec(raw);
    if (heading?.[1] !== undefined) {
      headings.add(heading[1]);
      if (!heading[1].includes(".")) section = heading[1];
      continue;
    }
    if (section !== undefined && /^\s*\d+\.\s+\S/.test(raw)) {
      listed.set(section, (listed.get(section) ?? 0) + 1);
    }
  }
  return { headings, listed };
}

/** Every `§…` a comment cites that `DESIGN.md` has no answer for. */
function danglingSections(text, sections) {
  if (sections === undefined) return [];
  const missing = [];
  for (const [, cited] of text.matchAll(/§(\d+(?:\.\d+)*)[a-z]?/g)) {
    if (sections.headings.has(cited)) continue;
    const [top, sub] = cited.split(".");
    if (top === undefined) continue;
    if (sub === undefined) {
      if (!sections.headings.has(top)) missing.push(cited);
      continue;
    }
    // A numbered invariant under a section whose parts are a list rather than headings.
    const runs = sections.listed.get(top);
    if (runs === undefined || Number(sub) > runs) missing.push(cited);
  }
  return missing;
}

/** Comments, joined across the lines they wrap over, with the line each starts on. */
function comments(source) {
  const lines = source.split("\n");
  const found = [];
  let run = null;
  let inBlock = false;

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (inBlock) {
      const body = line
        .replace(/^\*+\s?/, "")
        .replace(/\*\/$/, "")
        .trim();
      if (body) run.text += ` ${body}`;
      run.end = index + 1;
      if (line.includes("*/")) {
        found.push(run);
        run = null;
        inBlock = false;
      }
      return;
    }
    if (line.startsWith("/*")) {
      inBlock = !line.includes("*/");
      const body = line
        .replace(/^\/\*+\s?/, "")
        .replace(/\*\/$/, "")
        .trim();
      run = { line: index + 1, end: index + 1, text: body, doc: line.startsWith("/**") };
      if (!inBlock) {
        found.push(run);
        run = null;
      }
      return;
    }
    if (line.startsWith("//")) {
      const body = line.replace(/^\/\/+\s?/, "").trim();
      if (run) {
        run.text += ` ${body}`;
        run.end = index + 1;
      } else run = { line: index + 1, end: index + 1, text: body };
      return;
    }
    if (run) {
      found.push(run);
      run = null;
    }
  });
  if (run) found.push(run);
  return found.filter((entry) => entry.text.length > 0);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated" || entry === ".astro") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if ([".ts", ".tsx", ".mjs"].includes(extname(path)) && !path.includes("bughunt-")) out.push(path);
  }
  return out;
}

const argv = process.argv.slice(2);
// `scripts` among them, so the checker is held to what it enforces.
const files = argv.includes("--all")
  ? ["packages", "demos", "bench", "tests", "scripts"].flatMap((dir) => walk(dir))
  : argv;

const sections = designSections();

let errors = 0;
let reviews = 0;
const worst = [];

for (const file of files) {
  const hits = [];
  const source = readFileSync(file, "utf8");
  const sourceLines = source.split("\n");
  for (const entry of comments(source)) {
    for (const [pattern, rule] of ERRORS) {
      if (pattern.test(entry.text)) hits.push({ ...entry, tier: "error", rule });
    }
    for (const [pattern, rule] of REVIEW) {
      if (pattern.test(entry.text)) hits.push({ ...entry, tier: "review", rule });
    }
    // Against the prose alone. A colon inside a code span is punctuation of whatever is quoted, a
    // type annotation or an object literal or a URL scheme, and says nothing about the sentence.
    const prose = entry.text.replace(/`[^`]*`/g, "·").replace(/\bhttps?:\/\/\S+/g, "·");
    for (const [pattern, tier, rule] of PROSE) {
      if (pattern.test(prose)) hits.push({ ...entry, tier, rule });
    }
    const declaration = declaredBelow(sourceLines, entry.end);
    if (restatesDeclaration(entry.text, declaration)) {
      hits.push({ ...entry, tier: "review", rule: `summary restates \`${declaration ?? ""}\`` });
    }
    if (orphanedDoc(sourceLines, entry)) {
      hits.push({ ...entry, tier: "error", rule: "documents nothing: the next thing is another doc block" });
    }
    for (const cited of danglingSections(entry.text, sections)) {
      hits.push({ ...entry, tier: "error", rule: `cites §${cited}, which DESIGN.md does not answer to` });
    }
  }
  if (hits.length === 0) continue;
  errors += hits.filter((hit) => hit.tier === "error").length;
  reviews += hits.filter((hit) => hit.tier === "review").length;
  worst.push({ file, count: hits.length });
  console.log(`\n${file}`);
  for (const hit of hits) {
    console.log(`  ${String(hit.line).padStart(5)}  [${hit.tier}] ${hit.rule}`);
    console.log(`         ${hit.text.slice(0, 96)}`);
  }
}

console.log(`\n${errors} error, ${reviews} review, across ${worst.length} file(s)`);
if (worst.length > 0) {
  console.log("\nworst files:");
  for (const entry of worst.sort((a, b) => b.count - a.count).slice(0, 12)) {
    console.log(`  ${String(entry.count).padStart(4)}  ${entry.file}`);
  }
}
process.exit(errors > 0 ? 1 : 0);
