---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": patch
---

`cloud eval github` — GitHub checks, under the name of what they are

**`mcpjam cloud eval checks list|connect` manages GitHub check repositories**,
and sat as a sibling to `checks` meaning a case's grading rules under the same
`eval` noun — the suite's checks, the app's Checks section,
`create_eval_case`'s `checks`. One word covering two resources. The app already
calls its own section "GitHub checks", which is the disambiguated form.

Additive on every surface. Nothing is removed:

- `mcpjam cloud eval github list|connect` is canonical; `cloud eval checks
  list|connect` stays registered as a deprecated alias, because it is a command
  customers have in their scripts.
- `list_eval_github_repos` / `connect_eval_github_repo` are the canonical
  operations. `list_eval_check_repos` / `connect_eval_check_repo` stay in
  `ALL_OPERATIONS` — so an agent already calling one keeps its tool — and each
  new operation spreads its old sibling, so the two names share one
  implementation and cannot diverge.
- The MCP README table, the CLI reference and the agent prompt notes name the
  canonical spelling; the deprecated rows say what they are aliases of.
