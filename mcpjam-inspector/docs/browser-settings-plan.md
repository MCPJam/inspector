# Browser configuration

Status: **partially implemented; draft for review.** The navigation and relocation
of existing settings are implemented. The broader policy and browser-management
runtime work below is not implemented by this change.

## Implemented

- [x] Dedicated Browser tab in both client editors, beside Tools and Computer.
- [x] Independent Browser / + Browser canvas island, including environment views.
- [x] Environment island opens the referenced client's Browser tab without editing
  the environment inline.
- [x] Browser removed from the Tools list and its island's enabled count.
- [x] This client: Browser enablement and saved-profile selection.
- [x] Your browser: location preference, device permission/revocation, and saved
  profile management moved from Computer.
- [x] Personal location changes affect new chats, without starting a browser or
  resetting an existing chat. Environment turns continue using Cloud.
- [x] Playground retains temporary overrides and live controls, with a Browser
  settings link. Open Playground is available from Browser settings.
- [x] Existing Browser configuration remains inspectable when rollout is disabled.
- [x] Tests cover navigation, read-only settings, rollout gates, profile-label
  isolation, and personal preference versus conversation location.

## Remaining before the full plan is complete

- [ ] Saved site-tools policy: disable both discovery and execution, including
  first-class and legacy WebMCP tool paths.
- [ ] Browsing, download, and upload Ask / Allow / Block policies with exact-origin
  exceptions. Preserve legacy behavior for absent policy; seed Ask for new clients.
- [ ] Canonicalization, content hashing, validation, and immutable snapshots for
  the new policy fields. Keep unattended Browser policy distinct.
- [ ] Authenticated, owner-scoped personal policies that can further restrict
  client permissions. Keep device grants and filesystem paths out of shared config.
- [ ] Execution-boundary enforcement covering redirects, popups, site tools, and
  transfers. Block wins; unattended runs cannot wait for interactive approval.
- [ ] Typed management operations and capability negotiation across Node-local,
  Electron, and Cloud. Unsupported operations must be refused and omitted from UI.
- [ ] Session-only history by default; private opt-in 30-day retention, deletion,
  and separately approved agent access.
- [ ] Scoped browsing-data clearing with explicit treatment of saved profile
  archives and chat transcripts.
- [ ] Download history, retrieval, and supported save-location prompting.
- [ ] Camera/microphone site permissions where the runtime and OS support them.
- [ ] Full-URL display and web/local link destinations where the app owns routing.
- [ ] Signed-in smoke checks for each supported runtime before exposing the new
  management settings, plus tests for ownership, revocation, policy composition,
  redirects, transfers, and unsupported capabilities.

Browser/Bash independence, conversation location stickiness, and the rejection of
saved profiles alongside Bash in unattended sandboxes must remain intact.

Imports, password/autofill management, and unrestricted CDP are excluded.
