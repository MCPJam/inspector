# Browser runtime and consent cutover

This checklist covers the coordinated Inspector/CLI/Electron and backend
changes in `browser-runtime-consent-separation-plan.md`. Public exposure stays
disabled until release verification is complete. No live flags, cohorts,
entitlements, templates, or rates are changed by these PRs.

## Behavior

- Browser can be attached without Computer, and Browser+Bash is a valid saved
  configuration when Bash's Computer prerequisite is satisfied.
- Browser and Bash each select their location and require their own device
  permission. Existing shell grants remain valid only for shell use; upgrading
  requires a fresh Browser grant.
- The Browser panel provides location, permission, revocation, and installation
  in both layouts. Changing a conversation's Browser location starts a new chat.
- Existing logical-session bindings reject location changes. Resume reads the
  binding into session state without changing device preferences; a resume
  pointer is never an execution capability.
- CLI requires the Browser-consent capability bit and a human-issued Browser
  grant. Node-local, frame streams, Electron IPC, and profile operations use
  the same Browser scope.

Unattended Browser+Bash targets must use blank profiles. Saved profile pins
are refused before launch and at runtime; Browser-only targets may keep pins.
This explicitly preserves the user-requested coexistence without importing
saved credentials onto a box where Bash can read them.

Node-local defaults to Cloud until local candidacy is enabled. Environment mode
always shows and uses Cloud. Refusals are data parts, never assistant text.

## Deployment order

1. Deploy the companion backend changes: accept Browser+Bash, enforce logical
   session locations, and expose the authenticated read-only location lookup.
2. Ship Inspector, its web client, CLI, and Electron cutover together. Refresh
   the built-in catalog. No schema migration or historical host rewrite is needed.
3. Seed `local-browser-enabled` through normal rollout with the existing local
   Computer cohort, without widening exposure. Preserve `computers-enabled`
   Browser authoring and hosted entitlement gates. `browser-workspace-enabled`
   selects the layout, not Browser permission.
4. Verify `MCPJAM_LOCAL_BROWSER_ENABLED` and the `browserAvailable` capability
   independently of the shell switch. Signed-in account admission remains.
5. For hosted, retain the desktop template, positive desktop credit rate,
   `HOSTED_BROWSER_TOOLS_ENABLED`, and backend exposure verdict checks.
6. On rollback, disable Browser exposure/control. Never restore shell-token
   acceptance as a compatibility fallback.

## Release checks — pending real environment verification

- Node-local and Electron: Browser-only host, no Computer, shell switch off;
  grant Browser, install/open, navigate through a chat tool call, then revoke.
- Both layouts: verify before consent, after consent, rejection/retry, and
  revocation. Shell controls must remain independent.
- Browser+Bash: enable and authorize both, start a local app through Bash,
  inspect/fix/retry through Browser in one chat. Repeat on a hosted run with
  an explicit shared desktop binding. Personal Cloud Bash and conversation
  Cloud Browser can use different boxes; do not assume shared localhost.
- MCPJam models, org broker, and supported local providers: verify actual tool
  execution and credential routing. Report unsupported combinations explicitly.
- Reload/resume a bound chat, reject a changed location, and use Start new chat
  to switch without transferring tabs or profiles.
- Hosted Browser-only: verify provisioning, ownership, reconnect, idle cleanup,
  and billing. Evals/journeys retain disposable boxes and unattended policy.
- CLI: fresh Browser grant, old Inspector update error, wrong-scope rejection,
  flag/environment/state precedence, and no capability in output.

Automated regression results are recorded in the PRs. They are not a record of
completed signed-in Node, Electron, hosted, or provider smoke checks. The
separate WebMCP Inspector, account-free OSS admission, unattended-policy UI,
and cohort expansion remain outside this cutover.
