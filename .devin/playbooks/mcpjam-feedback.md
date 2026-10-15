# Address PR feedback in MCPJam

Macro: `!mcpjam-feedback`

## Overview

Work through review comments and failing checks on an open MCPJam PR until it
is ready to merge.

## What's Needed From User

- The PR link.

## Procedure

1. Read every unresolved review comment and every failing check on the PR.
2. List each comment with your planned response: change, or reply explaining
   why not.
3. Make the changes, one commit per logical fix, with Conventional Commit
   messages.
4. Run the checks from the `verify-before-pr` skill for the files you touched.
5. Reply to each comment with what you changed, or why you did not.
6. Push, then fix any red checks with the `fix-ci` skill.
7. Update the PR description if the change in scope or behavior makes it stale.

## Specifications

- Every review comment has a reply.
- CI is green, or each remaining failure is explained as pre-existing or unrelated.

## Advice and Pointers

- When two reviewers disagree, follow the code owner and say so in the reply.
- Bot review comments (Devin Review, Snyk) count. Fix real issues; reply to
  false positives with the reason.

## Forbidden Actions

- Do not force-push over a reviewer's commits.
- Do not resolve a human reviewer's thread yourself; reply and let them resolve it.
- Do not skip or delete tests to make CI pass.
