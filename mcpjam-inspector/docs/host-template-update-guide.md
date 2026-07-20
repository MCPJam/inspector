# Host-template update guide

**Audience:** any MCPJam engineer — no prior host-compat experience assumed.
**Use this when:** capability drift is found (a client renders something our catalog says it can't, or vice versa), a client ships a behavior change, or a new host needs a template. This guide covers the full pipeline so a parity fix never queues behind the one person who knows it.

Related public docs: [`docs/inspector/host-templates.mdx`](../../docs/inspector/host-templates.mdx) (contributor-facing "add a host" walkthrough), [`docs/inspector/compatibility.mdx`](../../docs/inspector/compatibility.mdx) (verdict semantics). This guide is the internal end-to-end version: where the data lives, how it flows, and how to prove an edit landed.

---

## 1. The data path (four layers, two repos)

```
┌─ LAYER 1: SOURCE OF TRUTH ──────────────────────────────────────────────┐
│ mcpjam-backend/convex/marketHostCatalog/                                │
│   seed.ts       — HOST_METADATA (label, provenance, rendersMcpApps,     │
│                   verifiedAt, imageSupport) + SEED_DOCUMENT             │
│   templates.ts  — HOST_TEMPLATES_BY_ID (full HostConfigInputV2 per id)  │
│   buildHostsById() merges both halves; throws if an id is missing one.  │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ publishCatalog(): content-hash the canonical
                               │ JSON, append to `marketHostCatalog` table if
                               │ changed. NO cron, NO CI step — every
                               │ GET /public/host-catalog reconciles-on-read
                               │ and republishes when deployed code drifts
                               │ from the latest published row (reconcile.ts).
                               ▼
┌─ LAYER 2: LIVE ENDPOINT ────────────────────────────────────────────────┐
│ Backend origin: GET /public/host-catalog (mcpjam-backend/convex/http.ts)│
│ Public proxy:   GET /api/v1/host-catalog                                │
│   mcpjam-inspector/server/routes/v1/host-catalog.ts — tri-state:        │
│   • live    → source:"live", Cache-Control: public, max-age=300         │
│   • stale   → upstream failed but we have a last-good cache; served     │
│               with Cache-Control: no-cache (source keeps cached value)  │
│   • bundled → no cache + no upstream: source:"bundled", version:0,      │
│               Cache-Control: no-store, data from the SDK snapshot       │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ generated FROM the seed module (not fetched
                               │ from the endpoint):
                               │ MCPJAM_BACKEND_DIR=… npm run \
                               │   generate:host-catalog-fallback -w @mcpjam/sdk
                               ▼
┌─ LAYER 3: SDK BUNDLED FALLBACK ─────────────────────────────────────────┐
│ sdk/src/host-compat/catalog.generated.ts                                │
│   BUNDLED_HOST_COMPAT_CATALOG — do NOT hand-edit; offline/CLI/dev only. │
│   Drift guard: npm run check:host-catalog-fallback -w @mcpjam/sdk       │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
┌─ LAYER 4: CAPABILITY PRESETS + CONSUMERS ───────────────────────────────┐
│ sdk/src/host-compat/capabilities.ts — frozen MCP_APPS_* matrices        │
│   (MCP_APPS_FULL, _CHATGPT, _MISTRAL, _CURSOR, _GOOSE, _COPILOT,        │
│   _SLACK, _VSCODE, _NO_CLAIMS). Same presets the playground emulates    │
│   with, so verdicts never drift from emulation.                         │
│ sdk/src/host-compat/catalog.ts — buildHostProfilesFromCatalog()         │
│ sdk/src/host-compat/evaluator.ts — evaluateHostCompat() verdicts        │
│ Consumers: inspector client compat UI, playground emulation, CLI        │
│   (cli/src/commands/compat.ts), public API.                             │
└──────────────────────────────────────────────────────────────────────────┘
```

Two facts that surprise everyone the first time:

1. **There is no seed deploy step.** Seeding is reconcile-on-read: every `GET /public/host-catalog` compares the deployed code's seed content-hash to the latest published `marketHostCatalog` row and republishes on mismatch (`notes: 'autoseed on read'`). Deploying the backend is what ships a catalog change. Manual repair hatch if a deployment is somehow stuck: `npx convex run marketHostCatalog/seed:seedMarketHostCatalog`.
2. **The generated SDK snapshot comes from the seed module, not the endpoint.** `sdk/scripts/generate-host-catalog-fallback.ts` `import()`s `SEED_DOCUMENT` from the backend repo (pointed at by `MCPJAM_BACKEND_DIR`), so you regenerate against your checked-out backend branch — no deployment needed to regenerate.

### Where capability values actually live

A host entry's capability matrix is inline in the catalog at `hostsById[<id>].mcpProfile.apps.mcpAppsOverrides` — it is **not** a reference to a preset. The 17 boolean keys (`toolInputPartial`, `toolCancelled`, `hostContextChanged`, `resourceTeardown`, `toolInfo`, `openLinks`, `serverTools`, `serverResources`, `logging`, `updateModelContext`, `message`, `sandboxPermissions`, `cspFrameDomains`, `cspBaseUriDomains`, `resourcePrefersBorder`, `downloadFile`, `requestTeardown`) plus `availableDisplayModes` and `widgetDisplayModeRequests` are enumerated in `MCP_APPS_BOOLEAN_KEYS` (`mcpjam-backend/convex/marketHostCatalog/lib.ts`). OpenAI-Apps rendering is the separate boolean `mcpProfile.apps.compatRuntime.openaiApps`.

The SDK's `capabilities.ts` presets are the human-readable source those inline matrices were written from. If you change a host's capability, check whether the matching `MCP_APPS_*` preset in `capabilities.ts` (and its resolved copy in backend `templates.ts`) should change too — the playground emulates from the preset, verdicts read the catalog, and the whole point of sharing them is that they never disagree.

---

## 2. Walkthrough A — change an existing host's capability value

Example: probing shows Cursor now supports `openLinks`.

**Step 1 — edit the source of truth (`mcpjam-backend`).**

- Capability matrix: `convex/marketHostCatalog/templates.ts`, in `HOST_TEMPLATES_BY_ID["cursor"]` → `mcpProfile.apps.mcpAppsOverrides.openLinks: true`.
- Metadata (if the evidence class changed): `convex/marketHostCatalog/seed.ts`, in `HOST_METADATA` → update `provenance` (see §4) and bump `verifiedAt` to the date you verified (`Date.UTC(YYYY, M-1, D)`).

**Step 2 — keep the SDK preset in sync (`inspector` repo).**

If the host has a preset in `sdk/src/host-compat/capabilities.ts` (e.g. `MCP_APPS_CURSOR`), apply the same value there. This is what the playground emulates with.

**Step 3 — regenerate the bundled fallback (`inspector` repo root).**

```bash
MCPJAM_BACKEND_DIR=/path/to/mcpjam-backend npm run generate:host-catalog-fallback -w @mcpjam/sdk
```

Commit the resulting `sdk/src/host-compat/catalog.generated.ts` diff. Never hand-edit that file.

**Step 4 — verify (see §5), then open two PRs** — one per repo. Land the backend PR first (or together); the SDK fallback drifting slightly behind the live catalog is harmless (live wins whenever reachable; the release workflow runs a non-blocking remote parity check).

## 3. Walkthrough B — add a new host template

Follow the public contributor doc [`docs/inspector/host-templates.mdx`](../../docs/inspector/host-templates.mdx) for the full field guide; the short version:

1. **Backend:** add the id to BOTH halves — `HOST_METADATA` in `seed.ts` (label, `provenance`, `rendersMcpApps`, `verifiedAt`, optional `supportedProtocolVersions`/`imageSupport`) and `HOST_TEMPLATES_BY_ID` in `templates.ts` (full `HostConfigInputV2`: `hostStyle`, `modelId`, `systemPrompt`, capability overrides, …). `buildHostsById()` throws at publish time if an id exists in only one map, and `assertCatalogSemantics()` enforces cross-field rules — run the backend tests to catch both locally.
2. **Host id note:** the validator intentionally types `id` as a plain string (adding a host must not require a validator PR).
3. **Inspector client:** if the host needs its own visual style in the playground, add it to `client/src/lib/client-styles/built-ins.ts`; if it needs a capability preset, add an `MCP_APPS_<HOST>` matrix in `sdk/src/host-compat/capabilities.ts` (wrap in `frozen()` — the module constants are shared and a consumer mutating one would poison verdicts process-wide).
4. **Regenerate the fallback** (same command as Walkthrough A, step 3).
5. **Verify** (§5) and open the two PRs.

---

## 4. Provenance levels

Canonical enum: **`CompatProvenance = "observed" | "vendor-doc" | "probe" | "assumed"`** (`sdk/src/host-compat/types.ts`). The doc-site labels "Probe-captured" / "Vendor docs" / "Best-effort preset" map to `probe` / `vendor-doc` / `assumed` — use the enum values in code, not the labels.

Trust ranking (weakest → strongest, `PROVENANCE_RANK` in `evaluator.ts`):

| Value | Meaning | Use when |
| --- | --- | --- |
| `assumed` | Best-effort preset; nobody verified it | You're seeding a host from public impressions or another host's baseline |
| `probe` | Captured by running a probe server inside the client | A `host-capability-probe` run produced the matrix |
| `vendor-doc` | Vendor's published documentation says so | You're transcribing official docs (link them in the PR) |
| `observed` | Earned by a live run at runtime | **Never set this in the seed** — the backend validator only accepts the other three; `observed` is granted live and never published |

Verdicts roll up the *weakest* provenance of any capability they relied on (`weakestProvenance`), so downgrading one capability's evidence can downgrade a host's whole verdict badge. The SDK Zod schema (`catalog-schema.ts`) parses all four values and `.catch`es unknown future values to `assumed` — forward-compat skew degrades trust rather than crashing.

---

## 5. Verifying your change

### Tests, per layer

| Layer | Where | Command |
| --- | --- | --- |
| Backend seed/publish/reconcile | `mcpjam-backend/convex/marketHostCatalog/__tests__/` (lib, catalog, reconcile, notify, hostCatalogRoute) | `npm run test:once` in `mcpjam-backend` (or `npx vitest run convex/marketHostCatalog`) |
| SDK catalog + evaluator | `sdk/tests/host-compat-catalog.test.ts`, `sdk/tests/host-compat-evaluator.test.ts` | `npm test -w @mcpjam/sdk` from `inspector/` |
| Inspector proxy (tri-state) | `mcpjam-inspector/server/routes/v1/__tests__/host-catalog.test.ts` | `npx vitest run server/routes/v1/__tests__/host-catalog.test.ts` in `mcpjam-inspector/` |
| Client compat UI | `client/src/lib/host-compat/__tests__/`, `client/src/components/compat/__tests__/HostCompatMatrix.test.tsx` | `npx vitest run client/src/lib/host-compat client/src/components/compat` in `mcpjam-inspector/` |
| Fallback drift guard | generated file vs seed | `MCPJAM_BACKEND_DIR=… npm run check:host-catalog-fallback -w @mcpjam/sdk` |

### Confirming live vs bundled serving

The envelope tells you which state served — read `source` and `version` from the JSON body (there is no dedicated header):

```bash
curl -s http://localhost:6274/api/v1/host-catalog | jq '{source, version, contentHash}'
```

- `source: "live"`, `version >= 1` → your deployed backend served it. `Cache-Control: public, max-age=300`.
- `source: "bundled"`, `version: 0`, empty `contentHash` → the proxy fell back to the SDK snapshot (`CONVEX_HTTP_URL` unset/unreachable and no warm cache). `Cache-Control: no-store`.
- Stale is live data past its refresh: last-good cached envelope (its original `source`) served with `Cache-Control: no-cache` after an upstream failure.

End-to-end check for a capability edit: hit the endpoint against your dev backend and confirm the new value and a bumped `version`:

```bash
curl -s http://localhost:6274/api/v1/host-catalog \
  | jq '.catalog.hostsById.cursor.mcpProfile.apps.mcpAppsOverrides.openLinks'
```

The first request after a backend deploy is what triggers reconcile-on-read, so a bumped `version` on that request *is* the proof your seed change published.

### Where verdicts surface

Spot-check the visible result in the inspector: the compat matrix (Clients tab) and playground emulation should reflect the new value once the client refetches (`use-host-catalog.ts` maps envelope state to `live | fallback | error`).

---

## 6. Gotchas

- **Don't hand-edit `catalog.generated.ts`** — the drift check fails CI and your edit is overwritten by the next regeneration.
- **`templates.ts` and `seed.ts` are two halves of one entry.** A host id present in only one map throws at publish time.
- **`observed` never goes in the seed.** The backend validator rejects it; it's earned at runtime.
- **Two repos, two PRs.** Backend carries the truth; the inspector/SDK PR carries the regenerated fallback (+ preset changes). Cross-link them.
- **No "deploy the seed" step exists.** If the live catalog looks stale after a backend deploy, hit `GET /public/host-catalog` once (reconcile-on-read) before reaching for the manual `npx convex run marketHostCatalog/seed:seedMarketHostCatalog`.
- **Release parity check is a heads-up, not a gate.** `check:host-catalog-fallback:remote` (release.yml) compares the packed SDK snapshot against the live catalog and writes a step summary; it doesn't block publishing.

---

*Feedback loop (HP-11 acceptance): if you follow this guide and hit friction, note it in the PR or in the Kestral task and fold the fix back into this file.*
