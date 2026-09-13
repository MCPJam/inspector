# Evaluator-vocabulary codemod

A scanner that proposes the renames in `docs/evals-vocabulary-consolidation.md`
and refuses to perform them.

That contract is **not in this branch**, and the omission is deliberate rather
than an oversight: it lands in the Wave 0 pull request
([#4982](https://github.com/MCPJam/inspector/pull/4982)), which this scanner is
independent of so that either can merge first. Until Wave 0 lands, read the
contract there — a reviewer checking `mapping.json` against the model needs the
document, and a relative link that resolves to nothing in this tree would be
worse than saying where it is.

```bash
npm run codemod:evals-vocabulary:report          # regenerate REPORT.md
node scripts/codemod/evals-vocabulary/index.mjs --json
node scripts/codemod/evals-vocabulary/index.mjs --root ../mcpjam-backend
```

| exit | meaning                                                 |
| ---: | ------------------------------------------------------- |
|    0 | a report was written                                    |
|    1 | it scanned nothing, or was asked to `--write`           |
|    2 | the mapping proposes to mutate a protected term or path, or to merge two fields |

`npm run codemod:evals-vocabulary:report` runs `report.mjs`, which writes
`REPORT.md` only on a clean run and exits with the scanner's own code. The
earlier shell chain turned every failure into exit 1, so a refusal looked the
same as a run that scanned nothing.

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
A script that rewrote 803 occurrences across 106 files and asked for a rubber
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

## Two fields must not become one

A wire-field rename onto a name its own files still use is refused (`rename
target in use`). The configured count is why: `repetitions` is its legacy
spelling and becomes `iterations`, but the same adapters already carry a legacy
`iterations` that the legacy resolver reads as a floor. Renaming onto it would
make one field out of two counts.

So the occupied name is vacated first, by its own rename (`iterations →
legacyIterations`), and the dependent rename says so with `"after":
"iterations"`. A vacated target without `after` is refused at the mapping
(`unordered rename`), because an inventory that does not say which lands first
invites the blind sweep. The report prints the order under each dependent
rename.

A rename may instead declare `"sameMeaning": true` when the occupied name
already means the same thing, so joining the spellings is the rename itself.
The three renames onto `assertions` declare it: the suite file's deprecated
`assertions` is the same list of rules as `checks`. The count rename must never
declare it, because a floor and an exact count are two fields.

The `repetitions` key inside the configuration-revision payload
(`convex/lib/evalConfigRevision.ts`) is a different matter: it never moves.
`protected.json` protects it, with `runs`, `predicates` and
`defaultPredicates`, so a rename widened far enough to reach that file fails.

The guard works per file, not per row. `iterations → legacyIterations` and
`repetitions → iterations` share their `paths`, so inside those files the
target always reads as vacated. Those same files hold the legacy floor, the
deprecated alias of the count, and lists of iteration records side by side,
and only a person can tell which `iterations` is which. Triage each row under
`iterations → legacyIterations`. The "lands after" line is an ordering, not a
proof.

## Outside the mapping

A rename that sets `"inventoryOutsidePaths": true` also lists every spelling of
its `from` outside its `paths`, at the end of the report, as work left rather
than as proposals. The count rename sets it. Widening its `paths` instead is
not an option: that reaches files where `iterations` already names lists of
iteration records, and the target-in-use guard refuses the merge. Protected
paths are not listed. A protected field, such as the configuration-revision
`repetitions` key, is listed as frozen rather than as work. Run with
`--root ../mcpjam-backend` for the backend's share.

A string in a type position, like `unit: "iterations" | "sessions"`, is reported
with the shape `string in a type`. It usually names an enum value, not a field.

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

## What it reads

What git sees: tracked files plus untracked files that are not ignored, through
`git ls-files`. A filesystem walk with a hand-kept skip list read ignored
`worktrees/` checkouts on a real laptop and took minutes; the repository's own
`.gitignore` is the only skip list that stays true. A root that is not a git
work tree falls back to the walk.

## Why it fails closed

Three ways it refuses to produce a report rather than produce a misleading one:

- A path it cannot stat or read is fatal. An inventory with a hole in it reads
  as complete, and the next person renames from it. A symlink is the exception:
  it is listed as skipped and never followed, because a dangling one names
  nothing and a live one is either scanned under its own path or is not this
  repository's to rename.
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
  `wire-field` renames are always path-restricted, because those words are
  English. `after` names the rename that must land first.
- `protected.json` — what means something else. `terms` are exact tokens;
  `termFamilies` are patterns that protect every member of a family
  (`githubCheck*` covers `githubCheckRunId` and `GithubCheckRepoConfigRow`),
  each spelling its case variants explicitly; `fields` protect one field name
  only in the files that own it, like the customer-authored `checks:` key of
  `mcpjam.yml`; `paths` are path prefixes. Billing trials are protected by
  path (the client billing files and, under `--root ../mcpjam-backend`, the
  Convex billing modules) and by pattern (`trialPlan`, `isTrial`,
  `starterTrial*`), never by the eval counters `configuredTrials` and friends,
  so an eval-trial rename can proceed without touching billing.
- `REPORT.md` — the generated inventory, committed so a reviewer can read it
  without running anything.

Both tables are overridable (`--mapping`, `--protected`) so the refusal itself
can be tested against a mapping that genuinely proposes a protected word. The
committed mapping proposes none.
