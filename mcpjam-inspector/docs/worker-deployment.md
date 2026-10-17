# Running the claim loops in a worker deployment

A hosted inspector server does two jobs: it serves HTTP, and it runs four
claim loops that poll Convex for work and execute it in-process (scheduled
eval runs, GitHub PR checks, Connector Bench runs and production scoring).
`MCPJAM_PROCESS_ROLE` splits them, so a deploy of the web tier no longer
interrupts a claimed job, and the worker can drain for as long as its jobs
need.

| `MCPJAM_PROCESS_ROLE` | Serves HTTP | Runs the claim loops |
| --------------------- | ----------- | -------------------- |
| unset or `all`        | yes         | yes                  |
| `web`                 | yes         | no                   |
| `worker`              | yes         | yes                  |

`all` is today's single process and stays the default, so a self-hosted
inspector and an unsplit deployment need no change. An unknown value fails the
boot. Every start logs `server.process_role` with the role it resolved.

## What moves and what stays

Only the claim loops move. Work the web tier accepted over HTTP still runs
where it was accepted: UI and API eval runs, quick runs, swarm launches, and
the passes the backend's doorbells start. The web tier's drain
(`MCPJAM_SHUTDOWN_DRAIN_MS`) is what protects those across a deploy.

A claimed job needs nothing held by the web process. Its one call back into an
inspector is the harness MCP proxy (`/api/web/harness-mcp/{serverId}`), which
any replica serves from the request alone. The worker builds that URL from
`MCPJAM_INSPECTOR_PUBLIC_URL` (or `BASE_URL`), so in hosted mode it has to be
the web tier's public https origin. A hosted worker without it fails its boot
rather than running harness evals that would die at tunnel creation.

## The worker service

Deploy the same image as the web service (`mcpjam-inspector/Dockerfile`). It
needs no public domain; point its healthcheck at `/health`.

- `MCPJAM_PROCESS_ROLE=worker`.
- `VITE_MCPJAM_HOSTED_MODE=true`, as on the web service. Neither the image nor
  `.env.production` sets it, and without it the worker boots as a self-hosted
  inspector: it skips the public-origin check above and leaves local computer,
  browser and harness execution on, which hosted mode forces off.
- The loop flags, moved from the web service: `SCHEDULED_EVALS_WORKER_ENABLED=1`,
  `GITHUB_CHECKS_WORKER_ENABLED=1` with `GITHUB_CHECKS_E2B_TEMPLATE_ID`, and
  `BENCH_WORKER_ENABLED=1`. Production scoring has no flag and runs on every
  worker that holds the service credential.
- The same `CONVEX_URL`, `CONVEX_HTTP_URL`, `INSPECTOR_SERVICE_TOKEN` and
  `E2B_API_KEY` as the web service, against the same Convex deployment. The
  worker seals harness proxy policies that the web tier unseals, so both must
  resolve the same `COMPUTERS_TERMINAL_TOKEN_SECRET`, which they do when it
  bootstraps from the same deployment.
- `MCPJAM_INSPECTOR_PUBLIC_URL` set to the web tier's public origin.
- A drain long enough for the claimed jobs you want a deploy to finish:
  `MCPJAM_SHUTDOWN_DRAIN_MS`, clamped to `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`
  less the teardown margins (`bin/shutdown-settings.mjs`).

A worker missing `CONVEX_HTTP_URL` or `INSPECTOR_SERVICE_TOKEN` fails its boot
with the names of what is missing.

## Rollout

1. Create the worker service, and confirm it logs `server.process_role` with
   `worker` and starts claiming. Until step 2 both services claim; each claim
   is atomic in Convex, so this is only redundant.
2. Set `MCPJAM_PROCESS_ROLE=web` on the web service and redeploy it. Its loop
   flags can go; a web replica ignores them.
3. Add the worker service to the deploy workflow beside
   `RAILWAY_INSPECTOR_SERVICE`, so both ship the same commit.

To roll back, unset `MCPJAM_PROCESS_ROLE` on the web service and remove the
worker.

## Known difference

A harness eval that hits an insufficient-scope challenge records it in the
worker's memory, while the proxy request that reads it lands on a web replica.
The eval loses that challenge chunk (an eval cannot continue a step-up anyway)
and the proxy's error answer waits 1.25 s for it. The same already happens
whenever an eval and its proxy calls land on different web replicas.
