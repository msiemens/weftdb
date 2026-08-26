# Documentation style guide

Rules for prose in `docs/src/content/docs/**`.

This file does not govern `DESIGN.md`, package READMEs, source comments, or commit messages.
Those have their own established voice and are written for contributors. Documentation pages are
written for people using the library.

## 1. Voice

The register is **technical and impersonal**. Write as a reference manual, not as a person
talking to the reader and not as a product announcement.

| Dimension                 | Setting                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| Formality                 | Neutral technical. Not conversational, not academic                         |
| Person                    | Second person for what the reader does. No first person, singular or plural |
| Enthusiasm                | None. State capabilities and limits at the same volume                      |
| Stance                    | Descriptive. The documentation reports what the software does               |
| Humour, asides, anecdotes | None                                                                        |
| Confidence                | High where the behaviour is defined. Explicit where it is not               |

Concretely:

| Rule                           | Example                                             |
| ------------------------------ | --------------------------------------------------- |
| Second person for instructions | `Run weft generate after every schema edit.`        |
| Present tense                  | `The server stores field state in generic records.` |
| Active voice                   | `The client applies the batch.`                     |
| Imperative for procedure steps | `Set WEFT_TOKENS before starting the relay.`        |

Use "you" for the reader. Do not use "we", "our", "let us", or "I". The documentation has no
narrator. Where a sentence wants "we recommend", state the recommendation as a fact about the
software or as an instruction: `Regenerate artifacts after every schema edit.`

Refer to the library as `weftdb`, lowercase, in a code span when naming the package and plain when
naming the project.

### Calibration

These three describe the same behaviour. Only the third is in register.

| Register        | Text                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Too personal    | `You will probably find that diff3 saves you a lot of pain here. We think it is the right default for prose.`                                          |
| Too promotional | `weftdb ships a powerful three-way merge that seamlessly resolves conflicting edits.`                                                                  |
| Correct         | `Fields annotated `merge: "diff3"` are merged three ways against the device's last-synced value. Overlapping edits produce marker syntax in the text.` |

Limits are written in the same voice as features. `The relay has no rate limiting.` is a
sentence, not an apology and not a warning label.

### Where the repository differs

`DESIGN.md`, the package READMEs, and source comments use a looser voice with rhetorical
contrast, em dashes, and figurative language. That is deliberate and stays as it is. Do not carry
it into `docs/src/content/docs/**`, and do not copy sentences from those files into a page
without rewriting them to this register.

## 2. Prohibited constructions

| Construction                                                                                                             | Replace with                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Em dash (`—`)                                                                                                            | A period, semicolon, colon, or parentheses |
| Rhetorical contrast (`X is not A; it is B`)                                                                              | A direct statement of what X is            |
| Metaphor or analogy                                                                                                      | A literal description of the mechanism     |
| Editorial adjectives (`elegant`, `powerful`, `simply`, `just`)                                                           | Nothing. Delete them                       |
| Hedging (`arguably`, `it could be said`, `perhaps`)                                                                      | A definite statement, or omit the claim    |
| Rhetorical questions                                                                                                     | A statement, or a heading                  |
| Exclamation marks                                                                                                        | A period                                   |
| Appeals to the reader's feelings (`you will love`)                                                                       | The technical fact                         |
| Sales language (`blazing fast`, `seamless`)                                                                              | A measured figure, or nothing              |
| Counting a list before giving it (`the relay does five things:`, `for three reasons:`, `Two rules look like exceptions`) | The sentence without the count             |

Statements of limitation are required, not prohibited. Write "The static build has no proxy, so
demo tabs do not sync without a relay at `/api`." Do not soften it and do not dramatise it.

### Do not announce a count

A sentence whose payload is how many items are coming makes the reader wait for the items, and the
count itself tells them nothing they cannot see. It is the shape a listicle headline uses, and it
reads as one.

Cut the number and let the list speak:

| Written                                                           | Rewritten                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| The relay does five things, none requiring knowledge of a schema: | None of what the relay does requires knowledge of a schema: |
| SQLite is used rather than IndexedDB for three reasons:           | SQLite is used rather than IndexedDB because:               |
| `update()` does four things as one synchronous unit:              | `update()` runs as one synchronous unit:                    |

A number is not banned. It stays when it is the fact, not the preamble: a closed set the reader must
know is closed ("a rank is one of `lww`, `diff3`, `fracIndex`, or `immutable`, and there are no
others"), a measurement ("29 pages"), a limit ("at most 8MB"), or a name for a mechanism ("a
three-way merge", "the two liveness registers"). The test is whether the sentence still says
something once the number is removed. If it does, remove it.

Headings follow the same rule: `## Where the scope is enforced`, not `## Two enforcement points`.

## 3. Present tense, not history

Documentation describes weftdb as it is now, for a reader who has never seen it before and does
not need to know how it got here. A sentence that narrates the project's history, the writer's
process, or the documentation itself gives that reader nothing to act on. Rewrite it as a fact
about the software, or delete it.

| Construction                                                                                                                                                | Replace with                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| History (`was replaced by`, `used to`, `originally`, `no longer`, `previously`, `has been changed to`, `was removed`)                                       | The present behaviour                         |
| Recency (`now supports`, `recently added`, `new in`, `as of`, `currently`, where it means "at the time of writing")                                         | The capability, stated as a plain fact        |
| A paragraph justifying why an option, value, or feature is absent                                                                                           | Silence. An absent feature is not documented  |
| Meta-commentary about the documentation (`this page covers`, `as mentioned above`, `we will see`, `the following section explains`, `note that this guide`) | Delete it, or state the fact the reader needs |
| First-person or editorial narration of a choice (`we chose`, `it was decided`, `the team went with`)                                                        | The resulting behaviour, with no narrator     |
| A design justified against an alternative that was never shipped, where the alternative is not one a reader would otherwise expect                          | Delete it                                     |

Silence is not the same as a stated limit. "The relay has no rate limiting" describes the software
as it stands, not a change it went through, and it stays at the same volume as a feature under
section 2's rule on limitation. Delete a sentence that explains an absence nobody would assume
otherwise. Keep one that heads off an assumption a reader would make and be harmed by: "Two people
cannot type into one field at once" is a fact a reader needs, not history.

Rationale for why a mechanism works, on a concept page, is not history either. A concept page's job
is explaining why a design holds, and that explanation belongs as long as it describes the
mechanism itself and not the process, or the unshipped alternatives, that produced it.

## 4. Sentences and paragraphs

- One claim per sentence.
- Target 25 words per sentence. Split anything over 35.
- Target 5 sentences per paragraph.
- Wrap source lines at 100 characters. Do not reflow a paragraph for an unrelated edit. Table rows,
  long URLs, and the frontmatter `description` are exempt, because none of them can be broken
  across lines. The `description` is governed by its own 160-character limit in section 5.
- Put the conclusion in the first sentence of the paragraph.

## 5. Page structure

Every page begins with frontmatter:

```yaml
---
title: Defining a schema
description: Collections, event logs, field types, merge annotations, and retention anchors.
sidebar:
  order: 1
---
```

| Field           | Rule                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| `title`         | Sentence case. Under 40 characters. Matches the sidebar entry                        |
| `description`   | One sentence, ending in a period, under 160 characters. Used as the meta description |
| `sidebar.order` | Integer. Controls position within an autogenerated section                           |

The first paragraph states what the page covers. Do not open with a restatement of the title or a
sentence about what the page will do, and do not open with a definition of the product.

`/introduction/` is the one exception, and it is required to open with that definition. It must
say in its first sentence that weftdb is a TypeScript library that an application is built with.
Without it the page reads as a description of a consumer product, and a reader arrives expecting
file syncing or a storage service. State the category before anything else.

Do not write an H1. The `title` supplies it. Use H2 for sections and H3 for subsections. Do not
use H4 or deeper; if a page needs one, split the page.

## 6. Headings

- Sentence case. Capitalise only the first word and proper nouns.
- No terminal punctuation.
- Guides use gerunds: `Defining a schema`, `Running the relay`.
- Concepts and reference use noun phrases: `Merge model`, `CLI reference`.
- Do not use a heading as the subject of the sentence that follows it. Each section reads on its
  own.

## 7. Code samples

- Every fence declares a language: `ts`, `tsx`, `sh`, `sql`, `json`, `yaml`.
- Add `title="src/schema.ts"` when the sample belongs in a named file.
- Samples compile or run as written. Do not use `...` as a placeholder. If a sample is partial,
  use a comment naming what is omitted: `// mutators for the other collections`.
- Import from published entry points (`weftdb/schema`), never from source paths
  (`../../packages/weftdb/src/schema`).
- Shell samples contain one command per line.
- A command with no output shown takes no `$` prefix.
- A command shown _with_ its output goes in one block, not two: prefix the command with `$`, leave
  a blank line, then the output. Two blocks render as two stacked frames with nothing tying them
  together, and the reader has to infer that the second is the first one's result.
- Output of a line or two reads better in prose than in a block at all. Prefer
  ``That prints `Write the quick start`.`` over a frame containing four words.
- Sample identifiers use the same names across pages. Reuse `tasks`, `todos`, `user-1`, `laptop`.

### Diagrams

A `mermaid` fence renders as a diagram. Use one where the subject is a relationship between parts or
an exchange between them over time, and prose would be a list of edges. A diagram that restates a
paragraph earns nothing.

- Concept pages only. A guide showing a procedure uses an ordered list.
- Label nodes with the identifier the reader will meet in source: `WeftClientMirror`, not `Mirror`.
- Node and note text is prose, and section 2 applies to it. No em dashes, no rhetorical contrast.
- A note in a sequence diagram states what happens at that step. It does not argue for the design.
- The diagram is not the explanation. The paragraph after it says what the reader should take from
  it, and holds every fact the page relies on later.

## 8. Terminology

### Introduce a term before using it

A term from the table below may be used only after the page has said what it means, or after it
has linked to somewhere that does. That may be the page owning the term, or
[Glossary](/reference/glossary/), which defines every term in one line and names its owning page.
Linking is usually better than glossing: a definition repeated on eight pages is eight definitions
to keep in step. This binds hardest on `/introduction/` and `/quick-start/`, which are read by
people who have never seen the project.

A term added to the table below is added to the glossary in the same change, with the page that
covers it. A term with no owning page is a gap in the documentation, not a glossary entry that
stands alone.

A reader who meets `HLC`, `field store`, `scope`, `tombstone`, `quarantine`, `diff3` and
`snapshot resync` in one page learns nothing from any of them. On an orientation page, prefer the
plain description and give the term afterwards, or leave the term out entirely and let the concept
page introduce it:

| Page         | Write                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| Introduction | `the later edit wins, and which one is later is decided by a clock reading that every device compares the same way` |
| Concept page | `Each field carries an HLC. The higher HLC wins.`                                                                   |

Acronyms are expanded at first use on every page, including reference pages.

### The canonical names

| Use              | Do not use                   |
| ---------------- | ---------------------------- |
| relay            | server, backend, sync server |
| scope            | user, tenant, workspace      |
| device           | client, tab, browser         |
| field store      | EAV table, key-value store   |
| outbox           | pending queue, write queue   |
| quarantine       | conflict table, error queue  |
| tombstone        | deleted marker, soft delete  |
| HLC              | timestamp, clock value       |
| snapshot resync  | full sync, refresh           |
| merge annotation | merge strategy, CRDT type    |
| artifact         | generated file, output       |

"Client" is permitted when naming the `WeftClient` type or the client half of the protocol. Use
"device" when referring to a physical participant in sync.

Package names appear in code spans and lowercase: `weftdb`, `weftdb-cli`, `weftdb-react`,
`weftdb-demo-shared`, `weftdb-demo-todo`.

### Naming the project

Write `weftdb` as plain lowercase text. A rehype plugin renders every prose mention as the
wordmark, with `weft` in bold and `db` in the accent colour, so pages carry no presentation in
their source and the treatment cannot drift between them.

Consequences to write around:

- Do not hand-mark it with bold, a span, or HTML. The plugin does it.
- Inside a code span it stays literal, because there it is a package name being quoted.
- A longer word containing it is left alone, so `weftdb-cli` renders as written.
- Headings and link text are left alone, where a second weight or colour would fight the type or
  the link colour. Do not write a heading that depends on the wordmark appearing.

## 9. Identifiers

Wrap in backticks: file paths, directory names, field names, column names, environment variables,
commands, flags, type names, package names, and literal values.

Write type and function names exactly as they appear in source, including case. Do not pluralise
an identifier inside its code span; write ``two `RowId` values``.

## 10. Links

- Link text is the target page title or a noun phrase describing the target.
- Do not use `here`, `this page`, `see this`, `click`, or a bare URL as link text.
- Internal links use absolute paths with a trailing slash: `/concepts/merge-model/`.
- One link per concept per page. Do not link the same target three times in one section.
- Never link to `DESIGN.md`, and do not cite it by section number either. Nothing serves it from
  the built site, so a link is broken and a section reference sends a reader somewhere they cannot
  go. `DESIGN.md` is a source you write _from_, never a destination you point _at_: state the fact
  the specification establishes, and link to the concept page that owns it. If no page owns it
  yet, state the fact anyway.

## 11. Asides

Starlight provides four. Choose by consequence, not by emphasis.

| Aside     | Use when                                                   |
| --------- | ---------------------------------------------------------- |
| `note`    | Information the reader needs that interrupts the procedure |
| `tip`     | An optional technique that is not required for correctness |
| `caution` | An action that can produce a wrong result                  |
| `danger`  | An action that can lose data or expose credentials         |

Rules:

- Maximum one aside per H2 section.
- One to three sentences.
- Never the first element on a page.
- Do not put a code sample inside an aside. Put the sample in the body and the warning beside it.

## 12. Tables

- Use a table for an enumeration where each item has two or more attributes.
- Header cells in sentence case.
- Body cells are fragments without terminal periods.
- Five columns maximum. Wide tables scroll and become unreadable on a phone.
- Do not use a table for a sequence of steps. Use an ordered list.

## 13. Lists

- Introduce a list with a sentence ending in a colon.
- Keep items in parallel grammatical form.
- Terminal periods only when items are complete sentences.
- Use an ordered list when order matters. Otherwise use an unordered list.
- A list of two items is usually a sentence. Write the sentence.

## 14. Numbers, units, and values

- Numerals for all quantities, including one through nine.
- Space between number and unit: `30 seconds`, `8 MiB`. No space before `%`.
- Use the unit the source uses. The body cap is `8 MiB`, the chunk size is `32KB`.
- Literal configuration values go in code spans: `30s`, `8787`, `WEFT_PORT`.
- Durations in prose are spelled out: "pings every 30 seconds".
- Version numbers are exact. Do not write "the latest version".

## 15. Spelling and punctuation

- British English in prose: `behaviour`, `colour`, `serialise`, `authorisation`.
- Identifiers, CSS properties, and API names keep their source spelling. Write "the `color`
  property" and "the authorization header" when quoting them.
- Serial comma.
- One space after a period.
- Ranges use "to": `1 to 5`. Do not use an en dash for a range in prose.
- Quotation marks are straight in code spans and typographic in prose.

## 16. What belongs on which page

| Page type   | Contains                                          | Excludes                            |
| ----------- | ------------------------------------------------- | ----------------------------------- |
| Guide       | Procedures, configuration, worked examples        | Rationale beyond one sentence       |
| Concept     | Mechanism, constraints, the reason a design holds | Step-by-step instructions           |
| Reference   | Exhaustive parameters, flags, defaults            | Narrative, worked examples          |
| `DESIGN.md` | The specification and its numbered invariants     | Anything written for a library user |

If a guide needs three paragraphs of rationale, move them to a concept page and link. If a
concept page needs a procedure, move it to a guide and link.

Do not duplicate content across pages. One page owns each fact; every other page links to it.

## 17. Review checklist

Before merging a documentation change:

- [ ] No em dashes.
- [ ] No editorial adjectives or hedging.
- [ ] No sentence or heading that counts a list before giving it.
- [ ] Every code fence has a language, and samples run as written.
- [ ] Terminology matches section 8.
- [ ] No dev-diary voice: no history, no recency, no absent-feature justification beyond a stated
      limit, no meta-commentary about the documentation.
- [ ] Link text names its target.
- [ ] Frontmatter has `title`, `description`, and `sidebar.order`.
- [ ] No H1, no H4.
- [ ] Facts stated once, in the page that owns them.
- [ ] `pnpm --filter weft-docs build` succeeds.
