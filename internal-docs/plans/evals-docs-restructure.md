# Evals docs restructure

Status: **draft for review**. Nothing under `docs/` changes in this PR; it agrees the structure
before any page is written.

Clickable mock with every page outlined: open [`evals-docs-mock.html`](./evals-docs-mock.html) in a
browser (it is self-contained; start on "Plan & progress").

## Problem

`docs/inspector/evals.mdx` is one page of about 8,500 words under 45 headings. Readers can't find
the assertion table, the grading rules or the CI behaviour without scrolling past everything else,
and search lands them in the middle of a wall of text.

## Inputs

- Today's `docs/inspector/evals.mdx`, `inspector/eval-test-users.mdx`, `cli/local-evals.mdx`,
  `cli/ci.mdx` and `sdk/concepts/running-evals.mdx`.
- Figma **Docs v2** (`gOcRWMCFy61N4kJF7KzaRJ`), "CURRENT · Docs tab" (Nov 17, rev 2): Evaluate is
  a group in the Docs tab with five task pages and three reference pages. Its notes hold widget
  interactions and execution budgets back until confirmed, and drop "case spine" and "route
  question" from the vocabulary.
- Promptfoo's eval docs: intro → getting started → configuration → assertions and metrics → usage
  → integrations.
- Claude Code's `plugin-evals` page: one page inside Plugins → Create plugins, between building and
  publishing. Patterns worth copying: an audience line with "use X instead", a cost callout before
  the first command, generate-first quickstart, a "what a run can access" section, field tables in
  the reference, troubleshooting headed by exact error strings.

## Decision: top-level tabs

Keep tabs on one axis. CLI, SDK and API name **where** you work; "Evals" names **what** you're
doing. A separate Evals tab would give "run evals from the CLI" two plausible homes, and tabs reset
the sidebar so Get started → first eval would cross a tab.

| Option | Tabs | Verdict |
| --- | --- | --- |
| A | Docs · CLI · SDK · API, Evaluate as a group in Docs | **Recommended.** Matches Figma rev 2 and today's `docs.json`; no URL churn outside Evaluate. |
| B | Docs · Evals · CLI · SDK · API | Mixes job and surface tabs. Rejected. |
| C | Debug · Evaluate · Reference | Cleanest end state, but re-homes every CLI/SDK guide. Revisit once CLI and SDK tabs are reference only. |

Follow-up: move the eval guides out of the CLI and SDK tabs into Evaluate pages as App / CLI / SDK
tabs, with redirects. That gets most of C without the churn.

## Proposed Evaluate group

No sub-group has more than five entries (Figma's rule is at most seven top-level entries per group).

| Sub-group | Page | Figma page | Source |
| --- | --- | --- | --- |
| — | Overview | new | intro of `evals.mdx` |
| — | Run your first eval | Run your first eval | "What to author first", "Requirements" |
| — | How evals work | new | "How it's organized", vocabulary contract, new scoring and cost section |
| Author cases | Write a case | Write a case | "Authoring a case", "Case workspace", "History inspect", "Next run sheet" |
| Author cases | Generate cases | (part of Write a case) | "Generating cases", "Promoting sessions" |
| Run and review | Run a suite | Run a suite | "Running", "Run review", "Frozen snapshots", "Suite execution config" |
| Run and review | What a run can access | new | data-sent notes from judge and rubric checks, new |
| Run and review | Run as test users | existing page | `inspector/eval-test-users.mdx` (moved) |
| Run and review | Read results | Read results | "Reading results", "Run view", "Cost", "Exporting traces" |
| Run and review | Compare runs | (part of Read results) | "Comparing two runs", "Cross-host matrix", "Case view" |
| Grade and ship | Configure grading | Configure grading | "LLM as judge", "Rubric checks", "Grading" |
| Grade and ship | Run evals in CI | (CLI tab today) | `cli/ci.mdx` "Evals in CI", "CI suites", quality gate |
| Reference | Assertions | Cases and assertions | "Assertions", "Argument matching", "Validator settings" |
| Reference | Grading | Grading | pass criteria, evidence, judge defaults, gate conditions |
| Reference | Runs and results | Runs and results | statuses, origin badges, cost states, export format |
| Reference | Troubleshooting | new | gotchas spread across `evals.mdx` |

Held until confirmed in the app: widget steps (in Write a case) and execution budgets (in the
Grading reference).

## Page recipe

1. Title and one line on what you can do after reading.
2. Who it's for, with "use X instead" for neighbouring tools.
3. A screenshot, GIF or diagram before any prose.
4. Steps, with App / CLI / SDK tabs where all three can do it.
5. Reference tables (Field / Default / Purpose).
6. Three next-step cards.

At most about 120 words of prose before a visual, table or code block.

## Open questions

1. Tabs: A, B or C? (Recommend A.)
2. Move CLI "Local evals" and SDK "Running evals" into Evaluate in a follow-up PR?
3. Is there an MCPJam equivalent of Claude Code's seeded state, conversation history and mock
   servers worth documenting?
4. Figma marks "Evaluate (5 pages + 3 reference)" as validation pending. If those drafts exist
   outside this repo, this work should build on them.

## Next

Once the structure is agreed: write pages one sub-group at a time in this PR, capture screenshots
against one seeded example server, then wire `docs.json` and redirect `/inspector/evals`.
