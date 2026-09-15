# Bumping the pinned Chromium

A Chromium bump in this repository is a bump of a **fact base**, not a
dependency update. Nearly everything the WebMCP stack knows about the browser
was measured once, against one build, and written down as prose beside the code
it justifies: which feature flags are sufficient, whether tool annotations
survive a round trip, whether `toolsRemoved` fires on navigation, whether a
`_blank` navigation loses the page's tools, what the accessibility tree reports
for `<input type="password">`.

None of that is checked by types and none of it fails loudly when it stops being
true. A page simply offers no tools, or a screenshot comes back from the wrong
surface, or an act reports success against a form it never touched.

So the version is pinned in one place —
`server/services/webmcp-inspector/pinned-chromium.ts` — and
`__tests__/pinned-chromium.test.ts` fails when any other site disagrees with it.
When that test fails after a deliberate bump, this is the list.

## 1. The pin itself

| Site | What it decides |
| --- | --- |
| `package.json` → `playwright`, `@playwright/test` | which browser actually installs. **Exact versions, no caret** — a patch bump must not move the browser under a fact base measured against one build |
| `server/services/webmcp-inspector/pinned-chromium.ts` | `PINNED_CHROMIUM`, `PINNED_PLAYWRIGHT` — what the tests and the prose assert against |
| `.github/workflows/test.yml` | every `mcr.microsoft.com/playwright:v…-noble` container. All jobs, not the first one |
| `.github/workflows/post-deploy-smoke.yml` | same |

`pinned-chromium.ts` is deliberately **not** imported by `launch-args.ts`: the
launch path must work against whatever is actually installed (the UA correction
reads playwright-core's own `browsers.json` for exactly this reason), and a
launch that consulted a hard-coded version would start lying the moment the two
disagreed.

## 2. The Electron flags

Electron ships its own Chromium on its own schedule, so an Electron bump is a
second, independent browser bump.

- `src/main.ts` — `appendSwitch("enable-features", …)` and
  `appendSwitch("enable-blink-features", "WebMCP")`. **`appendSwitch` REPLACES
  the value for a key**, so a second call for the same key anywhere in that file
  drops WebMCP on the floor. A new feature is comma-joined into the existing
  call, never added as a second one.
- `scripts/local-browser-security-smoke.ts` — the same two switches, for the
  smoke harness.

## 3. The spikes to re-run

These are the measurements. Run them against the new browser and re-read what
they report; a spike that still passes is a finding that still holds.

```
npx playwright install chromium
npx vitest run --project server server/services/webmcp-inspector/
RUN_BROWSERD_SPIKE=true npx vitest run \
  server/services/browserd/daemon/__tests__/chromium-launch.spike.test.ts
```

`webmcp-cdp.spike.test.ts` is the big one. Findings to re-read rather than
merely re-run:

- **Flag sufficiency.** The `feature-flag sufficiency at the pinned Chromium`
  block asserts that `WEBMCP_LAUNCH_ARGS` alone is enough and that
  `DevToolsWebMCPSupport` is *not* required. **If the "without
  DevToolsWebMCPSupport" case ever fails, the decision is made**: add
  `DevToolsWebMCPSupport` to `WEBMCP_LAUNCH_ARGS` (it propagates to browserd
  automatically through `featuresEnabledBy`) and comma-join it into
  `src/main.ts`'s single `enable-features` call.
- **Annotations.** Whether `readOnly` / `untrustedContent` survive the CDP round
  trip, and in what shape.
- **`toolsRemoved` on navigation.** Whether the browser clears a frame's tools
  itself, or the bridge must.
- **`_blank` loss.** Whether a `target="_blank"` navigation drops the opener's
  registrations.
- **Password AX value.** What `Accessibility.getFullAXTree` reports for a filled
  `<input type="password">` — the fact the secret-placeholder masking depends
  on.

## 4. The prose

`pinned-chromium.test.ts` walks these and fails if any names a different build:

- `server/services/webmcp-inspector/launch-args.ts`
- `server/services/browserd/daemon/launch-args.ts`
- `server/services/webmcp-inspector/__tests__/webmcp-cdp.spike.test.ts`
- `server/services/browserd/daemon/__tests__/launch-args.test.ts`
- `shared/webmcp-inspector-protocol.ts`
- `docs/webmcp-inspector.md`
- `client/src/lib/__tests__/tool-form.webmcp-declarative.test.ts`

Dated documents — the security audits under `docs/security-audits/`, the
recorded benchmarks in `docs/browser-viewer-unification-*` — are deliberately
**not** in that list. They describe a run that happened against a browser that
was current then, and rewriting them would make them false.

## 5. Re-bundle the daemon

`server/services/browserd/daemon/launch-args.ts` imports
`webmcp-inspector/launch-args.ts`, so the Chromium feature flags ship inside the
checked-in daemon bundle. After any flag change:

```
npm run bundle:browserd -w @mcpjam/inspector
```

and commit both files in `server/services/browserd/dist/`. `pretest` runs
`node scripts/bundle-browserd.mjs --check`, which fails if you forget.
