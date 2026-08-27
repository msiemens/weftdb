# Working in this repository

Project rules. The global rules in `~/.claude/CLAUDE.md` also apply and are not repeated here.

## Prose in Markdown

`docs/STYLE.md` governs everything under `docs/src/content/docs/**`. Read it before editing any page
there, every time. Its register cannot be inferred from the surrounding text.

Run the checker on every page you touch:

```
node scripts/style-check.mjs docs/src/content/docs/concepts/scopes.md ...
```

Fix the hits in prose you wrote. Leave pre-existing hits alone; §4 forbids reflowing a paragraph for
an unrelated edit, so a page you touched can still report hits that are not yours. List them in your
report.

A clean report covers the mechanical checks only. The checker does not evaluate register. It does not
check whether a heading is a noun phrase on a concept page and a gerund on a guide, whether a
sentence is rhetorical contrast, whether a paragraph justifies a feature's absence, or whether a
sample runs as written. Read the sibling pages before inventing a heading.

`STYLE.md` does not govern `DESIGN.md`, package READMEs, source comments, commit messages,
`TODO.md`, or `notes/`. Those use a looser voice. Keep the two registers separate in both
directions.

## Code comments

These rules cover source comments, commit messages, assertion messages, and this file. An assertion
message is prose read while debugging a failure and is held to the same standard as a comment.

They do not cover comment text inside a codegen template, which is data. It is emitted into committed
artifacts, changing it requires regenerating them, and the test suite does not report the difference.
The `\*` comments inside the TLA+ template in `tests/trace-validation.test.ts` are also data, written
for a different tool.

Write a comment only when it records something the code cannot.

### Do not write

**History of the code.** Marker phrases: `used to`, `no longer`, `previously`, `originally`,
`was replaced by`, `this now does`. State the current behaviour.

**A restatement.** If the comment says what the line below says, delete it.

**The conversation that produced the code.** Marker phrases: `as requested`, `as discussed`,
`per review`, `we decided`, `the user wants`, `leaving this for now`. These are rare and easy to
grep.

**A comment whose subject is a decision.** This form usually contains no marker phrase. Shapes to
look for: `on purpose`, `deliberately`, `rather than X` where X was never under consideration, a
defence of a choice no reader would question, an explanation of why something is absent.

Test: would a reader arriving cold have raised the objection this sentence answers? If not, delete
the sentence.

**Rhetorical contrast.** Shapes: `X, not Y`, `X rather than Y`, `not because A but because B`. Each
introduces an alternative in order to dismiss it. State the positive and its reason instead.
`Read off the global because one line of source then serves a browser and Node` needs no rejected
alternative. `The public surface is listed, not inherited: a new export reaches consumers only from
here` reduces to its second clause, which carries the whole fact.

**A comment on an absence.** A name that is not exported, a case that is not handled, and a fallback
that does not exist need no comment.

**Sentences that carry nothing.** Test every sentence by deleting it and rereading. If nothing was
lost, leave it deleted. Expect to delete a lot. Failing sentences restate the code, restate the
previous sentence in other words, assert that something is important instead of stating it, build
towards a point instead of making it, or smooth a transition between two facts that needed none.
There is no list of phrases to grep for; the test is whether the sentence adds a fact.

Judge a comment by facts per sentence. A long comment carrying a constraint, a consequence, a
measurement, or a trap in every sentence is fine. A three-sentence comment carrying one fact is not.

**A count of what follows.** Examples found here: `Two things carry a device's writes`, `the two
members that say how`, `Best effort twice over`, `the same four things over either surface`. A count
commits the prose to a structure it must maintain, and carries nothing the items do not carry
themselves. One commit message announced four faults and described six.

Name the first item and let the rest follow. `Two things carry a device's writes. WeftClient applies
them itself…` reduces to `WeftClient applies a device's writes itself…`.

A number is correct when the number is the fact: `10/10 rounds`, `441 tests`, `SQLite binds no
boolean`, `Two ways in is one more than a deployment meant to configure`. Delete the number if the
sentence still means the same thing without it.

`comment-check.mjs` reports `<number> things` at the `error` tier and the looser forms (`two ways`,
`three kinds`, `twice over`) at `review`.

**Em dashes and most colons.** An em dash attaches a clause without stating how it relates to the one
before it. A colon promises an explanation the reader must assemble. Use a full stop where the
thought ended, `because` where the second half is the reason, and a comma with a conjunction where
the halves are one thought. If none of those fit, the halves are unrelated and one of them is filler.

A colon is correct before a list or a quoted sample. `comment-check.mjs` reports colons at `review`
and em dashes at `error`. Colons inside code spans and URLs are not counted.

**Decorative prose.** This is the most common remaining fault here. Look for sentences that build
towards a point instead of making it, metaphor in place of a plain fact, aphorism carrying less than
a measurement would, parallel structure doing work that content should do, and length
disproportionate to the facts carried.

**A comment attached to nothing.** TypeScript reads the `/** */` block immediately before a
declaration and ignores anything earlier, so a doc block followed by another doc block is read by
nobody and displayed by no editor. Two such comments exist in this tree. Write file headers as `//`
blocks; a `/** */` file header attaches to whatever declaration follows, or to nothing.

`comment-check.mjs` reports a doc block followed by a doc block at `error`. It does not detect a doc
block attached to the wrong declaration, which is the same fault and also occurs twice here.

**A `§` reference to a line number.** Comments in this tree cite `DESIGN.md` about a hundred times.
Three cited `§259`, a line number, which stopped resolving the first time `DESIGN.md` was edited.
Cite a section. `comment-check.mjs` resolves every `§` against the headings in `DESIGN.md` and
`docs/STYLE.md`, and against the length of the numbered list where a section numbers its parts that
way.

### Do write

State why a design holds and what breaks if it stops holding. Name the trap a reader would otherwise
walk into. Record a measurement beside the thing measured.

Where a constraint forces an unobvious shape, state the constraint. `Firefox refuses
createSyncAccessHandle() inside a SharedWorkerGlobalScope` is a fact about the world. `We went with
the lock instead` is a fact about a meeting.

If a task asks you to justify a decision, put the justification in the report. Being asked to explain
a choice does not license explaining it in the source.

### Examples

Each left-hand cell was written in this repository and later removed. The left column retains the
fault it demonstrates.

| Written                                                                                                                                                                                     | Instead                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `It used to be legible from outside — every push carried every watched key — and now that a push carries only the asking tab's own statements, a registration nobody released is invisible` | `A push carries only the asking tab's own statements, so a registration nobody released is invisible from every individual port, and this is the one place it shows` |
| `A class rather than the two functions this used to be, because leadership moving turns "which half is this tab" into something that changes`                                               | `A class rather than a pair of functions, because leadership moving turns "which half is this tab" into something that changes`                                      |
| `Nothing about it is OPFS, which is what the name it used to have claimed.`                                                                                                                 | `Nothing about it is OPFS, and nothing in it knows what the port is made of.`                                                                                        |
| `// The socket is already gone, which is the state we were trying to reach.`                                                                                                                | `// The socket is already gone, which is the state this close is reaching for.`                                                                                      |
| `// Below the entry point on purpose: query compilation and the worker's reply shape are internals the package assembles for itself, so they are reached where they are declared.`          | Delete it                                                                                                                                                            |

Rows 1 to 3 explain the present by describing a past the reader never saw.

Row 5 contains no history, no first person, and no reference to a conversation, so text searches over
this tree did not find it. It was written because a task asked for each export decision to be
justified and the justification went into the file instead of the report. A reader would have to be
asking "why is this not exported?" for the sentence to be worth writing.

## Briefing subagents

Do not ask an agent to justify its decisions in its report. A brief that says "say why" produces
justification-shaped comments in the source, because the agent writes the reasoning while working and
the source is where it is working. `on purpose`, a contrast defending an unquestioned choice, and a
comment whose subject is the export surface all trace back to a brief that asked for reasons.

Ask for what happened:

- what changed, by file
- what was deleted, and the line count
- which tests were verified to discriminate, and what was broken to prove each one
- what turned out to be wrong in the spec once they reached it
- what was left undone

Where a judgement needs explaining, ask for the alternatives and the evidence, and state in the same
sentence that it belongs in the report and not in the tree.

Give every agent `node scripts/comment-check.mjs <files>` as a required step, and run it against
their output before accepting the work. The brief alone is not sufficient.

Bound every test run an agent makes: `timeout 300 pnpm vitest run <file> --testTimeout=15000`. An
unsettled promise hangs the runner instead of failing it, and an unbounded run costs minutes before
producing any information.

Partition scopes by directory and state the boundary explicitly. Agents that spawn their own forks
drift outside their scope and collide with each other. Verify each agent's claims against the tree
rather than accepting its report; two agents in one sweep reported clean scopes that were not clean.

Do not redirect a running agent to a different task. An agent briefed to distrust injected
instructions treats the redirect as one and continues with its original task. Stop it and dispatch a
new one.

## Tests

Verify every new test discriminates: break the code it covers, confirm the test goes red, restore the
code. Report which tests you verified and what you broke. A test that passes against broken code
certifies the bug.

Assert the property the code must hold. A count of how many times something was published is usually
incidental; that no two consecutive values repeat is usually the property.

## What a green suite does not prove

These defects shipped past a full green run because Node and a browser differ:

- **Port lifecycle.** Node's `MessagePort` starts when a listener is attached; a browser's needs
  `start()`. Every follower would have waited for ever on an answer already sent.
- **Bundling.** `"sideEffects": false` let a bundler drop a worker entry point, producing a 0-byte
  `SharedWorker`.
- **Integration at a seam.** Tests registered statements by hand, so the path the React hook took was
  never exercised, and every compiled query rendered empty in a browser.
- **Close events.** `MessagePort` fires `close` under `node:worker_threads` and in no browser, so a
  green suite asserted that a tab notices its dead `SharedWorker` while every browser left it
  unaware.

Where a test fake can model the browser's weaker guarantee, write it that way. That catches this
class of defect without a browser.

Run anything browser-facing in a browser. There is no harness for this yet, so it means building a
demo and driving it headless over the DevTools Protocol by hand. `TODO.md` records what a standing
harness would need to cover.

## Verification

```
pnpm vitest run --exclude 'tests/bughunt-*.test.ts'
pnpm typecheck
pnpm exec eslint .
npx prettier --check .
pnpm --filter weft-docs build
node scripts/comment-check.mjs --all
```

`comment-check.mjs` exits non-zero on its `error` tier. It matches wording, so a clean report leaves
the sentence that is grammatical, on topic, and carries nothing for a reader to find.

Generated artifacts are committed, so a stale one is a failure. Regenerate the demos whenever schema
or codegen output changes:

```
pnpm --filter weftdb-demo-todo --filter weftdb-demo-chat --filter weftdb-demo-issues run generate
```

## Files that are not yours

`BUGHUNT-*.md` and `tests/bughunt-*.test.ts` belong to a separate effort. Never read, edit, or run
them. The vitest exclusion above is not optional.

`TODO.md` and `notes/` are gitignored working documents, written against one commit and never
updated. Nothing in them is authoritative about the current tree.

## Compatibility

Nothing here is released. Rename instead of aliasing, delete instead of deprecating, and change a
wire format, a storage key, or a lock name outright. Do not leave a superseded answer beside the
current one.
