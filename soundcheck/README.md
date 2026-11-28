# @mcpjam/soundcheck

MCPJam's internal deployment dashboard.

Soundcheck is **not** published to npm and is **not** bundled into
`@mcpjam/inspector`. It deploys as its own Railway service
(`mcpjam-soundcheck`) at `https://soundcheck.mcpjam.com` and renders a cross-repo
view of MCPJam's delivery state.

It is a decision aid, not a status board. Every feature answers a recurring
delivery question; features that only show static state do not ship here.

## What it shows

| Part | Question it answers |
|---|---|
| Release card | Which version is next, where does it stand, what is live? One button: **Start release**, or **Retry release** after a failure. |
| Steps | Is the running release done yet, or stuck? |
| Services | What is live where? MCP promotes to production from its own tile. |

Detail sits behind a click (what's in a release, the run, the last release).

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
now the single path: a release redeploys Soundcheck when its version commit
lands.

Soundcheck is never *published* — it is not part of the customer release
surface, and nothing customers receive depends on it.

Note for anyone editing `release.yml`: `src/components/release-progress.tsx`
hardcodes the job list. `src/lib/release-status.ts` and `release-state.ts`
mirror the run naming and unpublished-version logic in
`.github/scripts/release-trigger.mjs` and `unpublished-versions.mjs`. All of these are hand-synced and will silently drift.

## How a release runs

1. **Start release** dispatches `prepare-release.yml`. It runs
   `changeset version` on `main`, and the release GitHub App pushes the
   result to `main` as one version commit: versions, changelogs, lockfile
   version entries and the consumed changesets, nothing else
   (`.github/scripts/release-commit.mjs`). It then dispatches `release.yml`
   on that commit with the deploy flags.
2. `release.yml` runs the full test suite and build, and waits for Deploy
   Staging to pass on the commit or a later `main` commit containing it,
   while it builds. Then it publishes the
   versions, deploys what Start release asked for, tags the commit and
   publishes the GitHub release.
3. If `main` moved before that run started, the run stands down without
   shipping and
   `release-trigger.yml` dispatches it again at the first commit that passes
   staging.

`main-push-guard.yml` checks every commit that reaches `main` without a pull
request, and alerts #prs if one changes more than versions.

**Retry release** (action `publish`) dispatches `release.yml` by hand. The
card offers it when versions on `main` are not on npm and no release is
running: the trigger does not retry a run that failed or was cancelled.

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
| `GITHUB_PAT` | GitHub REST + Compare + Actions, plus `workflow_dispatch` for `prepare-release.yml` / `release.yml` / `deploy-mcp-prod.yml` (fine-grained, scoped to both repos, `actions:read/write` + `contents:read` + `deployments:read` + `metadata:read`) | 90 days |
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
