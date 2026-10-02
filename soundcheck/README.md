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
| Release readiness | Where is the release, and what is it waiting on? |
| Release dry-run | What will Start release put in the version PR? |
| Release progress stepper | Is the running release done yet / stuck? |
| Drift & freshness alerts | Is anything rotting I need to address? |

The scaffold (this commit) only ships a protected hello-world page. Each
feature lands in a follow-up commit.

## Running locally

Use Node.js 22.11.0 or later (required by AuthKit). Confirm the Railway builder and runtime use a supported version before promoting an AuthKit upgrade.

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

`release.yml` does **not** call this workflow. It used to, as a
`deploy-soundcheck` job alongside `deploy-slack-app`, but the two are not
alike: the Slack bot renders the inspector server's envelope and so must
deploy after it, whereas Soundcheck talks only to `api.github.com` and has no
such contract. Being in the release also made it deploy twice — once as the
job, then again from the release's own version commit, which touches root
`package-lock.json` and trips the `paths` filter above. That push trigger is
now the single path: a release redeploys Soundcheck when its version PR
merges.

Soundcheck is never *published* — it is not part of the customer release
surface, and nothing customers receive depends on it.

Note for anyone editing `release.yml`: `src/components/release-progress.tsx`
hardcodes the job list, and `release-readiness.tsx` / `release-verdict.tsx`
mirror preflight's gates. `src/lib/release-state.ts` mirrors the version PR
branch and run naming in `.github/scripts/release-pr.mjs` and
`release-trigger.mjs`. All of these are hand-synced and will silently drift.

## How a release runs

1. **Start release** dispatches `prepare-release.yml`. It runs
   `changeset version` on `main` and opens the version PR
   (`release/version-packages`), with the deploy flags as checkboxes.
2. Someone approves and merges the version PR. That is the release.
3. `release-trigger.yml` watches Tests, Build and Test and Deploy Staging
   finish on `main` and dispatches `release.yml` at the first commit that is
   green on all three and still carries versions npm does not have.
4. `release.yml` publishes those versions, deploys what the PR ticked, tags
   the commit and publishes the GitHub release. It never writes to `main`.

**Run release now** (action `publish`) dispatches `release.yml` by hand. It is
the retry path: the trigger does not retry an automatic run that failed or was
cancelled.

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
| `GITHUB_PAT` | GitHub REST + Compare + Actions, plus `workflow_dispatch` for `prepare-release.yml` / `release.yml` / `deploy-mcp-prod.yml` (fine-grained, scoped to both repos, `actions:read/write` + `contents:read` + `deployments:read` + `metadata:read` + `pull_requests:read` for the version PR) | 90 days |
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

### Authentication regression checks

Run `npm run test:auth -w @mcpjam/soundcheck` to check the actual Next.js middleware and callback with synthetic credentials and a local mock WorkOS endpoint. This verifies anonymous-route protection, non-cacheable responses, and callback validation. It does not replace a staging sign-in, refresh, and logout check with the deployed WorkOS configuration.
