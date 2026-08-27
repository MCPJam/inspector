---
"@mcpjam/inspector": patch
---

Connector Bench: the relay in front of the backend's benchmark routes

A new `/api/web/bench/*` router fronts `/internal/v1/bench/*` for the chrome-less score site. It is the edge and nothing else — the run worker, the UI and write enforcement are separate lanes, and none of them are in this change.

**Two tokens on every call.** The service token says "this is the inspector"; the caller's own bearer says "on behalf of this user or guest". The backend derives the acting identity from the bearer and never from the body, so the relay sends no user id — the same contract `hostedTasksRoutes` already uses. The attested per-IP guest spend key rides along, hashed here so the raw address never reaches Convex.

**A 404 is a deployment state, not a failure.** The backend halves sit behind `BENCHMARK_RUNS_ENABLED` and land later, so a 404 with no envelope of ours in it — a bare routing 404, a flag that is off — degrades to a clean "benchmark runs are not enabled" (503 `FEATURE_NOT_SUPPORTED`) instead of a 500. That is what lets this merge before the flag flips. An entity 404 (`{ ok: false, error: … }`) still reads as a genuinely missing run or result link, so a bad result URL says so rather than blaming the deployment.

**Starting work is budgeted; continuing it is not.** `/preflight` and `/runs` dial a caller-named third party and commission paid work, so they carry a per-IP ceiling on top of the per-guest one. Polling and cancelling a run are deliberately exempt: charging them would let a start spend the last slot and then lock the caller out of the run they just paid for.

`POST /preflight` is the one route that does more than relay. It resolves a **saved** `projectId + serverId` — never a URL, never caller-supplied auth headers — dials it through the ordinary hosted authorize-and-connect path, captures the full live tool surface, and asks the backend to upsert the stable target and return a classification receipt plus the runnable categories, tracks and per-actor prefill. The snapshot is bounded (the target chooses how many tools it lists, not us) and drops server-controlled `_meta`, which classification does not read and which would otherwise become durable backend state.

`GET /results/:secret` takes no bearer at all, on the same reasoning as `/score`: a result link has to open in an incognito window, the secret in the URL is the whole credential, and repeat reads are served from a short-lived cache so a shared link cannot be turned into an amplifier aimed at our own backend. The service token is refused over cleartext and redirects are never followed, so neither credential can be replayed to a host we did not vet.

Ships `client/src/lib/apis/bench-api.ts` alongside it, shaped like `score-api.ts` — `authFetch` for the authed calls, a plain `fetch` for the result read, because a result page visitor may have no session to mint one from.
