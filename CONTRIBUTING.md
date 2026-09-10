# Contributing

First off, thank you for considering contributing to MCPJam Inspector! It's people like you that make the open source community such a great place.

## Finding an issue to work on

1. You can find things to work on in our [issues tab](https://github.com/MCPJam/inspector/issues).
2. Look for issues labelled `good first issue` and `very easy`. These are great starter tasks that are low commitment.
3. Once you find an issue you like to work on, comment on the issue and tag @matteo8p. Then assign yourself the issue. This helps avoid multiple contributors working on the same issue.

## Getting Started

Before you get started, please consider giving the project a star. It helps grow the project and gives your contributions more recognition.

Also join our [Discord channel](https://discord.com/invite/JEnDtz8X6z). That's where the community and other open source contributors communicate.

### Prerequisites

- [Node.js](https://nodejs.org/) — use the version in
  [`mcpjam-inspector/.nvmrc`](./mcpjam-inspector/.nvmrc) (`nvm use` picks it up).
  v22 is the floor for running the app; **Node 25 and newer cannot package the
  desktop app** — `electron-forge make` exits 0 and writes no `out/`, so the
  failure looks like success. Watch out for Homebrew here: its `node@24` and
  `node@25` formulae have both symlinked to Node 26, so check `node -v` rather
  than trusting the formula name.
- [npm](https://www.npmjs.com/) (comes with Node.js)

### Fork, Clone, and Branch

1.  **Fork** the repository on GitHub.
2.  **Clone** your fork locally:
    ```bash
    git clone https://github.com/YOUR_USERNAME/inspector.git
    cd inspector
    ```
3.  Create a new **branch** for your changes:
    ```bash
    git checkout -b my-feature-branch
    ```

### Project Structure

This is an **npm workspaces monorepo**. The main packages are:

| Workspace           | Package                 | Description                              |
| ------------------- | ----------------------- | ---------------------------------------- |
| `mcpjam-inspector/` | `@mcpjam/inspector`     | Inspector app (client, server, Electron) |
| `sdk/`              | `@mcpjam/sdk`           | MCP SDK for testing and evals            |
| `cli/`              | `@mcpjam/cli`           | CLI tool                                 |
| `design-system/`    | `@mcpjam/design-system` | Shared UI components                     |
| `soundcheck/`       | `@mcpjam/soundcheck`    | Soundcheck app                           |
| `mcp/`              | `@mcpjam/mcp`           | MCP worker                               |

Most contributions target the `mcpjam-inspector/` workspace.

### Setup

Install dependencies for all workspaces from the repo root:

```bash
npm install
```

## Development

Copy the env file inside the inspector workspace:

```bash
cp mcpjam-inspector/.env.local mcpjam-inspector/.env.development
```

Then start the inspector in dev mode:

```bash
npm run dev -w @mcpjam/inspector
```

This runs:

- **Client**: Vite dev server on `:5173`
- **Server**: Hono dev server on `:6274`
- **Platform MCP worker**: `mcp/` via `wrangler dev --env dev` on `:8787`

Open `http://localhost:5173` in your browser. The client proxies API requests to the server.

The platform MCP worker backs the Home/MCPJam agent's workspace tools (`list_projects`,
`show_servers`, eval/scenario tools). It starts automatically with `npm run dev`, and the
agent connects to it on `:8787` — no env var to set. If you only need the UI/server and
want to skip the worker (and its one-time UI build), use `npm run dev:app` instead.

### Dev Convex configuration (for the Home agent's platform tools)

The platform worker forwards your dev AuthKit token through `/api/v1` to the dev **Convex**
deployment (the one your `.env.development` `CONVEX_HTTP_URL` points at). That deployment
must trust the dev WorkOS app, or `list_projects` returns a 401. Set these once on the dev
Convex deployment (in the `mcpjam-backend` repo / Convex dashboard — this is backend/infra
config, not in this repo):

```bash
npx convex env set WORKOS_CLIENT_ID client_01KTN2EWHHJCKRB8RSR307X4SG
npx convex env set AUTHKIT_DOMAIN  deep-vanilla-68-test.authkit.app
npx convex env set GUEST_JWKS_URL  http://localhost:6274/api/web/guest-jwks
npx convex env list   # verify WORKOS_CLIENT_ID / AUTHKIT_DOMAIN are the dev values
```

### Electron Development

One command, from a fresh clone:

```bash
npm run electron:dev -w @mcpjam/inspector
```

**Stop `npm run dev` first.** The Electron renderer proxies `/api` to a
hardcoded `localhost:6274`, so if a separate dev server already holds that port
the window will quietly talk to it instead of to Electron's own embedded server.
The command warns you if the port is taken.

Its `pre` step builds the SDK if `../sdk/dist` is stale and regenerates the
gitignored bundles (`PluginShim.bundled.ts` and friends), so there is nothing to
run first. Then it starts:

- the Electron main process, with the embedded Hono server on `:6274`
- Vite's dev server for the renderer, which is what the window loads
- file watchers for the main and preload bundles

**Reload semantics**, which differ by process:

| You edit                            | What happens                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `client/` (renderer)                | Vite HMR, no restart                                 |
| `src/` (main, preload) or `server/` | bundle rebuilds, then the app restarts automatically |

A restart takes a couple of seconds and prints `[hot-restart] restart #N`. A
build error prints the error and does **not** restart, so you keep the last
working app until you fix it. You never need to type `rs`.

Four environment variables, for when you need them:

| Variable                            | Effect                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `MCPJAM_ELECTRON_DEV_NO_RESTART=1`  | never auto-restart (holding a breakpoint in main)                       |
| `MCPJAM_ELECTRON_DEV_SOURCEMAP=1`   | emit main-process sourcemaps (off in dev; ~47MB per rebuild)            |
| `MCPJAM_ELECTRON_DEV_BUNDLE_DEPS=1` | bundle dependencies as packaging does, instead of leaving them external |
| `MCPJAM_ELECTRON_DEV_TIMING=1`      | print per-build graph vs render timings                                 |

In dev, `node_modules` is right there, so dependencies are left external rather
than bundled — that is what keeps a rebuild at a few seconds instead of a
minute. Packaging still bundles everything, because the packaged app ships no
`node_modules`.

#### Packaging

`npm run electron:package` and `npm run electron:make` check their
preconditions first and refuse to start if something would fail silently — the
Node version, a missing `dist/client`, or (on macOS) the DMG maker's native
addons. Each failure prints the exact command that fixes it. If the addons are
the problem:

```bash
npm run electron:fix:dmg-deps -w @mcpjam/inspector
```

### Building the Project

To build everything (SDK, CLI, and Inspector):

```bash
npm run build
```

To build individual workspaces:

- `npm run build -w @mcpjam/sdk` - Build the SDK
- `npm run build -w @mcpjam/cli` - Build the CLI
- `npm run build -w @mcpjam/inspector` - Build the Inspector

To start the production build locally:

```bash
npm run start -w @mcpjam/inspector
```

### Running Tests

Run all tests and type checks:

```bash
npm run verify
```

Or run tests for a specific workspace:

```bash
npm run test -w @mcpjam/inspector
npm run test -w @mcpjam/sdk
npm run test -w @mcpjam/cli
```

#### WorkOS contract tests

The suites named `server/**/*.emulator.test.ts` boot
[`@workos/emulate`](https://github.com/workos/emulate) — WorkOS's own in-memory
API server — in-process and drive the real code paths against it, rather than
stubbing `fetch` and mocking token verification. That is what lets them assert
things only WorkOS can settle: that a spent refresh token is refused, that a
revoked API key stops validating immediately, that a forged JWT fails against
the issuer's real JWKS.

```bash
npm run test -w @mcpjam/inspector -- server/routes/web/__tests__/api-keys.emulator.test.ts
```

Each file starts its own emulator on port 0 in `beforeAll`, so nothing special
is needed in CI and the six shards cannot collide. The helper
(`server/test/support/workos-emulator.ts`) sets `WORKOS_API_BASE_URL` and the
other env itself — do not export that variable from your shell, and see
`mcpjam-inspector/HOSTED_DEPLOYMENT.md` for why it is loopback-only.

Requires **Node >= 22.11** (the emulator's floor; CI runs 24.x). The helper says
so explicitly rather than failing with a stack trace on an older runtime.

The pre-existing mocked suites (`api-keys.test.ts`, `bearer-auth.test.ts`,
`workos-authkit.test.ts`) are still the right place for logic that does not need
a server — they are faster, and they are also the regression guard proving the
default path still points at `api.workos.com`.

## Code Style

We use [Prettier](https://prettier.io/) to maintain a consistent code style. Before you commit your changes, please format your code by running:

```bash
npm run prettier-fix -w @mcpjam/inspector
```

## Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification. This helps us keep the commit history clean and readable.

Your commit messages should be structured as follows:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Example:**
`feat(client): add new button to the main component`
`fix(server): resolve issue with API endpoint`

## Getting Help

- [Discord](https://discord.com/invite/JEnDtz8X6z)
- [Docs](https://docs.mcpjam.com)

Thank you for your contribution!
