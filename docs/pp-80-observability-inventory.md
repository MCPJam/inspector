# PP 80 observability inventory progress

[PP-80](https://app.kestral.ai/workspace/yhNILB2/task/1PfTevfV) is assigned to Ozi Boms and In Progress. This October 14, 2026 audit applies the [PP-24 contract](observability-coverage.md). It has verified a warning-notifier delivery path and found a disabled main notifier. Inventory assembly is available; semantic classification and deployment verification remain incomplete, so no overall coverage percentage is published.

## Confirmed delivery findings

The Axiom UI shows the main `#mcpjam-alerts` notifier disabled, with 54 monitors assigned to it. The warning notifier is enabled, with 14 monitors assigned. The other two notifiers are enabled, with 2 and 47 monitors assigned. A monitor having a notifier ID therefore does not establish working delivery.

One approved Axiom built-in test was sent through the warning notifier. Its [Slack receipt](https://mcpjam-workspace.slack.com/archives/C09HW2XRVUK/p1792002694693779) arrived in `#mcpjam-alerts` on October 14 at 11:31:34 AM Pacific. The vendor's message explicitly says it is a test and no action is required. This verifies that notifier-to-channel path; it does not verify every producer, detector, reminder or clearing behavior. No notifier settings were saved or re-enabled.

The main notifier is a recorded delivery gap, not an authorization to restore 54 live notification paths. Its disabled state needs an owner decision and follow-up under the alerting framework.

## Source snapshot and existing work

The current working checkouts contain unrelated changes and older branches. Read-only archives were used without switching those checkouts:

- Inspector main: `9d76378ca3c315e00dc3499ff37241328d430b15`, confirmed against GitHub.
- Backend main: `e9476e7477e9c7fd620d1e8cdfd0bb3b47ec15b7`, confirmed against GitHub and fetched into a separate source archive.

API-7's October 7 counts remain historical inputs: 497 hosted Inspector routes, 370 Convex HTTP actions and 109 crons. They must not be treated as today's full denominator.

The backend's existing collector catalog was rebuilt successfully. Its source fingerprint matches the committed catalog: `6ce999b91c7f8d1ca39c1dd82eca99eae85db573f2217b5a4d5688fbb20f3435`. It contains 2,524 registered Convex functions and 513 exact HTTP routes, plus 5 separately declared HTTP prefixes, and 272 operational event names. The existing HTTP catalog resolves finite loops and registration helper parameters that a literal search would miss.

The Inspector's existing collector route snapshot has 673 entries, but includes middleware patterns and reads only the Electron app entrypoint. The additional audit follows both server entrypoints, preserves their conditional registrations, resolves finite template/loop routes, and separates handlers from middleware. Counts below therefore describe different source units from API-7 or the older collector snapshot.

## Inventory assembled so far

| Source unit | Count | Interpretation |
| --- | ---: | --- |
| Inspector HTTP registrations in Node/hosted entrypoint | 693 | Union of supported conditional modes, not hosted-only deployed routes |
| Inspector HTTP registrations in Electron app entrypoint | 691 | Separate registration variants; overlaps the Node list |
| Unique Inspector method and path pairs across both | 694 | Same pair in two entrypoints is not two user operations |
| Convex queries, mutations and actions | 2,524 | Matches existing collector catalog; wrapper factories excluded |
| Convex exact HTTP routes and HTTP prefixes | 513 + 5 | Reuses existing finite-expression catalog |
| Registered crons | 114 | Registration is not live heartbeat or deadman proof |
| Scheduled callsites | 492 | Detached-work review candidates; overlaps function/workflow records |
| Durable state writers | 500 | Candidates, not 500 proven terminal outcomes |
| CLI command registrations | 281 | Includes groups; qualification and leaf-command review remain |
| SDK platform operations | 249 | Catalog operations, not the entire SDK public API |
| MCP registration callsites and worker request boundary | 8 + 1 | Includes dynamic catalogs and worker admission; not nine final tool names |
| Slack and Discord handler registrations | 12 + 6 | Reporting and shared-caller inheritance require review |
| Soundcheck HTTP entrypoints | 2 | Callback and release dispatch |
| Browser request and Convex-hook callsites | 462 | Must be mapped to operations, catches and outcome requirements |
| React error-boundary mounts | 60 | Must be mapped to diagnostic ownership and supported builds |
| Browser route entries | 112 | 88 screens, 13 special routes, 11 redirects; not 112 journeys |
| Runtime failure handlers and desktop lifecycle registrations | 35 + 5 | Process/renderer behavior and delivery require review |

The machine inventory has 6,765 records across overlapping layers. **That total is not a coverage denominator.** Current source assessments are 4,845 instrumented but unverified, 1,884 unknown and 36 request-path gaps. No record is declared production-verified from source alone.

The 36 request-path variants represent 18 unique patterns outside the standard completion adapter, including deliberate health skips, SPA fallback, telemetry relay and authentication/metadata routes. Intended skips need exact reviewed exemptions; the rest need their applicable observations assessed. Admission middleware runs before the request-context adapter in the server entrypoints, so completion instrumentation alone is insufficient to prove early-refusal coverage.

All 13 declared Inspector workspaces are accounted for. Shared packages are recorded for caller inheritance review, not blanket-exempted. Public SDK methods beyond the platform catalog, MCP protocol handlers and workflow/journey stage mappings remain explicit discovery work.

### MCP catalog expansion

A companion AST review resolves the generic MCP catalog: 166 SDK operation references include 32 held beta operations, leaving 134 active catalog tools. The separately registered `show_servers` tool brings the source total to **135 unique tool names**. The skills surface additionally registers `skills/list`, `skills/get` and **21 public skill resources**. Widgets are disabled in this source snapshot, so optional widget-resource registrations are not active. These resolved names supplement the eight registration callsites above; they must not be added to that overlapping total as new coverage credit.

Each tool maps to its SDK operation and the shared `runPlatformOperation` adapter in the private `mcp-catalog.json`. Its Axiom requirements include the actual MCP result, guest-token minting, local validation/transformation and upstream failures/refusals. `runPlatformOperation` converts caught errors into tool errors, guest minting catches failures into an absent token, and worker discovery/configuration failures can return before the API is called. Consequently, downstream HTTP logs cannot establish complete worker coverage. Worker-owned eligible defects need separate Sentry ownership; authoritative product outcomes may inherit backend producers only after journey and caller reconciliation. All companion records remain unverified. Protocol-framework handlers and full product-stage applicability remain discovery work.

## Live monitor reconciliation

The read-only Axiom export contains 117 monitors. The current backend snapshot contains 69 definitions:

- 48 names match.
- 21 definitions have no same-name live monitor.
- 69 live monitors have no same-name definition in this definition directory.
- 23 matched queries differ after whitespace normalization, including after legacy dataset-name mapping.

These are reconciliation findings, not 23 proven broken detectors. The repository contains a staged clean-dataset and source-format migration, and alternative monitor tooling also needs checking before a live-only resource is called unmanaged. The API omits fields such as disabled state and some notification behavior; omitted values stay unverified. The main notifier's disabled state was verified separately in the UI.

## Transport and configuration evidence

Aggregate Axiom queries for October 13, 18:35:14 UTC through October 14, 18:35:14 UTC returned:

- `inspector-logs`: 360,746 rows, with fresh arrival near the query end.
- `mcpjam-backend-prod`: 1,404,548 rows, also fresh.

Both clean-dataset queries returned HTTP 400, so their query availability remains unverified. No cutover was performed. Arrival in a dataset proves transport activity, not completeness for a particular boundary.

Read-only Convex production configuration confirms a nonempty PostHog project token and host, `POSTHOG_CAPTURE_ENABLED=true`, and `POSTHOG_ENVIRONMENT=production`. Backend Axiom and Sentry secret variables are absent there; their existing architecture uses Convex integrations, so that absence is not automatically a missing-secret defect.

A read-only PostHog aggregate query found recent `llm_generation_completed` production events. The queried `send_message_server` series returned zero and remains unverified; zero alone does not prove a broken producer. Query output covers October 13 through the partial October 14 UTC hour and is used only as transport evidence. [PostHog filtering documentation](https://posthog.com/docs/product-analytics/trends/filters) explains the event-property filter used.

GitHub secret-name checks confirm Inspector has a Sentry upload token and Railway deployment tokens; backend has production/staging/preview Convex deploy keys. Names were inspected without displaying values. These checks establish CI configuration presence, not runtime correctness.

Both public production health endpoints answered HTTP 200 with `version=3.16.0`, `environment=prod`. They do not expose a matching commit SHA, so this does not establish that the archived main revision is deployed. Signed-in Railway inspection now reaches the MCPJam workspace. In `triumphant-alignment` production, `mcp-inspector` is online with three replicas; `tunnel-edge` is online. Inspector variable names include `AXIOM_TOKEN`, `AXIOM_DATASET` and `SENTRY_AUTH_TOKEN`. Values were neither revealed nor copied. The active deployment is `76c624fb-e43b-43f9-ab17-36980dd5ce93`, uploaded through the CLI; the UI does not establish a source commit for that upload. Presence of masked variable names is configuration evidence, not proof that their values are valid. Optional clean-dataset variables are absent from this list; source logging falls back from `AXIOM_CLEAN_DATASET` to `AXIOM_DATASET` or the legacy default. Sentry DSNs are supplied by shared source configuration rather than requiring a runtime `SENTRY_DSN` variable. Other supported services/builds and exact deployed-revision matching remain pending.

### Signed-in Sentry inspection

The organization has five projects: `convex`, `inspector-client`, `inspector-electron`, `inspector-hono` and `mcpjam-sdk`. Live source-map lists show client release 3.16.0 artifacts for `npm`, `desktop-mac` and `desktop-win`, and Electron artifacts for `electron-mac` and `electron-win`. Hono and SDK source-map pages show no uploaded maps. That absence requires build-specific applicability review; it is not automatically a defect for an unminified build. Upload presence alone does not verify symbolication. A received client event in release 3.16.0, deployment `self_hosted`, dist `local`, shows a minified stack; that event cannot prove artifact resolution for the shipped npm/desktop distributions.

Client inbound filters are enabled for browser extensions, known crawlers, the listed legacy browsers, hydration errors and ChunkLoadErrors. Localhost filtering is disabled. The other four projects have the browser-extension, crawler, legacy-browser and localhost filters disabled; hydration and ChunkLoadError filters are enabled. Health-check transaction filtering is enabled in all five. These are configured exclusions to reconcile with supported diagnostic requirements, not verified exemptions. Browser/client and Convex privacy settings were also inspected: client server-side/default scrubbing are enabled, while Convex server-side/default scrubbing are disabled; both IP-prevention controls are disabled. Actual redaction and producer-side scrubbing still require behavioral verification.

Sanitized checkbox states and source-map metadata are stored in `sentry-settings.json`; no credential values are retained. SDK settings briefly failed to load, then successfully loaded on a later attempt. No Sentry settings were changed. Sampling, per-build event resolution and remaining producer/transport proof stay unverified.

## Remaining work before PP 80 is complete

1. Resolve the 1,884 unknown records into applicable requirements, inherited instrumentation, explicit gaps or exact reviewed exemptions. The MCP tool/resource catalog is now expanded in a companion mapping; finish its protocol handlers and applicability, CLI leaf paths, SDK public methods, durable lifecycle stages and product journey questions. Do not promote candidates into final denominators by counting their rows.
2. Match source requirements to deployed versions, adapters, metrics and detector selectors. Reconcile alternate monitor tooling and staged migration differences. Record live omitted fields through UI or behavioral verification.
3. Finish Railway runtime configuration checks and Sentry sampling, symbolication/redaction and evidence for remaining supported installation/build variants. Confirm actual required secrets or integrations without treating CI secret names as runtime proof.
4. Record the disabled main notifier as a gap with an owner decision. The enabled warning delivery test satisfies only that path. Producer-to-detector injection and clearing behavior continue in PP-81 and subsequent rollout phases.
5. Publish per-sink counts/percentages only after discovery and applicability are resolved. Keep instrumentation, verified behavior and detector/delivery coverage separate.

## Reproduction and validation

Run the source scanner against explicit source archives or suitable clean checkouts:

```sh
node scripts/observability-inventory.mjs INSPECTOR_SOURCE BACKEND_SOURCE OUTPUT_DIR
node --test scripts/__tests__/observability-inventory.test.mjs
```

The scanner never imports or executes application modules. Seven tests cover nested mounts, deployment conditions, dynamic registration failures, finite route loops, factory/cyclic routers, Convex wrappers and alternate state writers, shorthand routes, SDK/browser/surface discovery and serialization. All passed; `git diff --check` passed. The final Convex HTTP rows are reconciled with the existing collector's `httpRouteCatalog.mjs`; the raw scanner explicitly retains its seven unsupported expressions.

Private backend inventory and live exports are saved outside the repository under the chat's `pp80` artifact directory. The review branch contains the generic scanner and parser modules, tests, the coverage contract and this audit summary. Production code and settings are unchanged. The refactored scanner exactly reproduces the earlier raw inventory rows, counts and unresolved expressions against the same audited source snapshots.
