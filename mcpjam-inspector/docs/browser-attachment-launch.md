# Browser attachment launch

September 9, 2026. Backend first, then Inspector. This is the launch subset of
the broader browser-attachment proposal.

## Behavior in this change

- A host can select Browser in Tools without attaching Computer. The saved
  browser profile is edited in Tools too.
- Browser authoring stays in the existing `computers-enabled` cohort. The
  backend has an explicit `browser` gate aliased to that flag, including partial
  host edits. Do not widen authoring independently of desktop reservation and
  the `projectComputers` entitlement.
- The local Browser panel offers the existing device-consent dialog directly.
  Its copy explicitly covers commands and browser control. There is one device
  grant; existing consent continues working. Granting does not enable Bash on
  the host, and Browser+Bash remains an invalid authored combination.
- Eval snapshots allocate an ephemeral resource for Browser-only hosts and
  preserve their unattended policy. Journey desktop provisioning already uses
  Browser intent; its estimates now include desktop time without a Computer
  attachment.
- Existing Browser+Computer configurations remain valid. No SDK field, schema
  migration, historical-config rewrite, or consent protocol is introduced.

## Deployment checklist

1. Deploy the backend catalog change and explicit Browser gate together. They
   must not ship separately: removing `requiresComputer` without the gate opens
   authoring outside the intended cohort. Include the eval/snapshot changes.
2. Deploy the companion Inspector change. Refresh the built-in catalog in an
   already-open client before testing. An old backend still reports the Computer
   prerequisite; do not override that verdict client-side.
3. For hosted Browser, verify the backend desktop template and positive desktop
   credit rate via `projectComputers.getDesktopRuntimeTemplateConfig` / the deployment's
   runtime configuration. The relevant internal setters are
   `projectComputers.setDesktopRuntimeTemplate` and
   `projectComputers.setDesktopRuntimeRate`. Verify the configured desktop image
   actually contains the expected browserd/browser runtime.
4. Verify the Inspector data plane is configured and
   `HOSTED_BROWSER_TOOLS_ENABLED=1` on serving replicas. Confirm the backend
   hosted-browser exposure verdict is available, including template and rate.
5. Target the launch users/orgs with `computers-enabled` and the appropriate
   computer entitlement. There is no new Browser-authoring PostHog key in this
   release. `browser-workspace-enabled` selects the expanded workspace; when
   false, the Browser remains available in the right rail.
6. For the local agent browser, confirm `local-computer-enabled`, the existing
   local computer engine, and `MCPJAM_LOCAL_BROWSER_ENABLED` are enabled, the
   account is signed in, and Chromium is installed (or Electron supplies it).
   This release still inherits Bash availability and the local computer switch
   through the existing engine resolver. It removes the **host attachment**
   prerequisite, not those local runtime dependencies.
7. If WebMCP Inspector is also part of the launch, verify
   `webmcp-inspector-enabled`, `MCPJAM_WEBMCP_INSPECTOR_ENABLED`, and, for hosted,
   `MCPJAM_WEBMCP_INSPECTOR_HOSTED_ENABLED=1`. Its hosted transport still reserves
   a member desktop with its own flag/entitlement checks. Local WebMCP launches
   Playwright directly and its consent model is unchanged by this PR.

Do not log or paste runtime credentials while checking configuration. These PRs
do not change deployment flags, rates, templates, or entitlements themselves.

## Release smoke checks

- Fresh host, no Computer: Browser is selectable for the cohort, Bash remains
  blocked without Computer, the host saves, and its Browser profile picker works.
- A user outside the cohort cannot create or patch in Browser via the API. A
  de-flagged user can remove Browser or edit an unrelated field.
- Fresh signed-in local installation in the launch cohort: Browser panel →
  Allow → install if necessary → Open browser. No visit to Computer is needed;
  the permission text describes the actual shared grant. Existing grants do not
  cause a second prompt. Failed grants offer an inline retry.
- Hosted Browser-only host: open a conversation, launch/navigate, reload and
  reconnect, and confirm ownership, idle behavior, and metering still work.
- Browser-only eval and journey with an explicit unattended policy: confirm a
  per-run desktop is provisioned and Browser tools are usable. Policy-less runs
  must not gain unrestricted browser access.
- Legacy Browser+Computer host still loads and runs; Browser+Bash still fails
  authored-config validation.

Unit/integration tests cover catalog validation, feature-gated direct and patch
writes, eval resource/policy snapshots, journey snapshot/provisioning/cost
behavior, editor visibility/profile editing, and the inline consent entry point.
Real local, Electron, and hosted smoke checks remain release verification; unit
tests do not substitute for them.

## Follow-ups

Browser-specific local engine selection (including the unused `browserAvailable`
bit), scoped browser consent and revocation, standalone OSS admission, preference
migration, sandbox-image relabeling, and hosted WebMCP conversation desktops are
separate changes. Account verification and the shared device grant remain in
place for launch. In particular, this release does not claim Browser works with
the local shell engine disabled or without a configured account.
