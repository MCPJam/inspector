---
name: meticulous-zero-diff-task
description: Implement a task for which no visual diffs are expected end to end, using Meticulous to drive the implementation to a clean visual diff before opening a PR. Use when the task's whole premise is "the UI shouldn't change" — a dependency/version upgrade, a code refactor, a migration, or similar. Meticulous isn't just a final check here, it's the loop you iterate against while implementing.
user-invocable: true
---

To grind out a no-diff (or low-diff) implementation task, follow the workflow below step by step, using the CLI or MCP commands as described.

> Before starting, run the `meticulous-cli-update` skill to ensure the Meticulous CLI and skills are up to date — unless it has already run earlier in this conversation, in which case skip it.

This skill is for tasks whose success criterion is visual stability, not visual change: dependency/version upgrades, refactors, migrations (e.g. framework/library swaps, build-tool changes), and similar work where any Meticulous diff is a sign something broke, not a feature to explain away. It also works for low-diff tasks (a handful of expected, well-understood visual changes alongside mostly-unchanged output) — the loop is the same, just with a smaller set of diffs you expect to end up justifying rather than fixing.

## Step 1 -- Implement the task

Make the code change described by the task (the upgrade, refactor, or migration). Commit as you go if the task naturally breaks into steps — this isn't specific to Meticulous, just do the implementation work.

## Step 2 -- Build the frontend

1. Find out what build artefact Meticulous expects by checking your CI config for the corresponding step:
   - GitHub: `.github/workflows/*.yml` for `uses: alwaysmeticulous/report-diffs-action/upload-assets@v1` (build assets) or `upload-container@v1` (docker image)
   - GitLab: `.gitlab-ci.yml` (or an included `.gitlab/ci/*.yml`) for `npx @alwaysmeticulous/cli ci upload-assets` (build assets) or `ci upload-container` (docker image)
   - Bitbucket: `bitbucket-pipelines.yml` for the same `npx @alwaysmeticulous/cli ci upload-assets` / `ci upload-container` step
2. Build the frontend following the same instructions as used in that CI config.

## Step 3 -- Upload the build and trigger a test run

```bash
# CLI
meticulous agent upload-build --appDirectory <path-to-build>     # assets
meticulous agent upload-build --localImageTag <image-tag>        # container
meticulous agent trigger-test-run --deploymentId <deploymentId>

# MCP (upload is not 1:1 — request an upload URL, upload the artifact yourself, then register it)
request_asset_upload(size=<zipByteSize>)      # or request_container_upload() — no required args
# ... upload the zip/image to the returned URL/registry yourself ...
register_asset_build(uploadId="<id>", commitSha="<sha>")      # or register_container_build(uploadId="<id>", commitSha="<sha>")
trigger_test_run(deploymentId="<deploymentId>", baseSha="<sha>")
```

`trigger_test_run` on MCP never infers `baseSha`/`gitDiffOutput` (compute the base locally) and always returns immediately without waiting for the run to finish (unlike the CLI, which blocks by default).

Run `trigger-test-run` from the repo directory to infer both the base (merge-base with the origin default branch) and the git diff automatically. See the `meticulous-cli` reference for the full option list — in particular, the working tree can be dirty (captured as an ephemeral commit) so you don't need to commit before each iteration below.

Note the `testRunId` from the output.

## Step 4 -- Check for diffs, and iterate until clean

Inspect the diffs using the mechanics from the `meticulous-review` skill (Steps 1-4 there: `agent test-run-diffs`, screenshot images, DOM diff, timeline) — but apply this decision rule instead of the `meticulous-review` skill's expected-vs-regression framework:

**For a no-diff task, treat every returned diff as a bug until proven otherwise.** The premise of this skill is that the UI shouldn't change, so:

1. **No diffs at all** — you're done with this step; proceed to Step 5.
2. **One or more diffs** — for each one, look at the screenshot images and DOM diff (as in the `meticulous-review` skill's Steps 2-3) to understand exactly what changed and why, using the timeline (Step 4 there) if the cause isn't obvious from the DOM/images alone. Then classify it:
   - **Regression (the default assumption)** — a real side effect of your change.
   - **Acceptable** — you can positively explain it as an intended, unavoidable consequence of the task itself (e.g. a version-string footer changing as part of a version upgrade). Be conservative here — for a low-diff task there may genuinely be a handful of these; for a strict no-diff task there normally shouldn't be any. Don't file anything on these yet — hold off until Step 6, where the note gets filed against the PR's own CI-triggered run rather than a provisional local iteration.
   - **Unrelated to your change** — a diff your change has no plausible way to cause, as defined under "What counts as unrelated" in the `meticulous-review` skill's Step 5: typically rendering noise, an animation at a different frame, late-loading fonts or images, or environment noise such as a server-rendered timestamp. Not a label for a diff you can't explain: if your change plausibly caused it, it belongs in one of the other buckets.
   - **Can't fix, and can't confidently justify either** — don't get stuck looping over it.

For a **regression**, reject it right away so there's a paper trail as you go — even though you're both reviewer and implementer here:

```bash
# CLI
meticulous agent reject-diff --replayDiffId=<id> --screenshotName=<name> --reason="<what broke>" --x=<0..1> --y=<0..1>

# MCP
reject_diff(replayDiffId="<id>", screenshotName="<name>", reason="<what broke>", x=<0..1>, y=<0..1>)
```

Then fix the code so the behavior/output matches the pre-change baseline, and go back to Step 3 to rebuild and re-run (new build, same base). Once a later run confirms that diff no longer reproduces, close the loop by replying "Fixed" to the comment thread — pass the `id` `reject-diff` returned as `--commentId`:

```bash
# CLI
meticulous agent reply-to-diff-comment --commentId=<id> --text="Fixed."

# MCP
reply_to_diff_comment(commentId="<id>", text="Fixed.")
```

A diff you can't fix and can't confidently justify gets rejected the same way, with a reason explaining what's blocking you so the thread reflects reality — but leave it unresolved (no "Fixed" reply), and call it out clearly and specifically in the final report and in the PR description (Step 5) so a human can make the call.

Repeat Steps 3-4 until either no diffs remain, or every remaining diff is justified or explicitly flagged as unresolved.

## Step 5 -- Create the PR

Once the run is clean (or every remaining diff is accounted for), commit any outstanding changes, push the branch, and open the PR.

**Author credit:** end the commit message with a co-author trailer for Meticulous, since Meticulous drove the implementation loop, not just a final check:

```
<summary of the change>

Co-authored-by: Meticulous <87660985+alwaysmeticulous[bot]@users.noreply.github.com>
```

Trailers go in the message's last paragraph, after a blank line, one per line. If the message already has trailers, such as `Co-authored-by: Claude <noreply@anthropic.com>`, put this one first, above them, so Meticulous is the first co-author listed. On GitHub, use the address shown above: it belongs to Meticulous's GitHub App, so GitHub shows Meticulous as a co-author. On GitLab and Bitbucket, add the trailer too, but use `Co-authored-by: Meticulous <noreply@meticulous.ai>`.

In the PR description, summarize the task and, briefly, the Meticulous result (including any failing non-visual checks from Step 6, once the PR's own run reports them): e.g. "Verified via Meticulous: no visual differences across the golden set" or, if some diffs remain, a short list of what they are and why they're expected/unavoidable — link each one: `https://app.meticulous.ai/test-runs/<testRunId>/replay-diff/<replayDiffId>?screenshot=<screenshotName>`.

## Step 6 -- Confirm the PR's own test run matches

Once CI has triggered its own Meticulous test run for the pushed commit, confirm it shows the same result you already validated locally — this catches drift between your local build and CI's build (e.g. a dependency lockfile mismatch, an env var only set in CI).

```bash
# CLI (resolves from local git HEAD — already the pushed commit)
meticulous agent test-run-diffs

# MCP (git context is never inferred — resolve the testRunId from the local HEAD commit first)
get_test_run_for_commit(commitSha="<sha>")
get_test_run_diffs(testRunId="<id>")
```

Instead of resolving from HEAD you can also name the run with `--testRunId <id>`, `--commitSha <sha>` or `--prNumber <n>` (on MCP, `get_test_run_diffs(prNumber=<n>)` directly).

If CI hasn't triggered the run yet, wait and retry rather than re-triggering it yourself — the PR's run should come from the same CI pipeline a human reviewer will see. If the PR run shows different diffs than your local iteration did, treat that as a new signal: go back to Step 4 using the PR's `testRunId`.

For every diff that's still present here and that you justified rather than fixed (Step 4's **Acceptable** bucket), leave your reasoning on the record as a plain review comment — this is the run CI and a human reviewer will actually see:

```bash
# CLI
meticulous agent create-diff-comment --replayDiffId=<id> --screenshotName=<name> --text="<why it's justified>" --x=<0..1> --y=<0..1>

# MCP
create_diff_comment(replayDiffId="<id>", screenshotName="<name>", text="<why it's justified>", x=<0..1>, y=<0..1>)
```

Use `ignore-diff` **only** for a Step 4 **unrelated** diff — one that has nothing to do with your change:

```bash
# CLI
meticulous agent ignore-diff --replayDiffId=<id> --screenshotName=<name> --reason="<why it's unrelated>" --x=<0..1> --y=<0..1> [--reportFlake]

# MCP
ignore_diff(replayDiffId="<id>", screenshotName="<name>", reason="<why it's unrelated>", x=<0..1>, y=<0..1>, reportFlake=<true|false>)
```

Add `--reportFlake` when the replay itself was nondeterministic where Meticulous should have made it deterministic (see "Report likely engine bugs" in the `meticulous-review` skill's Step 5), so Meticulous investigates it as a likely replay-engine bug. Report each flake once per run: if the same flake shows up across many diffs, add it to only one of them.

A comment decides nothing — the diff stays `unreviewed` and the check stays pending — but your reasoning is on record for the human reviewing the PR.

**Non-visual checks (only if the PR's run has any).** Find out with `meticulous agent test-run-check --availableIds`. If it is refused because the project isn't set up for checks, or lists nothing, skip this. Otherwise handle each failing check as in the `meticulous-review` skill's Step 7, but classify it with Step 4's rule: for a no-diff task, a failing check is a **regression** until proven otherwise.

- **Regression**: fix it and go back to Step 3. If you can't fix it, `reject-check` it with a reason.
- **Unrelated to your change**: `ignore-check` it with a reason.
- **Acceptable**: `approve-check` it with a reason.

`approve-check` and `ignore-check` need the project's **Enable approve/ignore check actions** setting. Where they're refused, leave the check undecided. A check's reason is stored but never shown to people in the Meticulous app, so also list every failing check, with your verdict and reasoning, in the PR description.

## Step 7 -- Report feedback to Meticulous

As the last step, submit one brief feedback note to the Meticulous team: did the iterate-to-clean loop work well for this kind of task, was anything confusing, and what would have made it easier?

```bash
# CLI
meticulous agent submit-feedback --message="<one or two sentences>" --outcome=<helped|neutral|hindered> --testRunId=<id> --skill=meticulous-zero-diff-task

# MCP
submit_feedback(message="<one or two sentences>", outcome="<helped|neutral|hindered>", testRunId="<id>", skill="meticulous-zero-diff-task")
```
