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
- `MCPJAM_INSPECTOR_PUBLIC_URL` set to the web tier's public origin. It also
  names the XAA issuer a claimed job mints under; see below.
- The same `XAA_IDP_PRIVATE_KEY` as the web service, if any project connects
  servers with Cross-App Access (see below).
- A drain long enough for the claimed jobs you want a deploy to finish:
  `MCPJAM_SHUTDOWN_DRAIN_MS`, clamped to `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`
  less the teardown margins (`bin/shutdown-settings.mjs`).

A worker missing `CONVEX_HTTP_URL` or `INSPECTOR_SERVICE_TOKEN` fails its boot
with the names of what is missing.

## Servers that use Cross-App Access

A claimed job connects an XAA server the way an interactive run does: the
inspector signs an ID-JAG as the MCPJam test IdP and exchanges it at the
server's authorization server, with nobody present. A job has no request to
read the issuer from, so it builds it from `MCPJAM_INSPECTOR_PUBLIC_URL` (else
`BASE_URL`): `<origin>/api/web/xaa`, scoped to the run's organization as
`/o/<org-id>`, or `/g/<org-id>` for a guest. That is the issuer an interactive
run in the same organization names, so an authorization server that trusts one
accepts the other. Hosted with neither variable set, the job refuses the server
with `Missing XAA issuer` rather than signing under a guessed origin.

The authorization server checks that ID-JAG against the JWKS the web tier
serves under the issuer. A separate worker therefore has to sign with the web
tier's key, `XAA_IDP_PRIVATE_KEY`; with a key of its own, every exchange is
rejected.

Under a host's enterprise-managed authorization policy, every `auto` server
connects with XAA, and one with no client registration is refused instead of
falling back to OAuth. Whether a loop applies that policy:

| Loop | Host policy | Why |
| --- | --- | --- |
| Scheduled eval runs | Applied, from the host the run executes under: the pinned environment's host, else the suite's own | An API launch of the same suite applies it, and a monitor should take the auth path a real run takes. Without it, an unconfigured `auto` server would connect through the discover path instead, with the schedule creator's own OAuth grant if they have one. |
| GitHub PR checks | Not applied | The one server is a throwaway row the check creates for the PR build, with no client registration. The policy could only refuse it, and registering it would hand a customer's client credentials to the PR's code. |
| Connector Bench runs | Not applied | Cleanup connects after every cell, under no cell's host, and has to reach what the cells created, so every connection uses the measured server's own auth settings. |

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

A scope step-up challenge raised through the harness MCP proxy does not reach
the worker. The proxy, on a web replica, is what sees the sandbox's tool call
fail with `insufficient_scope`. It hands the challenge to the turn when both
run in the same process, and otherwise relays it through the shared RPC-log
sink, which only hosted chat turns read. No claimed job needs it: an eval turn
has no step-up continuation and streams into a no-op writer, so its tool call
fails with the same error on any replica.

On the web replica the proxy then does one of two things, as it already does
whenever an eval's proxy calls land on a different web replica than the eval:

- If exactly one live harness turn there selected the same server, the
  proxy's fallback for stale correlation ids hands the challenge to that turn.
  A chat there may then ask its user to step up scope for that server.
- Otherwise it relays the challenge and holds the error answer for 1.25 s.
