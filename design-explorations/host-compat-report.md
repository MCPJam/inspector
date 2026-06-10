# Host Compatibility Report — "Will my server work in X?" from the moment you connect

Status: design exploration (no implementation yet)
Audience: MCPJam product + engineering
Related: `sdk/src/host-config/`, `client/src/lib/client-styles/`, `convex/serverInspections`

## Problem

Developers building MCP servers target many hosts — Claude, ChatGPT, Cursor,
M365 Copilot, Codex — and the hosts genuinely differ: transport and auth
requirements, protocol versions, which server capabilities they surface
(prompts, resources, logging), and most sharply the widget surfaces: MCP
Apps (SEP-1865, the [MCP Apps extension
spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx))
and the OpenAI Apps SDK.

MCPJam already encodes this knowledge. The host-style registry
(`client/src/lib/client-styles/built-ins.ts`) carries a per-host MCP Apps
matrix (~18 dimensions) and a per-host `window.openai.*` surface (~13
methods), partly vendor-doc-sourced (Copilot's published table), partly
probe-captured (Cursor 3.4.17). The playground and eval runner use it to
*emulate* hosts faithfully.

But the developer only learns "will this work in Copilot?" by manually
chatting in each emulated host or wiring up evals. The moment of connection —
when we already capture the server's entire advertised surface — tells them
nothing. That's the gap: **the knowledge exists as emulation behavior, not as
a verdict.**

## What we already have (why this is cheap)

| Ingredient | Where it lives | State |
|---|---|---|
| Connect-time server snapshot | `serverInspections` / `serverInspectionRevision` (Convex), `ServerToolSnapshot` v3 envelope: discovery/initialize (protocol version, capabilities, serverInfo), tools (+annotations, `_meta` incl. `ui`), prompts/resources arrays | Shipped for tools + initialize info (`source: 'connect'`, hashed + revisioned for drift). The v3 envelope already *types* prompts/resources arrays, but the connect capture path doesn't populate them yet — see the v1 capture gaps below |
| Per-host capability profiles | `HostStyleDefinition` registry: `mcpAppsCapabilities`, `compatRuntime.openaiAppsCapabilities`, protocol bucket (`MCP_APPS` vs `OPENAI_SDK`) | Shipped for apps dimensions; missing transport/auth/protocol/server-capability dimensions |
| Pure portable host-config module pattern | `sdk/src/host-config/` (browser-safe, hand-mirrored to Convex where needed, golden-vector parity tests) | Established pattern to follow |
| Host emulation to act on findings | Playground host-style picker, eval runner per-host execution | Shipped |

The feature is mostly a **join**: `requirements(snapshot, connection
facts) × profile(host) → report`. The new work is the rule catalog, the
requirements extractor, the host-profile extension beyond apps dimensions,
two small connect-capture extensions (detailed in the rule-catalog
section), and the UX.

## Product shape

### Verdicts

Per (server, host) pair, one of:

- **Works** — every requirement the server expresses is supported.
- **Degraded** — connects and runs, but features are lost (widgets fall back
  to text, prompts invisible, pip unavailable…). Always paired with the list
  of what's lost.
- **Blocked** — a hard blocker: transport the host can't reach, no common
  protocol version, auth flow the host can't complete.
- **Unknown** — the profile doesn't cover a dimension the server uses
  (typical for BYO custom hosts, or runtime-only dimensions before any
  session has been observed).

Each verdict is backed by **findings**: `{ severity: blocker | degraded |
info, evidence (which tool/resource/field triggered it), remediation,
confidence, provenance }`.

### Confidence & provenance are first-class

The built-ins file itself says the presets are "best-effort mocks." A wrong
**Works** verdict kills trust in the whole feature, so every host-profile
fact carries provenance:

- `vendor-doc` — e.g. Copilot's published capability table (high confidence)
- `probe` — captured from a real host (e.g. Cursor 3.4.17 probe; high
  confidence, but versioned and dated)
- `assumed` — preset judgment calls (low confidence)

A verdict's confidence is the minimum over the facts actually consulted. The
UI language follows it: "**Verified** against Cursor 3.4.17 probe" vs
"**Expected** to work (based on assumed defaults)." Hovering a verdict shows
its provenance. This is also the honest answer to hosts changing under us —
facts are dated, and stale facts decay to lower confidence in copy ("last
verified 6 months ago").

### Where it surfaces

1. **The connect moment (the headline).** When `CONNECT_SUCCESS` lands and
   the inspection snapshot is captured, the server card grows a **compat
   strip**: a row of host logos, each with a status dot
   (green/amber/red/gray), summarized as "Works in 4 of 6 hosts." The
   success toast gains one line: "Connected · 12 tools · degraded in
   Copilot (3 findings)." Zero extra API calls — the data is already on the
   client.

2. **Server detail modal → new "Compatibility" tab** (sixth tab after
   History). Per-host accordion: verdict, findings grouped by severity, each
   with evidence ("tool `book_table` → `_meta.ui.resourceUri` →
   widget requests `pip` display mode") and remediation ("declare an inline
   fallback; Copilot supports inline + fullscreen only"). Two CTAs per host:
   - **"Open in emulated {host}"** — deep link into the playground with that
     host style preselected and this server attached. The fix-verify loop is
     one click.
   - **"Run verified check"** — see Levels below.

3. **Drift regression alerts.** Compat is recomputed per inspection
   revision (snapshots already rotate on contract-hash change). When a
   revision flips a verdict downward, notify: "Your last deploy broke
   Copilot compatibility: `book_table` now requires `requestModal`." This
   reuses the existing revision machinery; it's the same diff-on-read
   pattern, applied to verdicts instead of contracts.

4. **Programmatic (later phase).** SDK API + `mcpjam compat` CLI returning
   the report as JSON with CI-friendly exit codes ("fail the build if Claude
   compat regresses"). Registry cards (`registryServers`) eventually show
   compat badges — a real differentiator for the directory.

### Two audiences for the host list

- **Market view (default):** the built-in catalog (Claude, ChatGPT, Cursor,
  Copilot, Codex). This answers the developer's real question — "where can I
  ship this?" — and is what the connect strip shows.
- **My-hosts view:** the project's named hosts (`hosts` table), whose
  hostConfigs may carry overrides (tool approval, visibility filtering,
  capability overrides). Shown inside the Compatibility tab beneath the
  market view. BYO host styles appear here with Unknown for dimensions their
  profile doesn't declare. In v1 those Unknowns are read-only; letting users
  fill in BYO compat profiles rides the same mechanism BYO host styles
  already use to register (the client-side host-style registry), and its
  long-term home follows open question 1 below.

## The rule catalog (v1, fully static — no live calls beyond connect)

All deterministic, computed from two inputs the developer's connect already
produces: the inspection snapshot **plus the server's connection facts**
(transport type, OAuth config, URL — these live on the `servers` row /
connection config, not in the snapshot, and feed the transport and auth
rules).

Two small capture gaps to close as part of v1 — the connect-time exporter
(`exportSingleServerForInspection`) currently snapshots tools + initialize
info only:

1. **Populate the prompts/resources arrays** the v3 envelope already types.
   Trivial: the manager already exposes `listResources` / `listPrompts`
   (the `exportServer` helper beside the inspection exporter calls both
   today). Needed for the server-capability rules and for resource-level
   `_meta.ui` (CSP, permissions, `prefersBorder`).
2. **Capture the version accept-list, not just the negotiated version.**
   The snapshot records the single negotiated `protocolVersion`; the
   protocol-version rule wants the server's supported set where available.
   Until then the rule runs on the negotiated version alone, with the
   finding worded accordingly.

| Category | Example findings | Severity |
|---|---|---|
| **Transport & deployment** | stdio server vs host that only reaches remote HTTP servers (ChatGPT apps, Copilot) | blocker |
| **Auth** | server requires OAuth (`useOAuth` / 401-PRM discovery) vs host without DCR / client-ID-metadata support | blocker |
| **Protocol version** | `discovery.supportedVersions` ∩ host's accepted versions = ∅ | blocker |
| **Server capabilities vs host surface** | server advertises `prompts` but host never surfaces prompts; `resources` on a host that doesn't proxy `serverResources`; `logging` on a host that drops log messages | degraded |
| **Apps protocol bucket** | SEP-1865 widgets (`_meta.ui.resourceUri`, `ui://` resources with `text/html;profile=mcp-app`) on a host with no MCP Apps support; OpenAI-style widgets (`openai/outputTemplate`) on hosts without the `window.openai` shim (claude/cursor/codex) | degraded (text fallback exists per spec) — blocker only if the tool is `visibility: ["app"]`-only |
| **Apps dimensions** | declared `csp.frameDomains` / `baseUriDomains` on Copilot (not honored); sandbox permissions (camera/mic/geo/clipboard) on hosts that don't grant them; `prefersBorder` ignored; display modes the host lacks (`pip` on Copilot) | degraded |
| **Tool-shape lint per host** | tool count over host limits; name charset/length restrictions; schema constructs specific hosts reject | degraded / info |

A deliberate nuance baked into the bucket rules: the spec's graceful-degradation
story means "host ignores your widget" is *degraded*, not *blocked* — unless
the server gave the host nothing to fall back to.

The catalog is versioned (`COMPAT_RULE_CATALOG_VERSION`), so any cached or
persisted report is invalidated when rules or profiles change.

## Levels of verification (the phasing)

- **L0 — Static (v1, instant, free).** Snapshot + connection facts ×
  profile, pure function, computed on read. Ships the strip, the tab, deep
  links, and the two connect-capture extensions from the rule-catalog
  section.
- **L1 — Widget scan.** For each `ui://` resource, read the widget HTML the
  same way the existing widget-content routes already do — `resources/read`
  through the MCP client manager, extracting `content.text` / base64
  `content.blob` — and statically scan it for `window.openai.*` / `app.*`
  API usage and external URLs. This unlocks the killer per-method findings: "your
  widget calls `window.openai.requestModal` — Copilot doesn't expose it" and
  "widget fetches `api.example.com` but `csp.connectDomains` doesn't declare
  it." Pure string/AST scanning; no execution.
- **L2 — Verified emulation ("Run verified check").** A smoke run per host:
  initialize with the host's exact `clientInfo` + capabilities + protocol
  pin, list tools, render each widget in the emulated sandbox, intercept
  bridge calls and CSP violations. Upgrades "expected" verdicts to "verified
  in emulation," with the run stored as evidence. Reuses the eval runner's
  per-host execution path.
- **L3 — Observed usage.** Runtime-only requirements (does the server call
  `sampling/createMessage`? `elicitation/create`?) can't be known statically
  — servers don't declare them. Real chat/eval sessions already stamp host
  metadata; add counters for client-capability requests and widget bridge
  calls, persist them onto the inspection, and flip Unknown dimensions to
  known. The report visibly improves the more you use the playground.

## Architecture

- **`sdk/src/host-config/compat-report.ts`** (new, pure, browser-safe — same
  contract as `canonicalize.ts`):
  - `deriveServerRequirements(snapshot: ServerToolSnapshotServer, connection: ServerConnectionFacts): ServerRequirements`
    — `ServerConnectionFacts` is the small transport/auth slice of the
    server config (transport type, OAuth flags), passed alongside the
    snapshot because those facts never enter the snapshot envelope.
  - `evaluateHostCompat(requirements, profile: HostCompatProfile): HostCompatReport`
  - Exhaustive fixture tests per rule; one golden-report test per built-in
    host against a reference snapshot.
- **Host profile extension.** `HostStyleDefinition` grows a `compat` block
  for the non-apps dimensions (transport reach, auth flows, accepted protocol
  versions, server-capability surfacing, tool limits, naming rules), each
  fact tagged `{ value, provenance, verifiedAt }`. Apps dimensions are
  already there — they get provenance tags, not new values.
- **Compute on read, client-side, no new tables for v1.** Consistent with
  the existing "diffs are recomputed on read" stance. Persistence arrives
  only with drift alerts (a later phase), and as an optional per-host verdict
  summary field on existing `serverInspectionRevision` rows — not a new
  table — so the notifier can compare adjacent revisions without recomputing
  history. Registry badges bring their own storage when they land.
- **Where host facts live long-term** is an open question (below): the
  client registry means updating Copilot's matrix requires a release; a
  backend-managed "host facts feed" would let facts update independently and
  serve the CLI/registry too. v1 keeps the registry; the provenance schema
  is designed so the move is mechanical.

## Non-goals

- **We do not claim to test real hosts.** L2 verifies against MCPJam's
  emulation; the copy must say so. Probe-sourced facts are the bridge to
  real-host truth.
- **No gating.** The report never blocks connecting or chatting.
- **No LLM judgment in the verdict path.** The existing `serverQuality`
  LLM-judge pipeline stays separate; compat is deterministic and replayable
  or it's worthless in CI.

## Open questions

1. **Host facts feed:** keep profiles in the client registry (ships with
   releases) or move to backend-managed data (updates without deploys,
   shared with CLI/registry)? Recommendation: registry for v1, design the
   provenance schema to migrate.
2. **Strip contents:** should the default connect-strip show all six
   built-ins, or only the four real shipping targets? MCPJam (the
   inspector's own surface — trivially compatible by construction) and
   Codex (a CLI stand-in with no widget surface) add little signal to a
   "where can I ship this?" strip. Either way they stay in the My-hosts
   view and the host picker — this is only about the strip's default, not
   about removing them from the product.
3. **Registry badges:** do compat verdicts become public listing metadata,
   and if so, only L2-verified ones?
4. **Probe program:** the Cursor 3.4.17 probe shows the path — do we invest
   in a first-party probe server developers run inside real hosts to keep
   facts fresh (and crowdsource coverage)? If so, it needs a security story
   up front: explicit opt-in, minimal permissions, data minimization
   (capability booleans only — never host config contents), and signed
   releases.
