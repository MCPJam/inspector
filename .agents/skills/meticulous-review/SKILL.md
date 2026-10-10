---
name: meticulous-review
description: Analyze a completed Meticulous test run — compare the diffs (and any failing non-visual checks) against the PR description to see what's expected, then focus on finding and flagging potential regressions. Resolves the test run from the local repo's current commit (the default), or from an explicit test-run ID, commit SHA or PR number. Use when asked to review Meticulous test results, when babysitting a pull/merge request's Meticulous Tests CI check, or right after implementing a frontend change yourself.
user-invocable: true
---

To review a Meticulous test run, follow the workflow below step by step, using the CLI or MCP commands as described.

> Before starting, run the `meticulous-cli-update` skill to ensure the Meticulous CLI and skills are up to date — unless it has already run earlier in this conversation, in which case skip it.

This skill treats you as a **reviewer, not the implementer** — even if you did write the change earlier in this conversation. Its job is to catch regressions, not to iterate on the implementation (if you're mid-implementation and want to loop against Meticulous until things look right, see the `meticulous-iterative-dev` skill for feature work with intended visual changes, or the `meticulous-zero-diff-task` skill when the UI must not change; if diffs have already been reviewed and rejected and you're just here to fix what's flagged, see the `meticulous-fix` skill).

## Step 0 -- Establish what's expected

Before looking at any diff, work out what visual change this PR is _supposed_ to produce:

- **If you already have full context** (same conversation that implemented the change, or the user just described the task), use that.
- **Otherwise** — fetch the PR description (e.g. `gh pr view <number> --json title,body` for GitHub, `glab mr view <id> --output json --jq '{title,description}'` for GitLab, or for Bitbucket `twg bitbucket pull-requests get <id>` if the [Teamwork Graph CLI](https://developer.atlassian.com/cloud/twg-cli/) is available — follow its `twg-engineering-work` skill if that's installed, and run `twg setup bitbucket` once if it asks for a Bitbucket token — else `GET /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{id}?fields=title,description`) and pull out a brief bullet-point summary of any visual changes it calls out as expected.
- If it doesn't mention any, note that explicitly — every diff below then gets extra scrutiny, since there's nothing on record it could be a known, accepted consequence of.

## Step 1 -- Get the replay diff summary

Run from the local checkout to resolve the test run from the current commit's git HEAD — make sure HEAD matches the remote head CI ran on first (e.g. `git pull`), or you may review a stale or missing run:

```bash
# CLI (infers the run from local git HEAD)
meticulous agent test-run-diffs

# MCP (git context is never inferred — resolve the testRunId from a commit first)
get_test_run_for_commit(commitSha="<sha>")
get_test_run_diffs(testRunId="<id>")
```

Returns a TSV of `replayDiffId`/`screenshotName` rows — a representative, priority-ordered subset of real visual differences; work through them top to bottom. To target a run explicitly instead of resolving from HEAD, pass `--testRunId <id>`, `--commitSha <sha>` or `--prNumber <n>` (on MCP, `get_test_run_diffs(prNumber=<n>)` skips the `get_test_run_for_commit` step). The CLI blocks until the run finishes by default (pass `--dontWaitForTestRunToComplete` to instead report an in-progress run and exit immediately); MCP never blocks, so keep polling until `status` is `complete`/`failed`.

Every returned row must be matched against Step 0 or flagged (see the Decision guide) before concluding the PR is good.

## Step 2 -- Get screenshot images

For each representative screenshot:

```bash
# CLI (downloads images to ~/.meticulous/agent-images/ and prints local paths)
meticulous agent image-files --replayDiffId <replayDiffId> --screenshotName <screenshotName>

# MCP (no download-to-disk tool — returns signed URLs instead; fetch them to view the images)
get_image_urls(replayDiffId="<replayDiffId>", screenshotName="<screenshotName>")
```

Open (or fetch) `before`, `after`, and `diffImage` to inspect the change — `diffImage` is usually the most informative, highlighting exactly which pixels changed. Always inspect the images, even when the DOM diff looks clear.

## Step 3 -- Inspect the DOM diff (for structural detail)

```bash
# CLI
meticulous agent dom-diff --replayDiffId <replayDiffId> --screenshotName <screenshotName>

# MCP
get_dom_diff(replayDiffId="<replayDiffId>", screenshotName="<screenshotName>")
```

Optional: `--context <N|full>` (CLI) controls how many context lines surround each hunk (default 3).

Output is a unified diff (`+`/`-`, indentation stripped), one `[diff N]`-headed block per independent change — for example (illustrative, not real output):

```
[diff 0]
 <div class="item">
-  <span class="label">old label</span>
+  <span class="label" data-flag="true">new label</span>
 </div>
[diff 1]
 <ul class="list">
+  <li>new item</li>
 </ul>
```

## Step 4 -- Get the replay timeline (optional, for diagnosing unexpected diffs)

If a diff is unexpected and the images/DOM don't make it obvious why:

```bash
# CLI
meticulous agent timeline-diff --replayDiffId <replayDiffId>

# MCP
get_timeline_diff(replayDiffId="<replayDiffId>")
```

TSV columns: `diff` (` ` identical, `-` removed, `+` added, `!` changed), `timeMs`, `event` (`user`/`screenshot`/`network`/`console`/etc.), `description`. Look for failed network requests, unexpected redirects, or timing anomalies that could explain a visual change.

## Step 5 -- Decision guide

For each representative screenshot, compare the diff image and DOM diff against Step 0's expectations:

- **Expected** — matches one of Step 0's expected changes (or, with full implementation context, is clearly a desired outcome). Check the diff actually looks like _that_ change and nothing more — a diff can be expected in kind but still carry an extra, unrelated regression bundled into the same screenshot. Nothing to flag; **approve** it if `approve-diff` is available (Step 6).
- **Unintended** — not accounted for by Step 0. Use the timeline to rule out failed requests, redirects, or other anomalies, then flag it:
  - **Potential regression** (a real side effect, or otherwise clearly wrong) → **reject**.
  - **Unrelated to the change under review** (see below) → **ignore**.

Either way it's flagged, not silently dropped — a human still needs to see it.

**What counts as unrelated.** Ignore only a diff the change has no plausible way to cause:

- rendering noise: subpixel or anti-aliasing differences, usually with no DOM change;
- an animation, spinner, carousel or video caught at a different frame;
- fonts or images loading late, or network responses arriving in a different order;
- environment noise: a server-rendered timestamp or data, a build version or SHA, third-party content.

Before ignoring, check that the change cannot reach the affected area (nothing in the PR diff leads to that screen or component) and that the timeline shows no divergence it explains. A replay that took a different path — a click landing elsewhere, a menu open on one side only — is unrelated only if the change cannot have caused it; the engine's own flake labels don't settle that. Never ignore:

- a diff you cannot explain;
- a diff the change could have caused, even a harmless one — approve it if it's intended, otherwise leave it undecided with a comment;
- a recorded network response the new code no longer fits (e.g. a "Missing field" error) — the change caused it;
- a regression bundled into a screenshot that is otherwise unrelated — reject it.

When unsure, leave the diff undecided and explain with `create-diff-comment`.

**Report likely engine bugs.** Add `--reportFlake` when ignoring a diff where the replay was nondeterministic although Meticulous should have made it deterministic — rendering, animations, timers, dates, randomness, network ordering, or a replay that took a different path. Meticulous then investigates it as a likely replay-engine bug. Report each flake once per run, not on every diff it shows up in: when one cause produces the same flake across many diffs (e.g. a clock or an animation that differs on every screen), ignore each of those diffs but add `--reportFlake` to only one of them. Leave it off for a genuine difference in what the app served (a server-rendered timestamp, a build version, third-party content): the app's owner fixes those, e.g. by hiding the element with the `meticulous-ignore` class.

**This skill reviews and flags — it does not fix.** Hand a rejected diff off to the `meticulous-fix` skill (or the person/skill implementing the change) — don't attempt code changes here.

## Step 6 -- Flag or approve the diff

```bash
# CLI
meticulous agent reject-diff --replayDiffId=<id> --screenshotName=<name> --reason="<why>" --x=<0..1> --y=<0..1>
meticulous agent approve-diff --replayDiffId=<id> --screenshotName=<name>
meticulous agent ignore-diff --replayDiffId=<id> --screenshotName=<name> --reason="<why>" --x=<0..1> --y=<0..1> [--reportFlake]
meticulous agent create-diff-comment --replayDiffId=<id> --screenshotName=<name> --text="<note>" --x=<0..1> --y=<0..1>

# MCP
reject_diff(replayDiffId="<id>", screenshotName="<name>", reason="<why>", x=<0..1>, y=<0..1>)
approve_diff(replayDiffId="<id>", screenshotName="<name>")
ignore_diff(replayDiffId="<id>", screenshotName="<name>", reason="<why>", x=<0..1>, y=<0..1>, reportFlake=<true|false>)
create_diff_comment(replayDiffId="<id>", screenshotName="<name>", text="<note>", x=<0..1>, y=<0..1>)
```

Call `reject-diff` or `ignore-diff` for **every** diff classified as unintended, in addition to including it in the final report. `--reason` is the succinct explanation from your classification above; `--x`/`--y` are the approximate normalized coordinates of the changed region, estimated from the diff image. `create-diff-comment` is the neutral option for anything you want on the record without a verdict.

**Is `approve-diff` available?** Only on projects with the **Enable approve/ignore diff actions** setting. Over MCP, `approve_diff` is only offered when it's on; the CLI can't tell up front, so call it on the first expected diff — a 403 starting "Agents may not approve diffs on project …" means it's off, so skip everything about approving from here on.

Call `approve-diff` for every diff classified as expected. Unlike reject and ignore, it needs no reason.

**Not symmetric:** `reject-diff` writes a real, blocking decision, same as a human rejection. Where `approve-diff` is available, `approve-diff` and `ignore-diff` also write real decisions that clear the diff. Otherwise `ignore-diff` decides nothing — it's a comment only, so the diff stays `unreviewed` and the check stays pending — so don't oversell it in your final report as having resolved anything.

**Where `approve-diff` is available, finish with a pass over every remaining diff.** Step 1 returned only a representative subset, and the check passes only once every diff has a decision. So when you've worked through that subset, list what's still undecided:

```bash
# CLI
meticulous agent test-run-diffs --includeAllDiffs --onlyUnreviewed

# MCP
get_test_run_diffs(testRunId="<id>", includeAllDiffs=true, onlyUnreviewed=true)
```

Take each row through Steps 2–6 like the first ones. Keep `--includeAllDiffs`: without it, `--onlyUnreviewed` stays capped to the representative subset for as long as any diff in it is still undecided.

## Step 7 -- Review non-visual checks (only if the run has any)

Besides screenshot diffs, a run can carry non-visual checks: builtin ones such as `accessibility`, `network-requests` and `react-component-renders`, and custom ones the project's own CI reports. Most projects have none, so first find out whether this run does:

```bash
# CLI (same run selector as Step 1)
meticulous agent test-run-check --availableIds

# MCP
get_test_run_check_available_ids(testRunId="<id>")
```

If this is refused because the project isn't set up for checks, there are no checks to review: skip to Step 8. An empty list can also mean results haven't been reported yet, so retry as the command's notice says before concluding there are none.

For each listed check, fetch its report:

```bash
# CLI
meticulous agent test-run-check --checkId=<checkId> [--checkType=custom]

# MCP
get_test_run_check(testRunId="<id>", checkId="<checkId>", checkType="builtin|custom")
```

Only a **failing** check needs a decision: one whose findings require acknowledgement. A passing check, or one that only warns, needs nothing. The report describes the findings. For builtin checks, `meticulous agent test-runs --prNumber=<n> --includeCheckIssueCounts` also counts the failures (`checkFailureCount`) per run. The review commands below refuse a check that doesn't require acknowledgement, so a refusal also settles it.

Classify each failing check the way Step 5 classifies a diff, against Step 0's expectations, and act on it:

- **Expected**: an intended consequence of the change, such as a request the PR deliberately adds. **Approve** it.
- **Potential regression** → **reject**.
- **Unrelated to the change under review** → **ignore**, under the same rule as diffs: only a finding the change has no plausible way to cause, such as one in code or pages the PR doesn't touch. Never ignore a finding you cannot explain.

```bash
# CLI (--prNumber=<n> can stand in for --testRunId)
meticulous agent reject-check --testRunId=<id> --checkId=<checkId> [--checkType=custom] --reason="<why>"
meticulous agent approve-check --testRunId=<id> --checkId=<checkId> [--checkType=custom] --reason="<why>"
meticulous agent ignore-check --testRunId=<id> --checkId=<checkId> [--checkType=custom] --reason="<why>"

# MCP
reject_check(testRunId="<id>", checkId="<checkId>", checkType="builtin|custom", reason="<why>")
approve_check(testRunId="<id>", checkId="<checkId>", checkType="builtin|custom", reason="<why>")
ignore_check(testRunId="<id>", checkId="<checkId>", checkType="builtin|custom", reason="<why>")
```

This works like Step 6, with these differences:

- **People don't see the reason.** It is stored with the decision as its justification, and agents can read it back with `check-comments`, but the Meticulous app doesn't show it. Still always give one, even to `approve-check`, where it's optional, and repeat it in your final report, which is where a person will read it.
- **`approve-check` and `ignore-check` need Enable approve/ignore check actions**, a separate project setting from the diff one. Without it both are refused: unlike `ignore-diff`, there is no comment-only fallback. Over MCP they're only offered when it's on. If they're refused, leave the check undecided and name it in your final report as needing a human decision. `reject-check` always works.
- There's no neutral comment for a check. When unsure, leave it undecided and explain why in your final report.

## Step 8 -- Final report

Cover **all significant visual changes**, plus any failing checks from Step 7.

1. **Expected changes** — brief, a line or two each: what changed, which Step 0 expectation it matches, and whether you approved it.
2. **Flagged diffs** (if any) — the main point of the review, so give these the most detail: `replayDiffId`/`screenshotName` (linked: `https://app.meticulous.ai/test-runs/<testRunId>/replay-diff/<replayDiffId>?screenshot=<screenshotName>`), whether you rejected or ignored it, the reason you gave when flagging it (Step 6), what the change looks like, and your best assessment of the cause.
3. **Failing checks** (if any) — for each one, the check ID and type, what it found, whether you approved, rejected or ignored it (or left it undecided), and your reason in full, since the app doesn't show it.

The PR is only good when every diff and failing check has been matched or flagged. If any is flagged, the PR is not yet good: surface it clearly to the user in addition to the flag itself. Where `approve-diff` is available, also name any diff you left undecided: it keeps the check pending. Likewise name any failing check you left undecided.

## Step 9 -- Report feedback to Meticulous

**Always do this as the last step — it's part of the review itself, not something the user has to ask for.** Submit one brief note: did Meticulous catch a real problem, was anything confusing, what would have made the review easier. Positive feedback counts too — this isn't just for reporting friction.

```bash
# CLI
meticulous agent submit-feedback --message="<one or two sentences>" --outcome=<helped|neutral|hindered> --testRunId=<id> --skill=meticulous-review

# MCP
submit_feedback(message="<one or two sentences>", outcome="<helped|neutral|hindered>", testRunId="<id>", skill="meticulous-review")
```
