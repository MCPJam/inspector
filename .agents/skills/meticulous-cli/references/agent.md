# meticulous agent

Read, analysis, and run-triggering commands designed for AI coding agents. They resolve git context (commit SHA, base, diff) automatically from the local repository, and default to machine-readable output.

All commands are also exposed as tools on the hosted **MCP server** (`https://app.meticulous.ai/api/mcp`) — an MCP-enabled client can call the `get_…` tool directly instead of shelling out. Each read tool takes broadly the same arguments and returns the same data as the CLI command's `--json` output, with differences inherent to a hosted endpoint with no access to your local repo or filesystem: **`commitSha`/`baseSha`/`gitDiffOutput` are never inferred — always compute and pass them explicitly** (e.g. `git rev-parse HEAD`, `git merge-base origin/main HEAD`), there are no output-format flags, and — for `image-files` — you get signed URLs rather than files downloaded to disk. The **MCP tool** column below gives the mapping.

`upload-build`/`trigger-test-run` (the mutating commands) map to MCP tools too, but not 1:1 — the CLI's single `agent upload-build` call is split into a **request → (upload) → register** pair on MCP (`request_asset_upload`/`request_container_upload` then `register_asset_build`/`register_container_build`), and `trigger_test_run` **does not wait for the run to finish** (unlike the CLI, which blocks by default). No separate "is it done" check is needed to follow it, though: `get_test_run_diffs` already waits out an in-progress run internally (reporting `pending`/`processing` the whole time, same as it does while computing the diff summary itself), so just poll that one call. `get_test_run_diffs_counts` has no such wait — don't rely on it to detect completion, since on an in-progress run it returns whatever partial counts currently exist rather than telling you to wait. See the `meticulous-test`, `meticulous-zero-diff-task`, or `meticulous-increase-coverage` skill for the CLI workflow; use `mcp-server.ts`/the in-app MCP docs for the exact MCP tool call sequence.

## Common options

Accepted by every `agent` command (in addition to the [global options](../SKILL.md#global-options)):

| Option       | Type    | Default | Description                                                                    |
| ------------ | ------- | ------- | ------------------------------------------------------------------------------ |
| `--apiToken` | string  | —       | Meticulous API token; otherwise use the default auth chain (see `auth whoami`) |
| `--json`     | boolean | `false` | Emit JSON on stdout instead of the default TSV/plain-text format               |
| `--verbose`  | boolean | `false` | Print additional progress logs on stderr                                       |

Commands that resolve a test run from a commit (`test-run-for-commit`, `test-run-diffs`, `js-coverage`, `trigger-test-run`, `complete-base-run`) also accept `--project <id | org/name | name>` — a one-off override of your default project for that call only (it does not change the stored default; see [`auth`](auth.md)).

The commands that read a test run (`test-run-for-commit`, `test-run-diffs`, `test-run-check`, `js-coverage`, `js-coverage-diff`) pick it in one of three ways: by default the latest run for your current git HEAD, or explicitly with `--testRunId`, `--commitSha` or `--prNumber` (pass at most one). `--prNumber` resolves to the latest run for the pull request's head commit, exactly as `--commitSha` would for that commit. On MCP, `get_test_run_for_commit` takes `prNumber` in place of `commitSha`, and the test-run tools take `prNumber` (plus an optional `project`) in place of `testRunId`.

## Command → MCP tool overview

| Command                          | Purpose                                                                     | MCP tool                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `test-run-for-commit`            | Look up the latest test run for a commit                                    | `get_test_run_for_commit`                                                                                                        |
| `test-run-diffs`                 | List the screenshot diffs of a test run                                     | `get_test_run_diffs`                                                                                                             |
| `test-run-diffs --counts`        | Aggregate diff/review totals only                                           | `get_test_run_diffs_counts`                                                                                                      |
| `diff-comments`                  | Review comments for a screenshot diff                                       | `get_diff_comments`                                                                                                              |
| `reject-diff`                    | Reject a screenshot diff (real, blocking decision) and comment why          | `reject_diff`                                                                                                                    |
| `approve-diff`                   | Approve a screenshot diff, optionally commenting why (opt-in per project)   | `approve_diff`                                                                                                                   |
| `ignore-diff`                    | Say a diff is unrelated to the change (comment only, unless opted in)       | `ignore_diff`                                                                                                                    |
| `create-diff-comment`            | Start a review comment thread                                               | `create_diff_comment`                                                                                                            |
| `reply-to-diff-comment`          | Reply to a review comment thread                                            | `reply_to_diff_comment`                                                                                                          |
| `image-urls`                     | Signed URLs for a screenshot diff's images                                  | `get_image_urls`                                                                                                                 |
| `image-files`                    | Download a screenshot diff's images to disk                                 | _(none — use `get_image_urls`)_                                                                                                  |
| `dom-diff`                       | DOM diff for a screenshot diff                                              | `get_dom_diff`                                                                                                                   |
| `timeline-diff`                  | Timeline event diffs for a replay diff                                      | `get_timeline_diff`                                                                                                              |
| `test-run-check`                 | Get the Markdown report for a non-visual check                              | `get_test_run_check`                                                                                                             |
| `test-run-check --availableIds`  | List the check IDs available for a test run                                 | `get_test_run_check_available_ids`                                                                                               |
| `check-comments`                 | Review comments for a non-visual check                                      | `get_check_comments`                                                                                                             |
| `reject-check`                   | Reject a failing check (real, blocking decision) and comment why            | `reject_check`                                                                                                                   |
| `approve-check`                  | Approve a failing check, optionally commenting why (opt-in per project)     | `approve_check`                                                                                                                  |
| `ignore-check`                   | Say a failing check is unrelated, e.g. a flake (opt-in per project)         | `ignore_check`                                                                                                                   |
| `create-check-comment`           | Start a review comment thread on a check                                    | `create_check_comment`                                                                                                           |
| `reply-to-check-comment`         | Reply to a check review comment thread                                      | `reply_to_check_comment`                                                                                                         |
| `js-coverage --testRunId`        | Per-file JS coverage for a test run                                         | `get_test_run_js_coverage`                                                                                                       |
| `js-coverage --latestForProject` | Per-file JS coverage for a project's latest successful run                  | `get_project_js_coverage`                                                                                                        |
| `js-coverage --replayId`         | Per-file JS coverage for a replay                                           | `get_replay_js_coverage`                                                                                                         |
| `js-coverage-diff`               | Per-file JS coverage diff for a replay diff, or a test run against its base | `get_replay_diff_js_coverage_diff` / `get_test_run_js_coverage_diff`                                                             |
| `sessions`                       | List a project's recently recorded sessions                                 | `get_sessions`                                                                                                                   |
| `test-runs`                      | List a project's PR test runs (or base test runs), newest first             | `get_test_runs`                                                                                                                  |
| `upload-build`                   | Upload a build, register a deployment                                       | `request_asset_upload` + `register_asset_build` (assets), or `request_container_upload` + `register_container_build` (container) |
| `trigger-test-run`               | Trigger a run against a deployment                                          | `trigger_test_run` (returns immediately — does not wait for completion)                                                          |
| `complete-base-run`              | Replay the sessions a base run has not run yet                              | `complete_base_run` (returns once scheduled — does not wait for completion)                                                      |
| `promote-sessions`               | Add sessions a pinned-session run replayed to the selected set              | `promote_sessions`                                                                                                               |
| `submit-feedback`                | Submit free-form feedback about Meticulous                                  | `submit_feedback`                                                                                                                |

For full, always-current option lists, run `meticulous schema agent <command>`.

---

## agent test-run-for-commit

```bash
# CLI
meticulous agent test-run-for-commit [--commitSha=<sha> | --prNumber=<n>] [--project=<project>]

# MCP
get_test_run_for_commit(commitSha="<sha>")   # or prNumber=<n>
```

**Purpose:** Look up the latest test run for a commit (defaults to the current git HEAD) or a pull request's head commit, and output the `testRunId`.

A finished run's status is `Success` when it found no diffs and `Failure` when it found some. `Failure` does not mean the run broke: a run that couldn't complete ends as `ExecutionError` or `Aborted` instead.

A base run is one other test runs compare against rather than a run of its own — the usual outcome for a commit on your default branch. It has no diffs and no PR, so `test-run-diffs` and `test-run-check` reject it, and it replays its selected sessions on demand, so `js-coverage` works on it only once it has replayed everything it can (see [`complete-base-run`](#agent-complete-base-run)).

| Option                           | Type    | Default          | Description                                                       |
| -------------------------------- | ------- | ---------------- | ----------------------------------------------------------------- |
| `--commitSha`                    | string  | current git HEAD | Commit to look up the run for                                     |
| `--prNumber`                     | number  | —                | Look up the run for this pull request's head commit instead       |
| `--dontWaitForTestRunToComplete` | boolean | `false`          | Report an in-progress run and exit immediately instead of waiting |

## agent test-run-diffs

```bash
# CLI
meticulous agent test-run-diffs [--testRunId=<id> | --commitSha=<sha> | --prNumber=<n>] [options]
meticulous agent test-run-diffs --counts [--testRunId=<id> | --commitSha=<sha> | --prNumber=<n>]

# MCP
get_test_run_diffs(testRunId="<id>")          # or prNumber=<n>
get_test_run_diffs_counts(testRunId="<id>")   # or prNumber=<n>
```

**Purpose:** List the screenshot diffs for a test run — by default a selected, priority-ordered subset of representative visual differences (position in the list is the priority signal, there is no `index` column). Outputs a TSV table (`replayDiffId`, `screenshotName`, plus requested columns; `mismatchFraction` is opt-in via `--includeMismatchFraction`). See the `meticulous-review` skill for the full workflow and column semantics.

| Option                           | Type    | Default          | Description                                                                                                                  |
| -------------------------------- | ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--testRunId`                    | string  | —                | Target run explicitly (else resolved from `--commitSha` / `--prNumber`, else git HEAD)                                       |
| `--commitSha`                    | string  | current git HEAD | Resolve the latest run for this commit                                                                                       |
| `--prNumber`                     | number  | —                | Resolve the latest run for this pull request's head commit                                                                   |
| `--includeAllDiffs`              | boolean | `false`          | Return every difference, not just the selected subset; adds an `isSelected` column                                           |
| `--onlyUnreviewed`               | boolean | `false`          | Only diffs still awaiting review (implies `--includeAllDiffs`)                                                               |
| `--onlyRejected`                 | boolean | `false`          | All rejected diffs, human- or agent-rejected — the complete set of issues requiring fixes (implies `--includeAllDiffs`)      |
| `--onlyWithComments`             | boolean | `false`          | All diffs with one or more open review comments, regardless of decision (implies `--includeAllDiffs`)                        |
| `--includeReviews`               | boolean | `false`          | Add `decision` and `openComments` columns with the review metadata per diff                                                  |
| `--includeReplayIds`             | boolean | `false`          | Add `baseReplayId` / `headReplayId` columns                                                                                  |
| `--includeMismatchFraction`      | boolean | `false`          | Add a `mismatchFraction` column (fraction of pixels that differ between before/after)                                        |
| `--includeDomDiffIds`            | boolean | `false`          | Add a `domDiffIds` column (one ID per distinct structural DOM change)                                                        |
| `--orderByReplayDiffs`           | boolean | `false`          | Order by replay diff instead of global priority                                                                              |
| `--counts`                       | boolean | `false`          | Print aggregate totals only (replays, differences, review-decision breakdown); cannot be combined with the list/filter flags |
| `--dontWaitForTestRunToComplete` | boolean | `false`          | Report an in-progress run and exit immediately instead of waiting                                                            |

`--includeReviewDecisions` remains available as a deprecated alias for `--includeReviews`.

The `--only*` flags (`--onlyUnreviewed`, `--onlyRejected`, `--onlyWithComments`) are **additive (OR'd), not a narrowing combination** — passing more than one widens the output to their union (e.g. rejected diffs _plus_ diffs with comments, not the intersection), rather than narrowing to diffs matching all of them.

The `decision` values are `accepted`, `rejected`, `ignored`, and `unreviewed` — there's no separate agent bucket: an agent's `reject-diff` (see below) writes a real `rejected` decision, indistinguishable from a human's at this level, and blocks the check identically. `--counts`' `numRejected` is this same unified count. By default an agent can only write `rejected`, so `--onlyUnreviewed` shrinks only as agents reject; on a project with **Enable approve/ignore diff actions** turned on (project settings → Agents), `approve-diff` and `ignore-diff` also write real `accepted`/`ignored` decisions, and count toward `numApproved`/`numIgnored` the same way.

## agent diff-comments

```bash
# CLI
meticulous agent diff-comments --replayDiffId=<id> --screenshotName=<name> [--includeResolved]

# MCP
get_diff_comments(replayDiffId="<id>", screenshotName="<name>")
```

**Purpose:** Get open review comments for one screenshot diff, oldest first, with each comment's replies nested oldest first. The non-JSON output is a flattened TSV table (`id`, `replyToCommentId`, `author`, `isAgentAuthored`, `text`, `x`, `y`) with each comment immediately followed by its replies; `replyToCommentId` is TSV-only (blank for top-level comments, no JSON/MCP equivalent) so a reply row can be linked back to its parent, and a reply's `x`/`y` repeat the parent's since replies don't carry their own coordinates. `isAgentAuthored` says whether an agent wrote the comment: a comment written with a project token has no `author` to identify it, so this is the only thing distinguishing an agent's from a human's. Unavailable optional fields are blank in TSV and omitted from JSON/MCP output. `text` is JSON-quoted (the only column that is) so multiline/tabbed comment bodies stay on one row; `x`/`y` are formatted to 5 decimal places. `--includeResolved` also returns resolved comments and adds `isResolved`.

| Option              | Type    | Description                                                       |
| ------------------- | ------- | ----------------------------------------------------------------- |
| `--replayDiffId`    | string  | Replay diff from `test-run-diffs` (required)                      |
| `--screenshotName`  | string  | Screenshot name from `test-run-diffs` (required)                  |
| `--includeResolved` | boolean | Include resolved comments and add `isResolved` (default: `false`) |

## agent reject-diff / agent ignore-diff

```bash
# CLI
meticulous agent reject-diff --replayDiffId=<id> --screenshotName=<name> --reason="<why>" --x=<0..1> --y=<0..1>
meticulous agent ignore-diff --replayDiffId=<id> --screenshotName=<name> --reason="<why>" --x=<0..1> --y=<0..1> [--reportFlake]

# MCP
reject_diff(replayDiffId="<id>", screenshotName="<name>", reason="<why>", x=<0..1>, y=<0..1>)
ignore_diff(replayDiffId="<id>", screenshotName="<name>", reason="<why>", x=<0..1>, y=<0..1>, reportFlake=<true|false>)
```

**Purpose:** Record an agent's verdict on one screenshot difference, backed by a review comment containing a succinct reason at required approximate normalized coordinates. Returns the created comment's `id`.

- **`reject-diff`** writes a real `rejected` decision — the same `decision` a human rejection would write, blocking the check identically, and replacing whatever decision (human or agent) was there before.
- **`ignore-diff`** states the agent's view that the diff is unrelated to the change under review: one the change has no plausible way to cause, such as rendering noise, an animation at a different frame, or a server-rendered timestamp. The `meticulous-review` skill's Step 5 has the full rule, including what never to ignore. What it records depends on the project:
  - **By default it decides nothing.** It only posts the comment; the diff stays `unreviewed` and the check stays pending. That is deliberate: without the project's opt-in, no holder of a project write token can green their own pull request — an agent can escalate a diff (reject) but never clear one.
  - **With Enable approve/ignore diff actions** turned on (project settings → Agents), it writes a real, non-blocking `ignored` decision, the same as a human ignoring the diff — except on a diff a person rejected, where it is refused with a 409 (see `approve-diff`).
- **`--reportFlake`** (`ignore-diff` only) also reports the diff to Meticulous to investigate as a likely replay-engine bug: pass it when the replay was nondeterministic where Meticulous should have made it deterministic (rendering, animations, timers, dates, randomness, network ordering, or a replay that took a different path), not for a genuine difference in what the app served. It is filed whether or not the ignore records a decision, and a repeat for the same diff files nothing new. When one cause produces the same flake across many diffs in a run, pass it on only one of them.

The test run must be a pull request run, or a custom-trigger run — the run you triggered yourself, where the decision is recorded against the run itself. Any other run (a plain push or crawler run, or an internal pull request run that isn't shown to users) is refused for `reject-diff`, `ignore-diff` and `approve-diff`, and for `create-diff-comment` and `reply-to-diff-comment` too — even where `ignore-diff` would only have commented.

**Every call posts a new comment**, same as `create-diff-comment` — including a `reject-diff` repeating a verdict the diff already carries. That repeat appends no second decision (the verdict already stands), but it still records its own reason and coordinates and returns that comment's `id`, so a retry after a dropped connection is safe for the decision while leaving an extra comment on the thread. A `reject-diff` that _changes_ the standing verdict resolves the comment behind the decision it replaces.

| Option             | Type   | Description                                                            |
| ------------------ | ------ | ---------------------------------------------------------------------- |
| `--replayDiffId`   | string | Replay diff from `test-run-diffs` (required)                           |
| `--screenshotName` | string | Screenshot name from `test-run-diffs` (required)                       |
| `--reason`         | string | Why the diff is a regression, or is unrelated to the change (required) |
| `--x`              | number | Approximate normalized x of the change, 0–1 (required)                 |
| `--y`              | number | Approximate normalized y of the change, 0–1 (required)                 |

## agent approve-diff

```bash
# CLI
meticulous agent approve-diff --replayDiffId=<id> --screenshotName=<name> [--reason="<why>" --x=<0..1> --y=<0..1>]

# MCP
approve_diff(replayDiffId="<id>", screenshotName="<name>")
approve_diff(replayDiffId="<id>", screenshotName="<name>", reason="<why>", x=<0..1>, y=<0..1>)
```

**Purpose:** Approve one screenshot difference as an intended result of the change under review. It writes a real `accepted` decision, clearing the diff the same as a human approval — so once every diff is approved (or ignored), the pull request check passes without a human review.

**Only available on projects with Enable approve/ignore diff actions** turned on (project settings → Agents); anywhere else the call is refused with a 403 naming the setting. Don't treat that refusal as an error to work around — the project hasn't allowed agents to clear diffs, so leave the diff for a human (optionally with `create-diff-comment`).

**An agent can't clear a human rejection.** If the latest decision on the diff is a `rejected` a person made, `approve-diff` (and an opted-in `ignore-diff`) is refused with a 409 and nothing is recorded. Replacing an agent's own earlier decision is fine. Leave a human-rejected diff for a human.

Unlike reject and ignore, **the reason is optional**: an intended change usually needs no explanation. Pass `--reason`, `--x` and `--y` together or not at all — the coordinates only place the reason's comment. With a reason it outputs the comment's ID (`{ commentId }` with `--json`); without one there is no comment, so it outputs nothing (`{}` with `--json`). The same run requirement as `reject-diff` applies (a pull request or custom-trigger run), and a repeat of an approval the diff already carries appends no second decision.

| Option             | Type   | Description                                               |
| ------------------ | ------ | --------------------------------------------------------- |
| `--replayDiffId`   | string | Replay diff from `test-run-diffs` (required)              |
| `--screenshotName` | string | Screenshot name from `test-run-diffs` (required)          |
| `--reason`         | string | Why the diff is intended (optional; requires `--x`/`--y`) |
| `--x`              | number | Approximate normalized x for the reason's comment, 0–1    |
| `--y`              | number | Approximate normalized y for the reason's comment, 0–1    |

## agent create-diff-comment / agent reply-to-diff-comment

```bash
# CLI
meticulous agent create-diff-comment --replayDiffId=<id> --screenshotName=<name> --text="..." --x=<0..1> --y=<0..1>
meticulous agent reply-to-diff-comment --commentId=<id> --text="..."

# MCP
create_diff_comment(replayDiffId="<id>", screenshotName="<name>", text="...", x=<0..1>, y=<0..1>)
reply_to_diff_comment(commentId="<id>", text="...")
```

**Purpose:** Start a review comment thread on a screenshot diff at required approximate normalized coordinates, or reply to an existing root comment. Replies inherit the root thread's anchor, so they take no `--x`/`--y`. Each command outputs the created comment or reply ID (`{ commentId }` with `--json`). Keep comment text succinct, ideally 1–3 sentences.

Each call adds another comment, same as `reject-diff`/`ignore-diff` (and `approve-diff` with a reason) — none of them are idempotent.

## agent image-urls / agent image-files

```bash
# CLI
meticulous agent image-urls  --replayDiffId=<id> --screenshotName=<name>
meticulous agent image-files --replayDiffId=<id> --screenshotName=<name>

# MCP (no download-to-disk tool — image-files has no equivalent; fetch the URL to view the image)
get_image_urls(replayDiffId="<id>", screenshotName="<name>")
```

**Purpose:** Get the images of a screenshot diff. `image-urls` prints the outcome plus a signed URL per image (`before` / `after` / `diffImage`); `image-files` downloads them under `~/.meticulous/agent-images/` and prints the local paths instead.

| Option             | Type   | Description                                      |
| ------------------ | ------ | ------------------------------------------------ |
| `--replayDiffId`   | string | Replay diff the screenshot belongs to (required) |
| `--screenshotName` | string | Screenshot name (required)                       |

## agent dom-diff

```bash
# CLI
meticulous agent dom-diff --replayDiffId=<id> --screenshotName=<name> [--context=<N|full>]

# MCP
get_dom_diff(replayDiffId="<id>", screenshotName="<name>")
```

**Purpose:** Unified-diff-style DOM diff for a screenshot diff, one hunk per change.

| Option             | Type             | Default | Description                                                                       |
| ------------------ | ---------------- | ------- | --------------------------------------------------------------------------------- |
| `--replayDiffId`   | string           | —       | Replay diff (required)                                                            |
| `--screenshotName` | string           | —       | Screenshot name (required)                                                        |
| `--context`        | number \| `full` | `3`     | Context lines around each hunk (`0` for none, `full` for a single full-file diff) |

## agent timeline-diff

```bash
# CLI
meticulous agent timeline-diff --replayDiffId=<id>

# MCP (its `diff` field carries the raw status enum rather than the TSV symbol below)
get_timeline_diff(replayDiffId="<id>")
```

**Purpose:** Timeline event diffs for a replay diff. Outputs a TSV table (`diff`, `timeMs`, `event`, `description`). Useful for diagnosing why a screenshot diff occurred (failed requests, redirects, timing).

| Option           | Type   | Description            |
| ---------------- | ------ | ---------------------- |
| `--replayDiffId` | string | Replay diff (required) |

## agent test-run-check

```bash
# CLI
meticulous agent test-run-check --checkId=<id> [--checkType=builtin|custom] [--testRunId=<id> | --commitSha=<sha> | --prNumber=<n>]
meticulous agent test-run-check --availableIds [--testRunId=<id> | --commitSha=<sha> | --prNumber=<n>]

# MCP
get_test_run_check(testRunId="<id>", checkId="<id>")       # or prNumber=<n> in place of testRunId
get_test_run_check_available_ids(testRunId="<id>")         # or prNumber=<n>
```

**Purpose:** Get the Markdown report for a builtin or customer-reported non-visual check on a test run, or — with `--availableIds` — list the check IDs that have reported results so far instead of fetching a report.

Report mode prints the report text; `--availableIds` prints a TSV table with columns `checkType` and `checkId` (MCP: a list of objects with those two attributes).

A report result is `{ status: 'processing' }` while results have not been reported yet — poll every 10s until `complete`, for at most 10 minutes (the CLI does this itself); if it's still `processing` then, stop and tell the user the results have not arrived rather than polling on. Once complete it's `{ status: 'complete', text }`; a `{ status: 'failed', reason }` result is final — there is no way to retry. For `--checkType custom`, an error saying the run is not expecting custom check results can be transient shortly after the run completes, since the customer's own CI registers its checks separately: retry for a minute or so before concluding the run has no custom checks.

`--availableIds` (MCP: `get_test_run_check_available_ids`) never waits for the test run or its checks to finish, unlike fetching a report — it returns whatever check IDs have reported results so far. An empty list shortly after triggering a run can mean the checks simply haven't reported yet rather than that none exist, so retry every 10s for up to 10 minutes (the same budget a report fetch gives itself) before concluding the run has no checks. On a project that isn't set up for checks at all, it is refused outright instead.

| Option                           | Type    | Default          | Description                                                                                                                                                                      |
| -------------------------------- | ------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--testRunId`                    | string  | —                | Target run explicitly (else resolved from `--commitSha` / `--prNumber`, else git HEAD)                                                                                           |
| `--commitSha`                    | string  | current git HEAD | Resolve the latest run for this commit                                                                                                                                           |
| `--prNumber`                     | number  | —                | Resolve the latest run for this pull request's head commit                                                                                                                       |
| `--project`                      | string  | default project  | One-off override (id, `org/proj`, or `proj`); cannot be combined with `--testRunId`                                                                                              |
| `--checkType`                    | string  | `builtin`        | `builtin` for a Meticulous-provided check, or `custom` for a customer-reported check                                                                                             |
| `--checkId`                      | string  | —                | The check ID; required unless `--availableIds` is set. Use `--availableIds` to discover it                                                                                       |
| `--availableIds`                 | boolean | `false`          | List the check IDs that have reported results for the run, instead of fetching a report. Cannot be combined with `--checkId`, `--checkType`, or `--dontWaitForTestRunToComplete` |
| `--dontWaitForTestRunToComplete` | boolean | `false`          | Report an in-progress run and exit immediately instead of waiting (report mode only)                                                                                             |

On MCP, `get_test_run_check` does not poll internally — poll it yourself every 10s until `status` is `complete` or `failed` (final — no retry).

## agent reject-check / agent approve-check / agent ignore-check

```bash
# CLI
meticulous agent reject-check (--testRunId=<id> | --prNumber=<n>) --checkId=<id> [--checkType=builtin|custom] --reason="<why>"
meticulous agent approve-check (--testRunId=<id> | --prNumber=<n>) --checkId=<id> [--checkType=builtin|custom] [--reason="<why>"]
meticulous agent ignore-check (--testRunId=<id> | --prNumber=<n>) --checkId=<id> [--checkType=builtin|custom] --reason="<why>"

# MCP
reject_check(testRunId="<id>", checkId="<id>", checkType="builtin", reason="<why>")
approve_check(testRunId="<id>", checkId="<id>")
ignore_check(testRunId="<id>", checkId="<id>", reason="<why>")
```

**Purpose:** Record an agent's verdict on one failing non-visual check — the check counterpart of `reject-diff` / `approve-diff` / `ignore-diff`. Only a check that reported `warn-and-require-user-ack` can be reviewed. The reason is stored as a check review comment prefixed with the verdict (e.g. `Verdict: reject`), and the command returns that comment's `id` (`approve-check` without `--reason` writes no comment and returns nothing). On MCP, `prNumber` (plus an optional `project`) can stand in for `testRunId`.

- **`reject-check`** writes a real `rejected` review, blocking the pull request's checks status exactly like a human rejection.
- **`approve-check`** and **`ignore-check`** need **Enable approve/ignore check actions** (project settings → Agents; shown only for projects with checks). Without it both are refused — unlike `ignore-diff`, there is no comment-only fallback. Neither ever clears a check a person rejected (409).

Reviews are scoped to the one test run — a re-run starts unreviewed. Repeating the current verdict adds only the new comment; a changed verdict resolves the replaced verdict's comment thread.

## agent check-comments / agent create-check-comment / agent reply-to-check-comment

```bash
# CLI
meticulous agent check-comments (--testRunId=<id> | --prNumber=<n>) --checkId=<id> [--checkType=builtin|custom] [--includeResolved]
meticulous agent create-check-comment (--testRunId=<id> | --prNumber=<n>) --checkId=<id> [--checkType=builtin|custom] --text="..."
meticulous agent reply-to-check-comment --commentId=<id> --text="..."

# MCP
get_check_comments(testRunId="<id>", checkId="<id>")
create_check_comment(testRunId="<id>", checkId="<id>", text="...")
reply_to_check_comment(commentId="<id>", text="...")
```

**Purpose:** Read, start and answer review comment threads on a non-visual check. Unlike diff comments they carry no coordinates. `check-comments` prints a TSV table with columns `id`, `replyToCommentId`, `author`, `isAgentAuthored`, `text` (MCP: a list of root comments with `replies`).

## agent js-coverage

```bash
# CLI
meticulous agent js-coverage --testRunId=<id>          # or --commitSha=<sha> / --prNumber=<n>
meticulous agent js-coverage --latestForProject
meticulous agent js-coverage --replayId=<id>
meticulous agent js-coverage --summary                 # aggregate totals, not the per-file list
meticulous agent js-coverage --orderBy=uncoveredLines --limit=50
meticulous agent js-coverage --limit=1000 --offset=1000  # the next page

# MCP
get_test_run_js_coverage(testRunId="<id>")
get_project_js_coverage()
get_replay_js_coverage(replayId="<id>")
get_test_run_js_coverage_summary(testRunId="<id>")
get_project_js_coverage_summary()
```

**Purpose:** Per-file JavaScript coverage for a whole test run, a single replay, a combined set of runs, or a project's latest successful run. Outputs a TSV table keyed on `repoFilePath` plus the requested columns.

**Output is paged: the first 100 files unless `--limit` says otherwise (1-1000), ordered by `--orderBy`.** Each call reports which rows you got and whether more exist, so a page can never be mistaken for the whole set; page with `--offset` when you genuinely need every file. There is no unlimited mode — when every row seems necessary, one of `--summary` (the run's aggregate, read directly rather than summed from rows), `--orderBy` (the worst files first) or `--globFilter` (one directory) is usually the question you actually wanted.

A base run (see [`test-run-for-commit`](#agent-test-run-for-commit)) replays its selected sessions on demand, so while any of them could still be replayed its coverage understates the commit and this is refused, saying how many are missing. Either replay the rest with [`complete-base-run`](#agent-complete-base-run) and ask again, or pass `--latestForProject` for the project's overall coverage. A run that has replayed everything it can answers normally — a small share of the set being permanently unreplayable (a chunk that finished without reporting some of its sessions) is tolerated rather than blocking the commit forever, and above that share the refusal says so and that completing the run cannot help.

| Option                                                                                   | Type    | Description                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--testRunId` / `--commitSha` / `--prNumber`                                             | string  | Coverage for a test run (defaults to the current git HEAD; `--prNumber` is the pull request's head commit)                                                                     |
| `--latestForProject`                                                                     | boolean | Coverage for the project's preferred latest successful test run (the same run the webapp's project coverage view uses); mutually exclusive with the other run-selector options |
| `--replayId`                                                                             | string  | Coverage for a single replay                                                                                                                                                   |
| `--screenshotName`                                                                       | string  | Restrict to a single screenshot of the replay                                                                                                                                  |
| `--headPlusTestRunIds` / `--testRunIds`                                                  | string  | Comma-separated run IDs to union coverage across (same project + commit)                                                                                                       |
| `--globFilter`                                                                           | string  | Only include files matching the glob; repeatable, matching any of several                                                                                                      |
| `--includeAllFiles`                                                                      | boolean | Include files with no coverage too                                                                                                                                             |
| `--prDiffOnly`                                                                           | boolean | Restrict to files changed in the PR (test-run queries only)                                                                                                                    |
| `--includeExecutableRanges` / `--includeUncoveredRanges` / `--includeCoveragePercentage` | boolean | Add richer per-file coverage columns                                                                                                                                           |
| `--includeLineCounts`                                                                    | boolean | Add `executedLines`/`executableLines`/`uncoveredLines` counts — far smaller than the equivalent ranges, so use these to triage then ask for ranges on the files that matter    |
| `--orderBy` / `--order`                                                                  | string  | Order rows by `repoFilePath`, `executedLines`, `executableLines`, `uncoveredLines` or `coveragePercentage`; the numeric fields default to descending                           |
| `--limit` / `--offset`                                                                   | number  | Page the output. `--limit` is 1-1000, default 100; the notice on stderr says whether more rows exist                                                                           |
| `--summary`                                                                              | boolean | Report the run's aggregate totals instead of the per-file list; incompatible with the column, row-filter, ordering and paging options                                          |
| `--dontWaitForTestRunToComplete`                                                         | boolean | Report an in-progress run and exit immediately instead of waiting                                                                                                              |

## agent js-coverage-diff

```bash
# CLI
meticulous agent js-coverage-diff --replayDiffId=<id> [--screenshotName=<name>] [--globFilter=<glob>]
meticulous agent js-coverage-diff                      # the current commit's run, against its base
meticulous agent js-coverage-diff --testRunId=<id> --summary   # or --commitSha=<sha> / --prNumber=<n>

# MCP
get_replay_diff_js_coverage_diff(replayDiffId="<id>")
get_test_run_js_coverage_diff(testRunId="<id>")
get_test_run_js_coverage_diff_summary(testRunId="<id>")
```

**Purpose:** Per-file JS coverage diff, either for one replay pair (`--replayDiffId`) or for a whole test run against the base run it was compared against. Outputs a TSV table (`repoFilePath`, `status`, `baseRanges`, `headRanges`); files whose executed lines match exactly are absent.

The whole-run form is the default: a bare invocation diffs the run for your current commit, and the base is resolved from that run rather than named by you. `--summary` (MCP: the separate `get_test_run_js_coverage_diff_summary` tool) reports the aggregate difference instead of the list — files added/removed/modified, each side's executed line count, and how many lines the run newly covers (`uniqueLinesAdded`) or no longer covers (`regressedLines`) — and skips computing the per-file rows entirely.

Two things it refuses, both as plain errors saying what to ask for instead: a run that **is** a base run (a default-branch checkout resolves to one) has no base of its own, and a run triggered outside a PR was never compared against one. If the base run hasn't replayed its whole selected set yet, the error names `complete-base-run --testRunId=<base>` — diffing against a partly-replayed base would report coverage as new when it was only unmeasured.

The two sides are different commits whenever the change altered anything, so in a file the change edited a `modified` row may be its lines having shifted rather than its coverage having changed. `baseExecutionSha` on the response says which commit the base side's line numbers reference; unedited files, and the added/removed rows, are unaffected.

Both scopes page the per-file list with `--limit` (1-1000, default 100) and `--offset`, and each call says which rows you got and whether more exist.

## agent sessions

```bash
# CLI
meticulous agent sessions [options]

# MCP
get_sessions()
```

**Purpose:** List a project's most recently created sessions, newest first (default: 100). Useful for finding the ID of a session just recorded. Outputs a TSV table (`id`, `createdAt`, `recordedAt`, `recordedBy`, `status`, plus requested columns).

| Option                                                     | Type    | Default         | Description                                                                 |
| ---------------------------------------------------------- | ------- | --------------- | --------------------------------------------------------------------------- |
| `--project`                                                | string  | default project | One-off override (id, `org/proj`, or `proj`)                                |
| `--createdSince` / `--createdUntil`                        | string  | —               | ISO-8601 date/time bounds on creation time                                  |
| `--recordedSince` / `--recordedUntil`                      | string  | —               | ISO-8601 date/time bounds on recording time                                 |
| `--recordedBy`                                             | string  | —               | Filter by the user who recorded the session                                 |
| `--excludeSyntheticSessions`                               | boolean | `false`         | Drop synthetic sessions (also drops the `status` column)                    |
| `--visitedUrlFilter`                                       | string  | —               | Glob over visited URLs (only `*` is a wildcard), e.g. `*/checkout*`         |
| `--includeStartUrl` / `--includeAbandonedReason`           | boolean | `false`         | Add extra columns                                                           |
| `--includeNumberUserEvents` / `--includeNumberUrlsVisited` | boolean | `false`         | Add activity-count columns                                                  |
| `--includeDurationSeconds`                                 | boolean | `false`         | Add a `durationSeconds` column (empty when a duration couldn't be computed) |
| `--limit`                                                  | number  | `100`           | 1–1000                                                                      |
| `--offset`                                                 | number  | `0`             | —                                                                           |

---

## agent test-runs

```bash
# CLI
meticulous agent test-runs [options]

# MCP
get_test_runs()
```

**Purpose:** List every pull request test run of a project, newest first (default: 100) — a PR with several commits or re-runs appears once per run. Use it to find every run of a PR (`--prNumber`), then pass a run's `id` to `test-run-diffs`. `--latestPerPullRequest` keeps only each PR's newest run, as the web app's test-runs tab lists them. With `--baseTestRuns` it lists the runs without a PR instead: the pushes to a branch that PR runs are compared against, often in status `Partial`. Outputs a TSV table (`id`, `createdAt`, `status`, `commitSha`, `prNumber`, plus requested columns; `prNumber` is dropped under `--baseTestRuns`, and empty when you lack access to the project's PR data).

| Option                              | Type    | Default         | Description                                                                                          |
| ----------------------------------- | ------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| `--project`                         | string  | default project | One-off override (id, `org/proj`, or `proj`)                                                         |
| `--prNumber`                        | string  | —               | Only the runs of this PR (or MR) number                                                              |
| `--latestPerPullRequest`            | boolean | `false`         | Only each PR's newest run, as on the web app's test-runs tab (not with `--baseTestRuns`)             |
| `--baseTestRuns`                    | boolean | `false`         | List the runs without a PR instead (not with `--prNumber`)                                           |
| `--status`                          | string  | —               | Comma-separated statuses, e.g. `Failure` (found differences) or `Success`                            |
| `--withDiffsOnly`                   | boolean | `false`         | Only runs that found differences (not with `--status`)                                               |
| `--withCheckIssuesOnly`             | boolean | `false`         | Only runs where a builtin check failed or warned (not with `--baseTestRuns`)                         |
| `--checkIds`                        | string  | —               | With `--withCheckIssuesOnly`, only these comma-separated builtin checks                              |
| `--createdSince` / `--createdUntil` | string  | —               | ISO-8601 date/time bounds on creation time                                                           |
| `--includeBaseTestRunId`            | boolean | `false`         | Add the run it was compared against (not with `--baseTestRuns`)                                      |
| `--includeDiffCount`                | boolean | `false`         | Add the web app's "N differences" count (`Success`/`Failure` runs only; not with `--baseTestRuns`)   |
| `--includeCheckIssueCounts`         | boolean | `false`         | Add builtin `checkWarningCount` / `checkFailureCount`; failures need acknowledgement, warnings don't |
| `--includeDurationSeconds`          | boolean | `false`         | Add the seconds the run spent running (not with `--baseTestRuns`)                                    |
| `--limit`                           | number  | `100`           | 1–1000, or 1–100 with `--includeBaseTestRunId` / `--includeDiffCount`                                |
| `--offset`                          | number  | `0`             | —                                                                                                    |

---

## agent upload-build

```bash
# CLI
meticulous agent upload-build --appDirectory=<path>     # static assets
meticulous agent upload-build --localImageTag=<tag>     # container image

# MCP (not 1:1 — request an upload URL, upload the artifact yourself, then register it)
request_asset_upload(size=<zipByteSize>)      # or request_container_upload() — no required args
# ... upload the zip/image to the returned URL/registry yourself ...
register_asset_build(uploadId="<id>", commitSha="<sha>")      # or register_container_build(uploadId="<id>", commitSha="<sha>")
```

**Purpose:** Upload a build and register a reusable deployment **without** triggering a run. Outputs the `deploymentId`. The commit defaults to the local git HEAD (a dirty working tree is captured as an ephemeral commit; untracked files are rejected). See the `meticulous-test` or `meticulous-zero-diff-task` skill for the full workflow.

| Option                                                                  | Type    | Description                                         |
| ----------------------------------------------------------------------- | ------- | --------------------------------------------------- |
| `--appDirectory`                                                        | string  | Build output directory (static-assets mode)         |
| `--localImageTag`                                                       | string  | Local Docker image tag (container mode)             |
| `--containerPort` / `--containerEnv` / `--containerHealthCheckEndpoint` | —       | Container runtime configuration                     |
| `--rewrites`                                                            | string  | Static-asset rewrite rules                          |
| `--commitSha`                                                           | string  | Override the commit the build is registered against |
| `--dryRun`                                                              | boolean | Print what would be uploaded without doing it       |

On MCP, `commitSha` is never inferred — always pass your local commit explicitly (e.g. `git stash create` for a dirty tree, since untracked files are still excluded).

## agent trigger-test-run

```bash
# CLI
meticulous agent trigger-test-run [--deploymentId=<id>] [--baseSha=<sha>] [options]

# MCP (returns immediately — doesn't wait for completion; move straight to get_test_run_diffs, which waits out the run internally)
trigger_test_run(deploymentId="<id>", baseSha="<sha>")
```

**Purpose:** Trigger a test run against a deployment from `agent upload-build`, comparing against a base. Outputs the `testRunId`. A base is required (auto-inferred from the repo, or set via `--baseSha`). Omit `--deploymentId` to reuse the most recent deployment for the local HEAD commit (requires a clean working tree). See the `meticulous-test`, `meticulous-zero-diff-task`, or `meticulous-increase-coverage` skill.

| Option                           | Type    | Default             | Description                                                                                                                                                                |
| -------------------------------- | ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--deploymentId`                 | string  | latest for HEAD     | Deployment to run against                                                                                                                                                  |
| `--commitSha`                    | string  | current git HEAD    | Resolve the most recent deployment for this commit                                                                                                                         |
| `--baseSha`                      | string  | inferred merge-base | Base commit to compare against                                                                                                                                             |
| `--gitDiffOutput`                | string  | inferred            | Explicit git diff, paired with `--baseSha`                                                                                                                                 |
| `--sessionIds`                   | string  | project golden set  | Comma-separated session IDs to replay for both base and head                                                                                                               |
| `--maxDurationSeconds`           | number  | —                   | Cap the run's duration                                                                                                                                                     |
| `--runBuiltinChecks`             | boolean | `false`             | Also run the project's enabled builtin checks on the run; read them with `test-run-check`. Rejected when none are enabled. Has no effect without a base to compare against |
| `--dontWaitForTestRunToComplete` | boolean | `false`             | Return as soon as the run is triggered                                                                                                                                     |
| `--dryRun`                       | boolean | `false`             | Print what would be triggered without doing it                                                                                                                             |

`deploymentId` on MCP comes from `register_asset_build`/`register_container_build`. `baseSha`/`gitDiffOutput` are never inferred on MCP — compute them locally (e.g. `git merge-base origin/main HEAD`) and pass them explicitly.

## agent complete-base-run

```bash
# CLI
meticulous agent complete-base-run [--testRunId=<id> | --commitSha=<sha>] [options]

# MCP (idempotent — re-call it until unexecutedSessionCount equals unobtainableSessionCount)
complete_base_run(testRunId="<id>")
```

**Purpose:** Replay the selected sessions a base run has not run yet, so its coverage describes its commit. A base run replays sessions on demand for whichever PRs compare against it, so it can sit at any fraction of the project's selected set, and [`js-coverage`](#agent-js-coverage) refuses it while sessions are still missing. Outputs `testRunId`, `status`, `unexecutedSessionCount`, `unobtainableSessionCount`, `sessionsScheduled` and `configuredSessionCount`.

There is no single "done" flag — watch `unexecutedSessionCount` against `unobtainableSessionCount` instead. The CLI waits for the two to become equal by default (up to 10 minutes, returning whatever it has if that isn't reached); MCP returns immediately, so re-call `complete_base_run` until they match, then ask for coverage again. Don't wait for `unexecutedSessionCount` to reach `0`: `unobtainableSessionCount` of those sessions can no longer be replayed at all — the chunks covering them finished without reporting a result — so for some runs the count never reaches `0`. Whether that remainder is small enough for coverage to serve anyway is [`js-coverage`](#agent-js-coverage)'s call, not this command's — it only reports the facts. `sessionsScheduled` is `0` both when everything has replayed and when the remaining sessions are already covered by earlier work, so it is not a completion signal either.

This costs a full test run's replays, so reach for it when you want this commit's own coverage; `js-coverage --latestForProject` gives a project-level picture for free. The operation is idempotent and retries sessions from chunks that concluded with `ExecutionError`. It fails for a run that is not a base run, whose whole-run status is a dead end (`ExecutionError`/`Aborted` at the whole-run level, not a single chunk), or whose deployment was an ephemeral tunnel that is no longer reachable.

| Option                           | Type    | Default          | Description                                                    |
| -------------------------------- | ------- | ---------------- | -------------------------------------------------------------- |
| `--testRunId`                    | string  | —                | The base run to complete                                       |
| `--commitSha`                    | string  | current git HEAD | Complete the latest run for this commit instead                |
| `--dontWaitForTestRunToComplete` | boolean | `false`          | Return once the replays are scheduled instead of awaiting them |

## agent promote-sessions

```bash
# CLI
meticulous agent promote-sessions --testRunId=<id> [--sessionIds=<id1>,<id2>]

# MCP
promote_sessions(testRunId="<id>", sessionIds=["<id1>", "<id2>"])
```

**Purpose:** Add sessions you recorded to the project's selected set now, instead of waiting for the next session selection to pick them up. `--testRunId` is the run you triggered over those sessions with `trigger-test-run --sessionIds` against your default branch's HEAD: it is the evidence they replay, so it must have finished and every session promoted must have replayed in it. That commit must have a finished base run on the same build that has replayed its whole selected set — run [`complete-base-run`](#agent-complete-base-run) first if it hasn't. If any of that doesn't hold, nothing is promoted. Omit `--sessionIds` to promote all of its sessions. Outputs `promotedSessionIds`, `alreadySelectedSessionIds` and `updatedBaseTestRunId`.

`updatedBaseTestRunId` is the commit's updated base run: its base run plus the promoting run's replays of the promoted sessions. It takes a few minutes to post-process, and until then [`test-run-for-commit`](#agent-test-run-for-commit) still resolves to the old base run, so a plain `js-coverage` right after promoting returns coverage without the promoted sessions. Pass the id explicitly (`js-coverage --testRunId=<updatedBaseTestRunId>`, which waits for it to finish) to read the new figure straight away; once it has finished, the commit resolves to it. It is empty when nothing was newly promoted, or when building it failed after the promotion; the notice on stderr then says to union the promoting run in with `js-coverage --headPlusTestRunIds` instead.

Promoting an already-selected session is a no-op, reported under `alreadySelectedSessionIds`. It is refused for a run that wasn't triggered over explicit sessions or hasn't finished, for a commit without such a complete base run (or whose base run executed a different build), for a session the run didn't replay, for a session banned from session selection, for a project with automatic session selection disabled (its runs replay only manually selected sessions, so a promoted one would never run), for more than 20 sessions in one call, and when agents have already promoted 10% of the project's configured selected-set size since the last session selection.

| Option         | Type   | Default                | Description                                  |
| -------------- | ------ | ---------------------- | -------------------------------------------- |
| `--testRunId`  | string | —                      | The run you triggered over the sessions      |
| `--sessionIds` | string | all the run's sessions | Comma-separated subset of the run's sessions |

## agent submit-feedback

```bash
# CLI
meticulous agent submit-feedback --message="<one or two sentences>" [options]

# MCP
submit_feedback(message="<one or two sentences>", outcome="<helped|neutral|hindered>", testRunId="<id>", skill="<skill-name>")
```

**Purpose:** Submit free-form feedback about Meticulous to the Meticulous team — e.g. whether it helped catch or debug a problem, what was confusing, or what information would have made your task easier. Outputs the `feedbackId`.

| Option         | Type   | Description                                                                                                                                                   |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--message`    | string | **Required.** The feedback itself: one or two sentences on whether Meticulous helped, what was missing or confusing, and what would have made the task easier |
| `--outcome`    | string | `helped`, `neutral`, or `hindered`                                                                                                                            |
| `--testRunId`  | string | The test run the feedback relates to, if any                                                                                                                  |
| `--skill`      | string | The agentic skill or workflow being followed, e.g. `meticulous-review`                                                                                        |
| `--agentName`  | string | The agent product submitting the feedback, e.g. `claude-code`                                                                                                 |
| `--agentModel` | string | The underlying model, e.g. `claude-sonnet-5`                                                                                                                  |
| `--project`    | string | One-off project override for this call                                                                                                                        |
