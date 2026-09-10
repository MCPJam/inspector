# Separate Browser runtime and consent from Computer

> Saved September 9, 2026; revised to incorporate the TL's post-merge review.
> This is a plan, not an implementation or a record of completed smoke tests.

## Summary

Make this work in Node-local and Electron:

**Browser enabled + Computer unattached + shell disabled/Bash absent → grant Browser permission, open it, and navigate from chat.**

Browser and Bash are independent capabilities: support Browser only, Bash only, or both in the same chat. Enabling either must not disable or block the other; each retains its own permission and readiness checks.

Hosted Browser continues using the existing desktop infrastructure internally. Users do not need a Computer attachment.

The visibility and rejected-consent fixes landed in `55d6b79cf6`. Reuse them, including the compare-before-clear recovery for a rejected grant. The browser resume destination landed in backend #1308 and Inspector #4876; it is a destination hint, not a grant.

Before PR 1, reconcile checkout state against current main. The TL's checkout is clean; the workspace in which this document is being revised still has uncommitted browser work and is behind its fetched main. These are different checkout states, not evidence of missing merges. Preserve that work and coordinate with its owner; do not reset or duplicate it. The TL reports the stale WebMCP tests were fixed in the execution-target PR, so do not carry them as a known blocker without rerunning current main.

## Decisions and boundaries

- Include independent Browser location selection and browser-only device consent.
- Fresh Node-local/Electron installations default to **This machine**; hosted defaults to **Cloud**.
- Do not migrate Computer location preferences. The features are not publicly enabled.
- Require a new chat to change an existing conversation’s Browser location. Never silently move tabs, logins, or execution between machines.
- Existing shell grants remain valid for shell use. Browser requires a new, explicit grant once.
- Add the distinct `local-browser-enabled` candidacy flag, initially seeded from the existing local-computer cohort without widening exposure. Browser must no longer read `local-computer-enabled`. Preserve the broader Browser-authoring cohort, hosted entitlements, desktop billing, and chat approval behavior. Remove Browser/Bash mutual exclusivity while preserving separate authorization for each capability.
- Defer account-free OSS admission, the separate WebMCP Inspector’s permission model, unattended-policy UI, and cohort expansion. Browser-exposed WebMCP tools remain covered by Browser permission.

## Implementation

### 1. Add independent Browser runtime selection

- Add a server Browser resolver and client `useBrowserEngine` equivalent. Neither may depend on shell availability, Bash detection, shell consent, or the Computer location preference.
- Local candidacy requires the new `local-browser-enabled` flag and the existing `engines.local.browserAvailable` server capability. Chromium installation remains a separate readiness state, not a reason to hide Browser. Neither the shell feature flag nor the shell kill switch may determine this answer.
- Add Browser-specific location storage, keyed by device and project. Keep selected location separate from authorization/readiness so an unconsented local Browser displays its permission prompt.
- Add `browserEngine: "local" | "cloud"` to direct chat requests and trusted runtime context. `computerEngine` continues selecting shell execution only.
- Remove Browser/Bash mutual-exclusion checks from client selection, request validation, and server tool construction. Advertise and execute both tool sets in the same chat when each is independently enabled, authorized, ready, and supported by the selected model. A denial or unavailable runtime for one must not suppress the other. Keep Browser and shell routing tied to their respective engine selections; enabling both must not silently change either location.
- Audit all Computer engine hook consumers. Cut Browser consumers over explicitly: both Playground browser surfaces, Playground tab and main, the chat-session hook, and `useBrowserTools` (the Tools pane). Keep genuine shell consumers on the Computer hook. Thread the Browser resolver through tool construction, descriptions, page-tool discovery, profile operations, and local unattended browser execution too.
- Extend the existing local-harness routing exception for a requested local Browser. In the inspected local chat route, org BYOK already supports `localMcpRuntimeRequired`: it uses the hosted org-model broker with the tool loop in Inspector and the org key remaining in Convex. Use and test that path; merely forcing the client URL is not proof. If a particular provider cannot support that broker path, mark local Browser unsupported for that model, suppress Browser visibly, and continue unrelated chat rather than falling back to a different machine or exporting its key.
- For an unsatisfiable explicit-local chat request, preserve tool suppression but emit a stable reason code, a visible thread notice, and persistent panel state with the remedy. Do not fail an otherwise usable chat turn. Clear the state only when readiness is restored; never silently substitute Cloud.
- Browser open/ensure/control endpoints hard-fail instead. Use structured codes for `browser_consent_required` (403), `browser_runtime_unavailable` (503), and `browser_location_mismatch` (409); unsupported-model suppression uses `browser_model_unsupported`. A disabled deployment may retain its 404 stop, with a structured reason. Missing tools, their sidebar availability, and the panel status must agree.
- Hosted web chat must reject `browserEngine: "local"` and any Browser-consent header before tool construction, just as it refuses local Computer credentials. Hosted/internal unattended paths explicitly resolve Cloud.

### 2. Introduce browser-only consent

- Do not copy a third token-file implementation. Extract a small shared primitive from shell consent and local harness grants for secure token generation/hash verification, owner-only atomic persistence, mutation locking, and fingerprints. Parameterize storage and keep policy outside it. Preserve shell file compatibility and the harness's existing identity bindings, expiry, corrupt-store behavior, and lock boundaries; this is not a grant-policy unification.
- Add separate grant/verify/revoke endpoints under the existing local-browser route family, protected by Inspector session authentication and verified sign-in. Gate them on the Browser switch, not the shell switch.
- Instantiate a Browser scope using `X-MCPJam-Browser-Consent`, separate client storage, and a separate hashed capability file. Keep header/transport declarations consistent, including allowed-header lists. Do not share shell or harness tokens.
- Browser grants must not authorize command execution; shell grants must not authorize the new Browser path.
- Cut over the centralized `requireConsent` helper guarding the local-browser routes, rather than rewriting eighteen checks separately. Audit exceptions such as install and the grant-management endpoints. Switch frame nonce minting and socket fingerprint checks to Browser scope, retaining per-nonce/active-access enforcement.
- Enforce the same scope for profile operations and local eval iterations using throwaway Chromium. Ephemeral Chromium does not exempt local execution from Browser consent or the unattended tool policy.
- Electron is a small part of the coordinated cutover: keep sender validation on its two Browser IPC channels, pass the Browser token from the renderer, and verify it in-process in main. Cover missing/wrong/revoked tokens and untrusted senders; do not create a separate Electron permission protocol.
- Revoking or rotating Browser consent must invalidate derived access and stop further agent control/stream delivery, without revoking shell consent or deleting saved profiles.
- Port the already-shipped rejected-consent recovery to the Browser scope and structured error code. Clear a rejected client grant only if it still matches the failed request; a delayed response must not erase a newer grant. Do not redesign this recovery loop.

### 3. Make Browser the complete user entry point

- Put **This machine / Cloud**, connection/readiness status, grant/revoke controls, and installation actions in the Browser panel. Support both expanded workspace and right-rail layouts.
- Show browser-only permission copy explaining browser control and access to signed-in websites. State that this does not authorize shell commands; chat approval settings still apply. Revert the shared/shell dialog's new “commands and control a browser” wording to shell-only when enforcement switches.
- Reuse the existing logical Browser session's `box` binding as the server-authoritative location: it already supports local-key, computer, and sandbox arms, and local execution binds on first use. Derive location from that binding and validate subsequent open/turn requests against it. Use the resume pointer only as a UI destination hint; it never authorizes access. Without a control plane, use the existing local ledger. Do not add another conversation binding field or a third store.
- Changing location offers **Start new chat**. Existing conversations retain their location; no automatic context or profile transfer occurs.
- Keep Browser profile selection in host Tools. Leave Computer controls responsible only for Computer functionality.
- Allow Browser and Bash to be enabled together in the same chat. Selecting or opening either must not deselect, hide, or disable the other; show permission and readiness state independently.

### 4. Include the CLI with minimal compatibility handling

- Advertise a cheap `capabilities.browserConsent` bit on the open config endpoint. It is true only when Browser-scoped grants and their execution enforcement are supported together, not when consent exists or the user is entitled. Introduce it as false in the dormant PR and turn it true at cutover. The CLI probes it before Browser-scoped operations and gives a clear update-required error if false or absent. No web-client version screen or general compatibility protocol: Node-local and Electron bundle client and server together.
- Update local `mcpjam browser` commands, including `consent`, to use the Browser header and Browser-scoped stored token. Retain `--consent` but redefine its documented scope; use `MCPJAM_BROWSER_CONSENT` instead of `MCPJAM_LOCAL_CONSENT`. Resolve explicit flag → Browser environment variable → Browser-scoped stored state. Never fall back to the legacy shell token or old unscoped stored field.
- The CLI still never mints a grant: a human authorizes Browser through Inspector, and the consent subcommand stores/validates the supplied Browser capability. Preserve secure-origin checks and credential-safe output. Cloud CLI operations continue to use cloud credentials, not a local Browser grant.
- Do not reinterpret legacy shell tokens as browser-only grants. Old local Browser requests receive an actionable upgrade/consent error, not a silent Cloud fallback.
- Update first-party callers together, including CLI, Node-local, Electron, hosted chat, and local unattended execution. No new host-config field, conversation binding store, or SDK canonicalization change is required.

## Delivery sequence

1. **Dormant server PR:** shared capability primitive; Browser scope module; grant/verify/revoke routes; config capability bit; unused Browser resolver; scope-separation and shell/harness behavior-preservation tests. Existing execution paths continue using their existing grants. No exposure or runtime behavior change.
2. **Coordinated cutover PR:** new `local-browser-enabled` candidacy flag seeded with the same cohort; central enforcement and frame binding switch; `browserEngine` and model routing; removal of Browser/Bash mutual-exclusion checks; full client-consumer cutover; panel location/consent controls; existing binding checks; CLI and Electron; local eval grants. Once a server is cut over, flag-off hides candidacy but must not restore shell-token acceptance as a security fallback. Ship the shell-only copy correction here so the grant dialogs remain truthful at cutover.
3. **Release verification/docs PR:** update `docs/local-browser-engine.md` inside the Inspector workspace (shared device-consent and install-at-consent descriptions), launch checklist, CLI examples, and troubleshooting. Record real smoke results and provider limitations. Review both dialogs again; do not call the split released merely because unit tests passed.

Keep public exposure disabled while preparing the cutover. Seed the new flag through the normal rollout process; this plan does not authorize live flag changes. Widen no cohort until all Browser provisioning and entitlement checks admit the same intended users. If cutover must be rolled back, disable Browser exposure/control rather than silently reaccept shell grants.

## Test and release acceptance

- **Primary smoke test:** Browser-only host, shell switch off, Bash unavailable; grant Browser permission, install/open Chromium if needed, then successfully navigate from chat.
- Verify Browser only, Bash only, both enabled, and neither enabled. With both enabled and separately authorized, assert both tool sets are advertised and executable in the same chat. Disabling, denying, or revoking either must leave the other usable under its own authorization.
- **Combined workflow smoke test:** with Browser and Bash targeting the same machine, start a test app through Bash, open it in Browser, inspect a failing flow, fix the app through Bash, and retry in Browser without changing chats or toggling tools. Run on Node-local, Electron, and hosted configurations with supported models. Also verify that differing engine selections preserve their explicit destinations and do not assume that `localhost` is shared between machines.
- Run that flow for MCPJam-provided models, org-runtime models through the local tool-loop broker, and supported local providers, plus Electron. Assert route selection, Browser token transmission, actual advertised tools, and local tool execution; org credentials stay in Convex. Unsupported combinations must produce the explicit suppression state, never misleading “ready” UI.
- Test both Browser layouts before consent, after consent, after revocation, and after server rejection; neither may mount a shell.
- Verify shell, Browser, and harness tokens are not interchangeable. Preserve shell/harness persistence and concurrency tests during primitive extraction. Test stale responses, concurrent grants, frame/nonces after revocation, and both Electron IPC channels.
- Verify location independence, reload persistence, new-chat switching, and rejection of mismatched conversation locations using the existing logical-session binding. Confirm resume pointers confer no authorization and local-ledger behavior works without a control plane.
- Verify a denied local Browser leaves unrelated chat usable with a thread notice and persistent panel reason; open/ensure returns the corresponding structured error. Verify recovery removes the stale state.
- Verify hosted web chat rejects local Browser engine/header input. Verify local candidacy works with the local-computer flag off and the new local-browser flag on; turning the Browser flag off must not enable shell or weaken server consent enforcement.
- Test CLI flag/environment/stored-token precedence, wrong-scope tokens, missing capability bit, the consent subcommand, and rejection of legacy shell-token fallback. Confirm no token appears in logs or diagnostic output.
- Verify hosted Browser-only conversations still provision desktops and retain entitlement, ownership, idle cleanup, and metering behavior.
- Run existing Browser, Computer, chat-routing, auth, and eval/journey regressions. Local eval iterations with ephemeral Chromium require Browser consent rather than shell consent; preserve their explicit unattended-policy enforcement. Hosted eval/journey provisioning remains unchanged.
- Before exposure, complete real Node-local, Electron, and hosted smoke checks. Record failures by reason—consent, unavailable runtime, incompatible client, or provisioning—with no credentials in logs.

Success is a complete Browser-only workflow without visiting Computer, attaching Computer, enabling shell execution, or inheriting shell permission, plus a combined Browser-and-Bash workflow in the same chat when both are independently enabled and authorized.
