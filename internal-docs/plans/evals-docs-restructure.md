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

Revised after checking every feature against the client code (Nov 21). Today's `evals.mdx` describes
several screens that are no longer mounted (Run all, Update snapshot, Run insights, Suggested
fixes, Export traces, the LLM-as-judge panel, HOLD/SHIP pills, the By host matrix, the Next run
sheet, "Checks by stage"). The new pages describe only what a default, ungated user sees.

| Sub-group | Page | URL | Figma page |
| --- | --- | --- | --- |
| — | Overview | `/evaluate/overview` | new |
| — | Run your first eval | `/evaluate/run-your-first-eval` | Run your first eval |
| — | How evals work | `/evaluate/how-evals-work` | new |
| Author cases | Write a case | `/evaluate/write-a-case` | Write a case |
| Author cases | Generate cases | `/evaluate/generate-cases` | (part of Write a case) |
| Run and review | Run a suite | `/evaluate/run-a-suite` | Run a suite |
| Run and review | What a run can access | `/evaluate/what-a-run-can-access` | new |
| Run and review | Read results (includes comparing runs and cost) | `/evaluate/read-results` | Read results |
| Grade and ship | Configure grading | `/evaluate/configure-grading` | Configure grading |
| Grade and ship | Run evals in CI | `/evaluate/run-evals-in-ci` | (CLI tab today) |
| Reference | Assertions | `/evaluate/reference/assertions` | Cases and assertions |
| Reference | Suite settings | `/evaluate/reference/suite-settings` | Grading |
| Reference | Runs and results | `/evaluate/reference/runs-and-results` | Runs and results |
| Reference | Troubleshooting | `/evaluate/troubleshooting` | new |

Changes from the 16-page draft, from the code check:

- **Dropped:** Compare runs (folded into Read results), Exporting traces (not reachable in the app).
- **Kept out:** Run as test users. It is behind a feature flag, so by the public-docs rules it
  should not be in the nav. Its existing page is untouched pending a decision.
- **Now documented:** the five time and retry limits in suite settings, which are rendered and
  ungated (Figma notes said they were not in the app).
- **Still held:** detail on Interact steps at runtime (unverified).

`/inspector/evals` redirects to `/evaluate/overview` in the last PR of the stack.

## Delivery: stacked PRs

| PR | Branch | Contents |
| --- | --- | --- |
| 1 | `claude/charming-hopper-v5g043` | This plan and the mock |
| 2 | `…-1-start` | Overview, Run your first eval, How evals work |
| 3 | `…-2-author` | Write a case, Generate cases |
| 4 | `…-3-run` | Run a suite, What a run can access, Read results |
| 5 | `…-4-grade` | Configure grading, Run evals in CI |
| 6 | `…-5-reference` | Reference pages, Troubleshooting; remove `inspector/evals.mdx`, redirect, fix inbound links |

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
