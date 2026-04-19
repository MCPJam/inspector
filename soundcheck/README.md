# @mcpjam/soundcheck

MCPJam's internal deployment dashboard.

Soundcheck is **not** published to npm and is **not** bundled into
`@mcpjam/inspector`. It deploys as its own Railway service
(`mcpjam-soundcheck`) at `https://soundcheck.mcpjam.com` and renders a cross-repo
view of MCPJam's delivery state.

It is a decision aid, not a status board. Every feature answers a recurring
delivery question; features that only show static state do not ship here.

## What it shows

| Feature | Decision it serves |
|---|---|
| Deploy-diff | Should we cut a release today? |
| Release readiness | Am I ready to run the Release workflow? |
| Release dry-run | What will Release produce if I click it? |
| Release progress stepper | Is the running release done yet / stuck? |
| Drift & freshness alerts | Is anything rotting I need to address? |

The scaffold (this commit) only ships a protected hello-world page. Each
feature lands in a follow-up commit.

## Running locally

From the repo root:

```bash
npm ci --legacy-peer-deps
cp soundcheck/.env.example soundcheck/.env.local
# fill in real tokens in soundcheck/.env.local
npm run dev -w @mcpjam/soundcheck
# open http://localhost:3100
```

For `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` / `WORKOS_COOKIE_PASSWORD`, reuse
the values from the staging Railway service. Employee gate requires your
email to be under a domain listed in `MCPJAM_EMPLOYEE_EMAIL_DOMAINS` while
`MCPJAM_NONPROD_LOCKDOWN=true`.

## Deploy

Auto-deploys on push to `main` via `.github/workflows/deploy-soundcheck.yml`
when `soundcheck/**`, root `package.json`, root `package-lock.json`, or the
workflow file itself changes. The workflow runs `railway up --ci` against the
`mcpjam-soundcheck` Railway service with a service-scoped token.

This workflow is independent of `release.yml`. Soundcheck is never part of
the customer release pipeline.

## Secrets & rotation

All secrets live outside source. There are two distinct buckets — one for the
running app, one for the deploy workflow.

### Runtime secrets (set on the Railway `mcpjam-soundcheck` service env)

Read by the Soundcheck app at request time to populate tiles.

| Secret | Purpose | Rotation |
|---|---|---|
| `RAILWAY_API_TOKEN` | Read Railway envs + deployments for dashboard tiles | 90 days |
| `CONVEX_DEPLOY_KEY_STAGING` | Read backend-staging state | 90 days |
| `CONVEX_DEPLOY_KEY_PROD` | Read backend-prod state | 90 days |
| `GITHUB_PAT` | GitHub REST + Compare + Actions, plus `workflow_dispatch` for `release.yml` / `deploy-mcp-prod.yml` (fine-grained, scoped to both repos, `actions:read/write` + `contents:read` + `deployments:read` + `metadata:read`) | 90 days |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` | Auth | per existing WorkOS policy |
| `MCPJAM_NONPROD_LOCKDOWN=true` | Employee gate on | n/a |
| `MCPJAM_EMPLOYEE_EMAIL_DOMAINS=mcpjam.com` | Allowed email domains | n/a |

### CI secrets (set as GitHub repo secrets on `MCPJam/inspector`)

Read by `deploy-soundcheck.yml` only. Not used by the running app.

| Secret | Purpose | Rotation |
|---|---|---|
| `RAILWAY_SOUNDCHECK_TOKEN` | Service-scoped Railway token used by the deploy workflow to run `railway up` | 90 days |

**Rotation owner:** Marcelo (chelojimenez). Reviewed quarterly.

## Ownership & sunset

Owner: Marcelo (chelojimenez). Responsible for dependency bumps, secret
rotation, and on-call for dashboard issues.

Sunset: if WorkOS session logs show no loads for 30 consecutive days,
archive this package and tear down the `mcpjam-soundcheck` Railway service.
No sentimental tools.

## Not in scope

- Re-rendering the GitHub Actions run graph (we link out to it).
- Rebuilding Railway's preview list (we link out).
- Rebuilding GitHub's deploy history feed (we link out).
- DORA metrics.
- Customer-facing surfaces.
- Triggering releases from the dashboard. Separate product decision for v2.
