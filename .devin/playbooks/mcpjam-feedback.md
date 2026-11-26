# Address PR feedback in MCPJam

Macro: `!mcpjam-feedback`

## Overview

Work through review comments and failing checks on an open MCPJam PR until it
is ready to merge. The evidence rules are in
[`.github/agent-pr-definition-of-done.md`](../../.github/agent-pr-definition-of-done.md).

## What's Needed From User

- The PR link.

## Procedure

1. Read every unresolved review comment and every failing check on the PR.
2. List each comment with your planned response: change, or reply explaining
   why not.
3. Make the changes, one commit per logical fix, with Conventional Commit
   messages.
4. Run the checks from the `verify-before-pr` skill for the files you touched.
5. If a commit changes what a screen shows, recapture the evidence on the new
   head commit, attach it on GitHub and name that commit.
6. Reply to each comment with what you changed, or why you did not.
7. Push, then fix any red checks with the `fix-ci` skill.
8. Update the PR description if the change in scope or behavior makes it stale.
9. After 3 review rounds, stop before pushing again. Reread the whole diff
   against the task and acceptance criteria, and recapture the evidence on the
   head commit.

## Specifications

- Every review comment has a reply.
- CI is green, or each remaining failure is explained as pre-existing or unrelated.
- The evidence in the PR names the head commit, or a later commit that
  changed nothing on screen.
- Any acceptance criterion you couldn't check is marked "unverified" with the
  reason, and its box stays unticked.

## Advice and Pointers

- When two reviewers disagree, follow the code owner and say so in the reply.
- Reviewers include humans, CodeRabbit, cubic and the other review bots. Fix
  real issues; reply to false positives with the reason.
- A long run of fix commits usually means the approach is wrong. Say so in the
  PR instead of pushing another round.

## Forbidden Actions

- Do not force-push over a reviewer's commits.
- Do not resolve a human reviewer's thread yourself; reply and let them resolve it.
- Do not skip or delete tests to make CI pass.
- Do not tick the checklist box "I can explain every line of this diff without
  the agent that wrote it". That box is the human's.
