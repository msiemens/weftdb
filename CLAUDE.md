# Working in this repository

Project rules. The global rules in `~/.claude/CLAUDE.md` still apply and are not repeated here.

## Prose in Markdown

`docs/STYLE.md` governs everything under `docs/src/content/docs/**`. **Read it before editing any
page there, every time.** It is long, specific, and the register is not guessable from the
surrounding text.

Run the checker on every page you touch and fix what it reports for prose you wrote:

```
node scripts/style-check.mjs docs/src/content/docs/concepts/scopes.md ...
```

Leave pre-existing hits alone. §4 forbids reflowing a paragraph for an unrelated edit, so a page you
touched can legitimately still report hits that are not yours. Say so rather than silently fixing
them.

A clean report is a floor, not a pass. The checker holds the mechanical half of the guide and none
of the register: it cannot see whether a heading is a noun phrase on a concept page and a gerund on
a guide, whether a sentence is rhetorical contrast, whether a paragraph justifies a feature's
absence, or whether a sample runs as written. Before inventing a heading, read the siblings.

`STYLE.md` does **not** govern `DESIGN.md`, package READMEs, source comments, commit messages,
`TODO.md`, or `notes/`. Those have a looser voice on purpose. Do not carry the docs register into
them, and do not carry theirs into the docs.

## Code comments

A comment earns its place by holding what the code cannot. Everything else is cost paid by every
future reader.

### Never

**A development diary.** No history of the code, in any form: `used to`, `no longer`,
`previously`, `originally`, `was replaced by`, `this now does`. Whoever reads this file arrives
today and needs to know what is, not what it went through.

**A restatement.** If the comment says what the line below it says, delete the comment.

**The conversation that produced the code.** Never `as requested`, `as discussed`, `per review`,
`we decided`, `the user wants`, `leaving this for now`, or any other reference to a chat, a ticket,
or a person. The reader has none of that context and it reads as somebody else's mail.

**Sentences that carry nothing.** Not a phrasing problem and not a corner case. Most first drafts are
half filler, and the filler reads as prose because it is grammatical and on topic.

A sentence earns its place by leaving the reader knowing something they did not know from the code
and did not know from the sentence before it. Apply the test to every sentence: delete it, reread,
and if nothing was lost leave it deleted. Expect to delete a lot.

Failing sentences restate the code, restate the previous sentence in different words, tell the
reader that something is important instead of telling them the thing, build towards a point rather
than making it, or smooth a transition between two facts that needed no smoothing. There is no list
of phrases to avoid; there is only whether the sentence adds a fact.

Length is not the measure. A long comment whose every sentence carries a constraint, a consequence,
a measurement or a trap is doing its job. A three-sentence comment with one fact in it is not.

### Do

Say why a design holds, and what breaks if it stops holding. Name the trap a reader would otherwise
walk into. Record a measurement next to the thing measured.

Every example below was written in this repository and removed from it. They are the shapes that
actually get produced, not invented bad ones.

| Written                                                                                                                                                                                     | Instead                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `It used to be legible from outside — every push carried every watched key — and now that a push carries only the asking tab's own statements, a registration nobody released is invisible` | `A push carries only the asking tab's own statements, so a registration nobody released is invisible from every individual port, and this is the one place it shows` |
| `A class rather than the two functions this used to be, because leadership moving turns "which half is this tab" into something that changes`                                               | `A class rather than a pair of functions, because leadership moving turns "which half is this tab" into something that changes`                                      |
| `Nothing about it is OPFS, which is what the name it used to have claimed.`                                                                                                                 | `Nothing about it is OPFS, and nothing in it knows what the port is made of.`                                                                                        |
| `// The socket is already gone, which is the state we were trying to reach.`                                                                                                                | `// The socket is already gone, which is the state this close is reaching for.`                                                                                      |

Each of the first three explains the present by describing a past the reader never saw. Each is
strictly worse than the same sentence with the history removed, and none of them needed it.

## Tests

Every new test must be **verified to discriminate**: break the code it covers, confirm the test goes
red, restore the code. Report which tests you verified and what you broke. A test that passes
against broken code is worse than no test, because it certifies the bug.

Assert the property, not the incidental. A count of how many times something was published is
usually not the property; that no two consecutive values repeat usually is.

## What a green suite does not prove

Three defects shipped past a full green run because Node and a browser differ:

- **Port lifecycle.** Node's `MessagePort` starts when a listener is attached; a browser's needs
  `start()`. Every follower would have waited for ever on an answer already sent.
- **Bundling.** `"sideEffects": false` let a bundler drop a worker entry point, producing a 0-byte
  `SharedWorker`.
- **Integration at a seam.** Tests registered statements by hand, so the path the React hook took
  was never exercised, and every compiled query rendered empty in a browser.

Anything browser-facing gets run in a browser. `bench/browser` holds probe pages; drive them
headless over the DevTools Protocol rather than trusting the suite.

## Verification

```
pnpm vitest run --exclude 'tests/bughunt-*.test.ts'
pnpm typecheck
pnpm exec eslint .
npx prettier --check .
pnpm --filter weft-docs build
```

Generated artifacts are committed, so a stale one is a failure. Regenerate the demos whenever schema
or codegen output moves:

```
pnpm --filter weftdb-demo-todo --filter weftdb-demo-chat --filter weftdb-demo-issues run generate
```

## Files that are not yours

`BUGHUNT-*.md` and `tests/bughunt-*.test.ts` belong to a separate effort. Never read, edit, or run
them; the vitest exclusion above is not optional.

`TODO.md` and `notes/` are gitignored working documents, written against one commit and never
updated. Nothing in them is authoritative about the current tree.

## Compatibility

Nothing here is released. Rename rather than alias, delete rather than deprecate, and change a wire
format, a storage key or a lock name outright. Keeping a superseded answer beside the current one
invites somebody to wire it up.
