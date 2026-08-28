# M0 Spike — Hosted Browser + WebMCP Runtime on E2B Desktop

Run 2026-08-28 against the live E2B API (team marcelo@mcpjam.com) using the
`e2b@2.29.0` + `@e2b/desktop@2.3.3` SDKs. Drivers in this directory; the
throwaway template `webmcp-desktop-spike` (`tsd3lnk51bdb3nyvsp3l`) was built via
SDK build-system-v2. All spike sandboxes killed; 20 pre-existing computer boxes
untouched. **Action: delete template `webmcp-desktop-spike` from the E2B
dashboard (no SDK delete API).**

## Verdict: GREEN. All 10 probes answered; architecture de-risked. Two plan revisions required.

| # | Probe | Result |
|---|-------|--------|
| 1 | `Sandbox.connect` on a paused box — auto-resume? | **AUTO-RESUMES.** connect resolved 744ms, `isRunning`=true immediately. Resolves the terminal-token vs resolve-sandbox contradiction: connect *does* resume. `ensureComputerReady`-first still correct as belt-and-suspenders. |
| 2 | Stream auth survive a reconnect from a fresh process? | **NO — authKey must be persisted on the row.** noVNC password is random per `stream.start()` and lives only in the starting process's memory. A fresh replica can neither `getAuthKey()` (throws) nor re-`start()` (throws "already running"). Row MUST cache the stream URL+password. |
| 3 | Second stream while one is live? | **Throws "Stream is already running."** Single-server; no supersede/dual. Multi-viewer = share the persisted URL, never re-start. |
| 4 | Stream URL framing headers — iframe-embeddable? | **YES.** noVNC page returns **no X-Frame-Options and no CSP** → embeds directly in the Browser Panel iframe. `BROWSER_STREAM_EMBED_DISABLED` stays a safety valve, not a necessity. |
| 5 | Do Xfce/Chromium/daemon survive pause→resume? | **THEY SURVIVE CLEANLY.** After resume: 11 chrome procs + xfce4-session + Xvfb all alive; toy server + noVNC also survived. **Contradicts the plan's "always kill-and-relaunch on wake."** |
| 6 | Boot→ready, RSS, resource spec/pricing | Desktop = **8 vCPU / 8 GB** (metrics `cpuCount:8`, `memTotal:8.3GB`). Idle desktop+Chrome ≈ **450 MB used**. `create()` resolves in ~1.5–11s; resume ~0.7s. **Desktop is 4× the standard computer's 2vCPU/2GB → 10 cr/hr almost certainly under-priced. Desktop-rate follow-up is NOT optional.** |
| 7 | Full WebMCP CDP contract headed, in-sandbox, pinned Chromium | **PASS.** Built template with Playwright 1.62.1 + Chromium 151.0.7922.34; launched HEADED on Xvfb `:0`; `document.modelContext` present, `echo` registered, invoke returned id-before-settle and completed with correct output. Identical to the local contract. |
| 8 | `fromTemplate` / derivation build feasibility | **WORKS.** `Template().fromDockerfile()` from `FROM e2bdev/desktop` base built in 93s–2m32s via SDK. `fromImage`/`fromTemplate`/`fromDockerfile` all exist. Custom-env desktop layer is feasible when triggered. |
| 9 | browserd transport: `getHost(port)` + bearer from a second process | **WORKS + security note.** `https://<port>-<id>.e2b.app` reachable cross-process; bearer header passes through (200 w/ token, **401 w/o**). **Every `getHost(port)` is a PUBLIC HTTPS endpoint** — browserd MUST enforce its own auth on every request (an unauthed browserd is world-reachable). |
| 10 | View-only stream URL / input disable | **YES.** `stream.getUrl({viewOnly:true})` sets `?view_only=true` (noVNC-enforced). Lease "view-only under agent control" is achievable at the URL layer; deeper enforcement still wants the render-only-during-lease fallback. |

## Plan revisions this spike forces

1. **Drop "always kill-and-relaunch on wake" (Design → Recovery; Risk #1).** Empirically the full desktop process tree — Xfce, Chromium, background daemons, noVNC — survives E2B pause/resume intact. Change the posture to: on wake, `ensureComputerReady` → `GET /healthz`; **kill-and-relaunch only on a failed health check or bootId mismatch**, not unconditionally. Bonus: a surviving browserd keeps a stable `bootId` across a snapshot, so in-flight command idempotency survives a pause — strictly better than the planned teardown. Keep bootId staleness detection; it's still how you catch the crash case.

2. **Desktop billing rate is a launch blocker, not a deferred follow-up (Non-goals table; Risk #8).** The stock desktop is 8 vCPU / 8 GB — 4× the standard computer the 10 cr/hr rate was calibrated for. Ship W1 with `runtimeKind:'desktop'` on the row (already planned) AND a desktop credit rate wired before any public exposure (W7). Spike Q6 has now answered "materially above 10 cr/hr": yes.

## Template findings (feed W1's production template)

- **Base:** `FROM e2bdev/desktop:latest` already bakes Xfce + Xvfb (`:0`, 1024×768x24) + x11vnc + noVNC on port 6080. Don't rebuild those.
- **Node is absent** from the stock desktop image — must bake Node 20 (browserd is a Node process).
- **Stock Chrome is 150.0.7871.114** — below the WebMCP pin. Must bake Playwright Chromium 151.0.7922.34.
- **Browser-install path gotcha:** the build runs as **root** but the sandbox runs as **`user`**. Playwright's default cache (`/root/.cache/ms-playwright`) is unreadable by `user`. **Must set `ENV PLAYWRIGHT_BROWSERS_PATH=/opt/mcpjam/ms-playwright` and `chmod -R a+rX`** before install. (Cost the spike one rebuild to discover.) Final binary: `/opt/mcpjam/ms-playwright/chromium-1234/chrome-linux64/chrome`.
- **Build path changed:** the E2B v1 CLI build (`e2b template build`) is **deprecated**; the stored CLI access token was invalidated. Use SDK **build-system-v2** (`Template.build`, API-key auth). The plan's "CLI-built like templates/computer/" is stale — the desktop template should build via the SDK. Worth reconciling `templates/computer/` too.
- `playwright-core` is CommonJS — the browserd bundle must `require`/default-import it, not named-ESM-import.

## Working template Dockerfile (validated end-to-end)

See `desktop-spike/e2b.Dockerfile` in this directory — builds green and passes probe #7.
