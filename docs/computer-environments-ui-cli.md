# Plan: Computer Environments — Inspector UI + CLI API

Branch: `feat/computer-environments` (off current `origin/main`).

## Context

The Convex backend (mcpjam-backend, merged #618–#629) ships a complete, live-
verified "Computer environments" feature: a project-owned Dockerfile is built
into an immutable E2B image that a member's personal Computer can boot from
(`setComputerEnvironment`), plus reset-to-image (`resetComputer`). It's fully
tested but **unreachable** — no UI surfaces it and the CLI can't drive it. This
adds both, entirely in the inspector repo. **No backend changes** — every Convex
function already exists and is reachable as-is.

## Repo layout (this is a monorepo — get the package right)

| Package | Path |
|---|---|
| Inspector app (frontend) | `mcpjam-inspector/client/…` |
| Inspector server (Hono) | `mcpjam-inspector/server/…` |
| CLI | `cli/…` (top-level) |
| Platform SDK | `sdk/…` (top-level) |
| Public API spec | `docs/reference/openapi.json` (top-level) |

> An agent editing `client/…` or `server/…` at the repo root will edit the wrong
> place — those exist only on the older flat-layout branches.

## How each consumer reaches the backend (verified)

- **UI** calls Convex **directly by string id**, like the existing Computer tab
  (`mcpjam-inspector/client/src/hooks/useProjectComputer.ts` →
  `useQuery("projectComputers:getComputerStatus", { projectId })`,
  `useMutation("projectComputers:getOrReserveComputer")`,
  `useAction("projectComputers:mintTerminalToken")`).
- **CLI** rides the existing bridge (precedent: `mcpjam-inspector/server/routes/web/servers.ts`,
  `…/routes/shared/evals.ts`): a `v1` Hono route →
  `new ConvexHttpClient(CONVEX_URL); client.setAuth(await getConvexBearerForRequest(c))`
  → `client.query/mutation("computerEnvironments:…")`. The delegated JWT (minted
  from the caller's `sk_` key in `mcpjam-inspector/server/utils/v1-convex-token.ts`)
  makes the `userMutation` resolve the acting user. Mirror the `hosts` stack.

## Backend functions consumed (all deployed; no changes)

`computerEnvironments`: `listEnvironments(projectId)`, `getEnvironment(environmentId)`,
`listEnvironmentBuilds(environmentId)`, `createEnvironment(projectId,name,dockerfile)`,
`updateEnvironment(environmentId,name?,dockerfile?)`, `startEnvironmentBuild(environmentId)`,
`promoteEnvironmentToProject(environmentId)`, `deleteEnvironment(environmentId)`.
`projectComputers`: `getComputerStatus(projectId)` (→ `environmentId`),
`setComputerEnvironment(projectId, environmentId | null)`, `resetComputer(projectId)`.

`EnvironmentView` (returned by list/get) includes: `environmentId`, `projectId`,
`name`, `dockerfile`, `sharing` (`'user'|'project'`), `isOwner`, `currentBuild`
(status/error/logPreview/…). **Note it does NOT expose a "can manage shared" /
admin flag** — see UI step 6.

> Builder/runtime compatibility: a build's vendor template can only be launched
> by the SAME provider that built it (#626). With `COMPUTERS_PROVIDER=e2b` and the
> default `COMPUTERS_ENV_BUILDER=stub`, **attach FAILS by design** — the backend
> rejects the incompatible pin. So custom images are only attachable once real
> builds are enabled. The UI/CLI must surface that rejection cleanly, not assume
> "stub behaves identically."

---

## Part A — UI (frontend only, `mcpjam-inspector/client/`)

Reference files (current `origin/main`):
`…/components/computer/ComputerView.tsx` (the tab), `…/hooks/useProjectComputer.ts`
(hook + view-type pattern), `…/components/computer/ComputerStatusChip.tsx`.
Design system `@mcpjam/design-system`: `Button`, `Badge`, `Sheet`, `Dialog`,
`Tabs`. Editor: CodeMirror 6 (`…/client/src/components/ui/json-editor/`), not
Monaco. `projectId` comes from `useAppRouteContext()` and is passed into
`ComputerView` as a prop today.

1. **`…/client/src/hooks/useComputerEnvironments.ts`** — mirror
   `useProjectComputer.ts` (string-id `useQuery`/`useMutation`): `useEnvironments`,
   `useEnvironment`, `useEnvironmentBuilds`, `useCreateEnvironment`,
   `useUpdateEnvironment`, `useStartEnvironmentBuild`, `usePromoteEnvironment`,
   `useDeleteEnvironment`, `useSetComputerEnvironment`, `useResetComputer`. Declare
   matching TS view types.
2. **`ComputerView.tsx`** — add an **Image** strip between the subtitle and the
   usage meter: current image name (resolve `getComputerStatus().environmentId`
   via `useEnvironments`), **[Change ▾]** (opens drawer), **[Reset]** (confirm →
   `resetComputer`, enabled only Ready/asleep).
3. **`…/components/computer/EnvironmentsDrawer.tsx`** — design-system `Sheet`.
   - **Create is first-class**: an empty state ("No environments yet — create one
     to customize your computer's image. [+ New environment]") AND a persistent
     **[+ New environment]** in the list. New opens a fresh editor (name +
     Dockerfile) → `createEnvironment` → land on the new env's detail with **Build**
     ready.
   - **List**: own drafts + project-shared, status badges from `currentBuild`, ✓ on
     the attached one, ⋯ = Promote/Delete.
   - **Detail**: name, **Dockerfile editor** (CodeMirror), **Build** (+ live
     status/log tail by polling `getEnvironment`/`listEnvironmentBuilds`), **Use on
     computer** (`setComputerEnvironment`, disabled until a Ready build), **sharing**
     toggle (Just me / Project → `promoteEnvironmentToProject`), **Delete**.
4. **Confirms** (`Dialog`): attach/change ("rebuilds your computer; installed
   files are wiped") and reset — both wipe mutable computer state.
5. **States**: empty, building (spinner + log), failed (error + log + retry), and
   **attach-rejected** (surface the backend's incompatible-builder / not-ready
   error as a clean toast).
6. **Admin controls — optimistic, not pre-disabled.** `EnvironmentView` has
   `isOwner` but no "can manage shared." So: for a **draft**, gate edit/build/
   delete on `isOwner`; for a **shared** env, render the controls **optimistically**
   and map the backend's permission error (thrown by `canManageSharedEnvironments`)
   to a clean toast ("Only project admins can manage shared environments"). Do not
   pretend the client knows admin status. (Follow-up option: add a `canManage`
   field to `EnvironmentView` in the backend for nicer UX — out of scope here.)
7. **Tests**: mirror `…/components/computer/__tests__/ComputerView.test.tsx` —
   render states, hook mocks, the attach-rejected toast path.

No server/CLI/SDK/backend changes for Part A.

---

## Part B — CLI API (`mcpjam-inspector/server/`, `sdk/`, `cli/`)

Mirror the `hosts` stack: command (`cli/src/commands/hosts.ts`) → SDK operation
(`sdk/src/platform/operations.ts`) → client method (`sdk/src/platform/client.ts`)
→ v1 route (`mcpjam-inspector/server/routes/v1/hosts.ts`, mounted in
`…/routes/v1/index.ts`).

1. **`mcpjam-inspector/server/routes/v1/computer-environments.ts`** (Hono), mounted
   in `…/routes/v1/index.ts`, **kept off the guest allowlist**. Each handler:
   `getConvexBearerForRequest(c)` → `ConvexHttpClient.setAuth` →
   `client.query/mutation("computerEnvironments:…" | "projectComputers:…")` → v1
   envelope (reuse `v1Resource`/`v1PageJson`/`v1Error`). Endpoints under
   `/projects/:projectId/computer-environments`:
   - `GET` (list), `POST` (create), `GET/PATCH/DELETE /:envId`,
     `POST /:envId/build`, `GET /:envId/builds`, `POST /:envId/promote`,
     `POST /:envId/use` → `setComputerEnvironment`, plus
     `POST /projects/:projectId/computer/reset` → `resetComputer`.
   - **PROJECT-SCOPE GUARD (required):** the backend env mutations
     (`update`/`build`/`promote`/`delete`) authorize by the *env's* project, not
     the URL's `:projectId`. So before any `/:envId` call, the adapter MUST
     `getEnvironment(envId)` and assert `env.projectId === :projectId`, else `404`
     — otherwise a user with access to projects A and B could `PATCH
     /projects/A/.../envB` and mutate B's env via an A-scoped URL. (Cleaner
     long-term: backend project-scoped variants that take `(projectId, envId)`;
     tracked as a follow-up, not needed for this PR.)
2. **`sdk/src/platform/client.ts`** — HTTP methods: `listEnvironments`,
   `getEnvironment`, `createEnvironment`, `updateEnvironment`, `deleteEnvironment`,
   `buildEnvironment`, `listEnvironmentBuilds`, `promoteEnvironment`,
   `useEnvironment`, `resetComputer`.
3. **`sdk/src/platform/operations.ts`** — operations with zod input schemas +
   `resolveProjectOrThrow(client, input.project, signal)`.
4. **`cli/src/commands/environments.ts`**, registered in `cli/src/index.ts`:
   `mcpjam env list|get|create|edit|build|logs|use|reset|promote|delete`.
   `create`/`edit` read the Dockerfile from `--file <path>` or stdin (the "edit
   them with the CLI" requirement); `--format json` like the rest.
5. **OpenAPI:** add entries for every new route to **`docs/reference/openapi.json`**
   — the drift test `mcpjam-inspector/server/routes/v1/__tests__/openapi-drift.test.ts`
   fails otherwise.
6. **Tests**: server-route suite (mirror `…/routes/v1/__tests__`), incl. a test
   that **guests get 401** on these routes; the project-scope guard (env-B via
   project-A URL → 404); plus a CLI command test.

---

## Verification

- **UI**: run the inspector against the dev backend; create env → edit Dockerfile
  → build (stub ⇒ instant on dev) → attach → reset → delete. With
  `COMPUTERS_PROVIDER=e2b` + default stub builder, confirm attach is rejected with
  a clean error. Real builds need `COMPUTERS_ENV_BUILDER=e2b` on the deployment.
- **CLI**: with an `sk_` key — `mcpjam env create --file Dockerfile`,
  `mcpjam env build <name>`, `mcpjam env logs <name>`, `mcpjam env use <name>`;
  guest token → 401.
- typecheck + lint each package; **openapi-drift** + the new route/CLI tests pass.

## Sequencing / hygiene

1. Branch stays based on current `origin/main` — keep the diff to *only* this
   feature (no unrelated compat-UI churn).
2. Part A (UI) first — self-contained, highest user value.
3. Part B (CLI): v1 route (+ scope guard + openapi) → sdk client → sdk op → cli
   command.
