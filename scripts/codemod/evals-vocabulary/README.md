# Evaluator-vocabulary codemod

A scanner that proposes the renames in
[`docs/evals-vocabulary-consolidation.md`](../../../docs/evals-vocabulary-consolidation.md)
and refuses to perform them.

```bash
npm run codemod:evals-vocabulary:report          # regenerate REPORT.md
node scripts/codemod/evals-vocabulary/index.mjs --json
node scripts/codemod/evals-vocabulary/index.mjs --root ../mcpjam-backend
```

| exit | meaning |
|---:|---|
| 0 | a report was written |
| 1 | it scanned nothing, or was asked to `--write` |
| 2 | the mapping proposes to mutate a protected term or path |

## Why there is no `--write`

The words this program renames are ordinary English in this repository and
load-bearing identifiers in four unrelated subsystems: GitHub check runs, OAuth
and protocol conformance checks, SAML identity assertions, and billing trials.
A fifth, the evaluator-**error** family (`maxEvaluatorErrorRate`,
`failureCategory: "evaluator"`), already uses the word this program is adopting,
for a different thing.

So the value here is the inventory, not the edit. A reviewer reads the report to
size the surface and to find the places where the same token means two things;
the renames themselves land in PRs a human reviews against the pinned contract.
A script that rewrote 422 occurrences across 93 files and asked for a rubber
stamp would be asking for the one thing nobody can give it.

## The two severities

**Proposing to mutate a protected term, or anything inside a protected path,
fails the run.** The scanner cannot tell a GitHub check run from a grading check
by looking at the token, so it refuses to guess. The fix for such a failure is
to narrow `mapping.json`'s `paths` — never to widen `protected.json`, which is
the same thing as deciding the term was not protected after all.

**Proposing a rename on a line that merely mentions a protected term is a review
note.** `evaluatorErrorRate` sits beside genuine evaluator code throughout the
verdict policy; failing on proximity would make the tool unrunnable, and a tool
nobody runs protects nothing.

## Why it parses

`checks`, `predicates` and `repetitions` appear in prose, in comments, in four
other subsystems and in test fixtures. A line-based grep reports all of them,
the reviewer stops reading at the fiftieth false positive, and the report has
bought nothing.

It uses TypeScript's **parser**, not its raw scanner, and the difference is not
academic — the first version of this tool used the scanner and got two things
wrong that a reviewer caught:

- A bare scanner has no parser context, so the text after an interpolation in a
  template literal comes back as ordinary identifier tokens, and so does JSX
  text. The first generated report proposed renaming `Scorer` out of two error
  messages on that basis.
- The token lookahead recognized a wire field only as `name:`, so it missed
  `repetitions?: number`, `{ checks }`, a destructured binding, and
  `row?.checks` — four of the five shapes a field actually takes. Fixing it
  moved the inventory from 422 occurrences to 732, which is the difference
  between an inventory and a sample.

TypeScript is already installed for the build, so this costs no new dependency
and no lockfile entry — which matters when the report has to run identically in
CI and on a laptop mid-stack.

## Why it fails closed

Three ways it refuses to produce a report rather than produce a misleading one:

- A path it cannot walk, stat or read is fatal. An inventory with a hole in it
  reads as complete, and the next person renames from it.
- Reading zero SOURCE files is fatal, even from a root full of other things. A
  clean empty report is otherwise indistinguishable from a clean real one.
- Generation writes to a temporary file and moves it into place only on success,
  so a protected-match exit leaves the committed report intact. Shell
  redirection truncates its target before the program starts, which meant the
  first version emptied `REPORT.md` on precisely the failure the tool exists to
  surface.

## The tables

- `mapping.json` — what to rename, at what scope, and where. `identifier` and
  `subpath` renames are repository-wide unless a `paths` allowlist narrows them;
  `wire-field` renames are always path-restricted, because those four words are
  English.
- `protected.json` — the terms and paths that mean something else.
- `REPORT.md` — the generated inventory, committed so a reviewer can read it
  without running anything.

Both tables are overridable (`--mapping`, `--protected`) so the refusal itself
can be tested against a mapping that genuinely proposes a protected word. The
committed mapping proposes none.
