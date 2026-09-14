---
"@mcpjam/cli": patch
---

Keep the CLI badge on a CLI run inside GitHub Actions.

The CLI declared its launcher as `github_action` whenever `GITHUB_ACTIONS` was
set. In the runs table `GitHub` means the GitHub App — a check run MCPJam built
and ran itself — and someone's own workflow calling `mcpjam cloud eval run` is
not that. So the run borrowed a badge for something it was not and gave up the
one it had earned: the CLI chip never returned it.

It now declares `cli` unconditionally. Where it ran is unchanged and still
recorded in the CI envelope beside it.
