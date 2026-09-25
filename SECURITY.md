# Security Policy

## Reporting a vulnerability

Report security issues privately. Do not open a public GitHub issue, and do not
post details in Discord or a pull request before the issue is fixed.

Two ways to reach us:

- **GitHub private vulnerability reporting** (preferred) — use the **Report a
  vulnerability** button under this repository's Security tab. Reports land in
  our triage queue and keep the discussion attached to the code.
- **Email** — <founders@mcpjam.com>.

A report is most useful when it includes the affected version or commit, the
component (hosted service, npm package, or desktop app), the steps to reproduce,
and what an attacker gains. A proof of concept helps us reproduce quickly.

## What happens next

These are targets we aim to meet, not guarantees:

| Stage | Target |
| --- | --- |
| We acknowledge the report | Within 3 business days |
| We confirm or decline the finding, with a severity | Within 10 business days |
| Fix for a critical finding | Within 7 days of confirmation |
| Fix for a high finding | Within 30 days of confirmation |

Medium and low findings are scheduled into normal release work. We will tell you
which bucket a report landed in rather than leaving it silent.

We will keep you updated while the fix is in progress, and we will tell you when
it ships. If you plan to publish, we ask that you wait until a fix is released,
or 90 days from your report, whichever comes first. Tell us if you need a
different timeline and we will work it out with you.

We credit reporters in the advisory unless you ask us not to. We do not run a
paid bug bounty.

## Scope

In scope:

- The hosted service at `app.mcpjam.com`, including its public API
  (`app.mcpjam.com/api/v1`), and the hosted MCP server at `mcp.mcpjam.com`.
- The `@mcpjam/inspector`, `@mcpjam/sdk` and `@mcpjam/cli` npm packages and the
  MCPJam desktop app.
- This repository's source and its CI/CD workflows.

Out of scope:

- The sample applications under `examples/`. They are illustrative and are never
  deployed as part of the service.
- Third-party MCP servers you connect the inspector to. The inspector is a
  client for arbitrary servers, so a malicious server behaving maliciously is
  expected. Report it if a hostile server can escape the boundaries the
  inspector is supposed to enforce.
- Findings from automated scanners with no demonstrated impact, missing hardening
  headers on non-sensitive static endpoints, and reports that require an already
  compromised machine or account.

## Supported versions

We patch the most recent released minor of each npm package
(`@mcpjam/inspector`, `@mcpjam/sdk`, `@mcpjam/cli`) and the current hosted
deployment. Releases are frequent, so upgrading to the latest version is
usually the fastest route to a fix. We do not backport security fixes to older
minors.

## Testing safely

Test against your own accounts, projects and data. Do not access, modify or
retain data belonging to anyone else. Do not run denial-of-service or load tests
against the hosted service, and do not social-engineer our staff or users.

If you follow this policy in good faith, we will treat your research as
authorized, will not pursue legal action over it, and will work with you if
someone else raises a concern about it. If you are unsure whether something is in
bounds, ask first at <founders@mcpjam.com>.
