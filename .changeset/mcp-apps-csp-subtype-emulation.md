---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
"@mcpjam/cli": minor
---

MCP Apps: emulate each host's CSP subtypes instead of giving every host the same sandbox.

Host profiles already recorded which CSP subtypes a host honors — fetch, XHR and
WebSocket inside `connect-src`, and script/stylesheet/image/font/media across the
resource directives — but nothing read them, so every emulated host got identical
sandbox rules. The selected host's recorded answers now shape the widget sandbox,
and each resource type gets its own directive, so a host that ignores widget-declared
image domains no longer strips its scripts as collateral.

`connect-src` cannot tell fetch from XHR from WebSocket, so those three are enforced
by a guard injected into the widget frame rather than by the policy. The guard
follows CSP3 source matching (scheme upgrades, default-port normalization, and
directory-prefix vs exact path matching) so it cannot wave through a call the host's
own allowlist does not actually cover. Blocked calls surface in the CSP workbench
with their subtype, like any other violation.

Host rows now also carry the host's OWN allowlist as `cspDirectives`, not just the
widget's declaration. Without it, emulating a host that ignores widget-declared
domains blocked everything, which is stricter than the real host.

New optional capability keys `cspConnectDomains` and `cspResourceDomains` are
validated in the canonicalizer, deep-merged in `mergeMcpAppsCapabilities`, cloned
and frozen in profiles, and editable in the host-config UI. A subtype the host never
answered stays unknown and behaves exactly as it does today; only an explicit `false`
changes enforcement. New export: `MCP_APPS_CLAUDE`.

Probe data is refreshed alongside it. Notably, ChatGPT and Codex honor widget-declared
connect domains after all: a declared WebSocket endpoint connected while an undeclared
one took a real `connect-src` violation, and since the three subtypes share one
directive they cannot diverge. The fetch and XHR canaries that passed did so because
they sit on those hosts' own allowlist, which the rows now carry. Their resource
subtypes are recorded as unknown rather than unsupported until a probe run uses a
declared origin that the host baseline does not already cover.

Existing saved rows are affected: Claude rows lose pip mode, `cspFrameDomains`,
`cspBaseUriDomains` and `requestTeardown`, and Cursor rows lose fullscreen/pip and
`downloadFile`. Those are the probe correcting earlier assumptions, not regressions.
