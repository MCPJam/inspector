---
name: meticulous-fix
description: Fix the visual diffs (and any non-visual checks) that have been reviewed and rejected on a Meticulous test run, following their review comments if given. Use when a user has reviewed the results of a test run and is handing off to an agent to implement the fixes.
user-invocable: true
---

To fix diffs that have already been reviewed and rejected, follow the workflow below step by step, using the CLI or MCP commands as described.

> Before starting, run the `meticulous-cli-update` skill to ensure the Meticulous CLI and skills are up to date — unless it has already run earlier in this conversation, in which case skip it.

This skill assumes the review has already happened — a user (or the `meticulous-review` skill) has gone through the run and rejected the diffs that are real problems, possibly leaving comments explaining what's wrong or what to do about it, though comments aren't a given. Your job here is narrower than a full review: don't re-litigate diffs that weren't rejected, and don't second-guess the rejection itself — just work out what needs to change and make it happen.

## Step 1 -- Get the rejected diffs and any commented-on diffs

```bash
# CLI
meticulous agent test-run-diffs --onlyRejected --onlyWithComments --includeReviews

# MCP (git context is never inferred — pass a commit or test run explicitly)
get_test_run_diffs(testRunId="<id>", onlyRejected=true, onlyWithComments=true, includeReviews=true)
```

Without arguments the CLI resolves the run from your local git HEAD; to name it explicitly, pass `--testRunId <id>`, `--commitSha <sha>` or `--prNumber <n>` (MCP takes `prNumber` in place of `testRunId` too).

**Important — these `--only*` flags are additive (OR'd):** passing both `--onlyRejected` and `--onlyWithComments` returns every diff that's rejected, has an open comment, or both — not just the intersection — since a comment on a diff that wasn't formally rejected may still contain an instruction worth acting on. `--includeAllDiffs` is implied, so this spans the full run rather than just the selected subset; `--includeReviews` adds `decision`/`openComments` columns so you can tell which case each row is.

**Not every commented row is a fix target.** The `meticulous-review` skill's `ignore-diff` posts a note saying the diff is unrelated to the change, and `approve-diff` may post one explaining an approval — neither comment is a fix instruction. When reading Step 1's rows, skip diffs whose only open comments are those; leave those threads alone.

**Rejected checks (only if the run has any).** A run can also carry non-visual checks, such as `accessibility` or `network-requests`. List them with `meticulous agent test-run-check --availableIds` (MCP: `get_test_run_check_available_ids`). If that is refused because the project isn't set up for checks, or lists nothing, there are none: skip the rest of this paragraph. Otherwise read each check's recorded reasons:

```bash
# CLI (--prNumber=<n> can stand in for --testRunId)
meticulous agent check-comments --testRunId=<id> --checkId=<checkId> [--checkType=custom]

# MCP
get_check_comments(testRunId="<id>", checkId="<checkId>", checkType="builtin|custom")
```

A check whose open comment starts `Verdict: reject` was rejected by an agent, and the rest of the comment says why: that check is a fix target, and the reason is your instruction. Comments starting `Verdict: approve` or `Verdict: ignore` are not. A person's rejection records no reason here, so if the user tells you a check was rejected, treat it as a fix target too and work from its report. For each fix-target check, fetch its report with `meticulous agent test-run-check --checkId=<checkId> [--checkType=custom]` (MCP: `get_test_run_check`) to see the findings themselves.

## Step 2 -- Read the review comments for diffs that have any

For each diff with `openComments > 0`:

```bash
# CLI
meticulous agent diff-comments --replayDiffId <replayDiffId> --screenshotName <screenshotName>

# MCP
get_diff_comments(replayDiffId="<replayDiffId>", screenshotName="<screenshotName>")
```

This is your primary source of instructions — a comment usually says what's wrong and, often, what to do about it. Read every comment and its replies (nested oldest-first) before starting on that diff; a reply can narrow down or redirect an earlier comment's ask.

For a rejected diff with no comments, there's nothing to read here — the visual/structural context next is what you'll rely on instead.

## Step 3 -- Get the visual and structural context

Reuse the inspection mechanics from the `meticulous-review` skill for each diff:

```bash
# CLI
meticulous agent image-files --replayDiffId <replayDiffId> --screenshotName <screenshotName>
meticulous agent dom-diff --replayDiffId <replayDiffId> --screenshotName <screenshotName>

# MCP
get_image_urls(replayDiffId="<replayDiffId>", screenshotName="<screenshotName>")
get_dom_diff(replayDiffId="<replayDiffId>", screenshotName="<screenshotName>")
```

See the `meticulous-review` skill's Steps 2-3 for output formats and the optional timeline (`agent timeline-diff`) if the cause still isn't clear.

**Fallback for a rejected diff with no comments:** this context is now your primary source of instruction, not just extra background — treat it the same way the `meticulous-review` skill's Decision guide would, and use your own judgment to figure out what regression the rejection is pointing at.

## Step 4 -- Fix the underlying code

For each **fix target** — a rejected diff, or a non-rejected diff whose comments ask for a concrete fix — make the code change that resolves the comment's instructions (or, in the no-comment fallback, the regression you identified). Skip the ignore-only threads from Step 1; do not change code for them and do not reply on them. A single code change may resolve multiple fix-target diffs at once (e.g. one component bug causing several screenshot diffs) — don't fix the same root cause repeatedly.

Close the loop on **every fix-target** diff — fixed or not — by replying to its comment thread (or creating one if it had none):

```bash
# CLI
meticulous agent reply-to-diff-comment --commentId=<id> --text="<message>"
meticulous agent create-diff-comment --replayDiffId=<id> --screenshotName=<name> --text="<message>" --x=<0..1> --y=<0..1>

# MCP
reply_to_diff_comment(commentId="<id>", text="<message>")
create_diff_comment(replayDiffId="<id>", screenshotName="<name>", text="<message>", x=<0..1>, y=<0..1>)
```

Use `reply-to-diff-comment` when the diff already has a comment thread — pass the thread's **root** `id` from Step 2 (the row with a blank `replyToCommentId`), not a reply's id. Use `create-diff-comment` only when the diff was rejected with no existing comment (the no-comment fallback case), since there's no thread to reply to.

- **Fixed** — reply/comment "Fixed."
- **Not fixable** (a comment asks for something that isn't actually possible — contradicts another requirement, describes behavior that doesn't exist, references something you can't find, etc.) — don't guess; explain why, so the reviewer sees it without having to ask you again.

Either way, move on to the next fix-target diff; report it at the end (see the final report below).

Fix-target checks from Step 1 are fixed the same way, working from the rejection reason and the report's findings. They have no comment thread to reply on: check reasons aren't shown to people in the Meticulous app. So record what you did for each check, fixed or not and why, in the final report and the PR comment (Step 6) instead.

## Step 5 -- Commit, push, and let CI confirm

1. Commit the fixes. Note in the commit message that this addressed Meticulous review feedback, specific enough that `git log` alone tells the story later:

   ```
   Fix layout shift in checkout header

   Addresses Meticulous review feedback on test run <testRunId>:
   - <replayDiffId>/<screenshotName>: <brief on what was wrong and the fix>

   Co-authored-by: Meticulous <87660985+alwaysmeticulous[bot]@users.noreply.github.com>
   ```

   **Author credit:** end the message with the `Co-authored-by: Meticulous` trailer shown above, since Meticulous's review feedback drove this fix. Trailers go in the message's last paragraph, after a blank line, one per line. If the message already has trailers, such as `Co-authored-by: Claude <noreply@anthropic.com>`, put this one first, above them, so Meticulous is the first co-author listed. On GitHub, use the address shown above: it belongs to Meticulous's GitHub App, so GitHub shows Meticulous as a co-author. On GitLab and Bitbucket, add the trailer too, but use `Co-authored-by: Meticulous <noreply@meticulous.ai>`.

2. Push the branch (`git push origin <branch>` — see your git push rules).
3. Wait for CI to trigger its own new Meticulous test run for the pushed commit, then confirm the previously-flagged diffs are actually resolved:

   ```bash
   # CLI (resolves from local git HEAD — already the pushed commit)
   meticulous agent test-run-for-commit
   meticulous agent test-run-diffs --onlyRejected --onlyWithComments --includeReviews

   # MCP (git context is never inferred — resolve the testRunId from the local HEAD commit first)
   get_test_run_for_commit(commitSha="<sha>")
   get_test_run_diffs(testRunId="<id>", onlyRejected=true, onlyWithComments=true, includeReviews=true)
   ```

If a diff you believed you fixed is still showing up (decisions/comments carry forward from the compared run), your fix didn't address the root cause; go back to Step 3/4 for that one, then repeat this step.

Check reviews don't carry forward: the new run's checks start undecided. To confirm a check fix, fetch that check's report on the new run (`meticulous agent test-run-check --checkId=<checkId> [--checkType=custom]`) and make sure the finding you fixed is gone.

## Step 6 -- Final report

Summarize the outcome, covering **every fix-target** diff and check from Step 1 (omit the ignore-only rows you skipped). Link every diff you mention: `https://app.meticulous.ai/test-runs/<testRunId>/replay-diff/<replayDiffId>?screenshot=<screenshotName>`.

1. **Fixed**: which diffs and checks were resolved, what the underlying code change was, and which comment(s) or rejection reason it addressed, if any.
2. **Not fixed** (if any): which diffs or checks couldn't be addressed, and why — e.g. the comment's ask wasn't possible, was ambiguous, or conflicted with something else. For a diff, note that you left this explanation as a reply/comment on it (Step 4) — don't just leave it in the report where only this conversation sees it. For a check, the report and PR comment are the only record a person sees. Be specific enough that a human reviewer can pick this back up without re-deriving what you already found.

Post this report as a comment on the PR itself, in addition to delivering it here (e.g. `gh pr comment <number> --body "..."` for GitHub, `glab mr note <id> --message "..."` for GitLab, or for Bitbucket `twg bitbucket pull-requests comment create --pull-request <id> --text "..."` if the [Teamwork Graph CLI](https://developer.atlassian.com/cloud/twg-cli/) is available — follow its `twg-engineering-work` skill if that's installed, and run `twg setup bitbucket` once if it asks for a Bitbucket token — else a `POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests/{id}/comments` call with body `{"content": {"raw": "..."}}`).

## Step 7 -- Report feedback to Meticulous

As the last step, submit one brief feedback note to the Meticulous team: did the rejections/comments give you enough to work with, was anything ambiguous, and what would have made the handoff easier?

```bash
# CLI
meticulous agent submit-feedback --message="<one or two sentences>" --outcome=<helped|neutral|hindered> --testRunId=<id> --skill=meticulous-fix

# MCP
submit_feedback(message="<one or two sentences>", outcome="<helped|neutral|hindered>", testRunId="<id>", skill="meticulous-fix")
```
