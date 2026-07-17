# Docs screenshot capture harness

This directory holds the manifest and CLI used to (re)generate the product
screenshots referenced from the MCPJam docs (`docs/images/...`).

## Files

- `manifest.json`: the audited list of every screenshot the docs need. Each
  entry describes one PNG: where it lives on disk, which docs page it
  supports, how to reach the captured state, and its final alt text.
- `capture.mjs`: the CLI that reads the manifest and drives the capture.
- `README.md`: this file.
- `terminal.html`: HTML template for CLI output renders.
- `check-srcs.mjs`: cross-checks docs image references against files and manifest.
- `fixtures/reservation-server.mjs`: runnable MCP app fixture from the first-mcp-app guide, HTTP and stdio modes.

## Manifest schema

Each entry in `manifest.json#/entries` looks like:

```jsonc
{
  "id": "oauth-configure-modal",      // unique, kebab-case
  "kind": "ui",                        // "ui" or "terminal"
  "page": "inspector/guided-oauth.mdx", // docs page path, relative to docs/
  "tier": "A",                         // ui only: "A" | "B" | "C" (see Tiers below)
  "route": "/oauth-flow",              // ui only: app route to open
  "setup": ["..."],                    // ui only: steps to reach the captured state
  "command": "mcpjam",                 // terminal only: binary to run
  "args": ["--help"],                  // terminal only: argv
  "timeoutMs": 3000,                   // terminal only, optional: kill after N ms
  "output": "docs/images/oauth/oauth-configure-modal.png", // repo-root relative, always under docs/images/
  "alt": "Full sentence alt text for the <img> tag."
}
```

Routes that depend on an id resolved by a later task (for example a host
template id) are written with a literal `TODO-resolve` placeholder, for
example `/hosts?template=TODO-resolve`. `--validate` warns on these instead
of failing, so the manifest stays usable while those ids are still pending.

## CLI usage

```sh
node docs/scripts/screenshots/capture.mjs [--only <id>] [--kind ui|terminal] [--tier A|B|C] [--list] [--validate]
node docs/scripts/screenshots/capture.mjs --login
node docs/scripts/screenshots/capture.mjs --compress
```

- `--only <id>`: run a single entry by id.
- `--kind ui|terminal`: restrict to one kind of capture.
- `--tier A|B|C`: restrict to one UI tier (ignored for terminal entries).
- `--list`: print the selected entries (id, kind, tier, output path) and exit,
  without capturing anything.
- `--validate`: check the manifest for structural problems (see below) and
  exit 0 with `manifest OK (N entries)`, or exit 1 with a per-entry error
  list.
- `--compress`: scan every manifest output PNG on disk, re-encode any over 500 KB
  with sharp (keeping the result only if smaller), and print a size table of all
  PNGs.
- `--login`: the one manual step in this harness. Opens a real, headed
  Chromium window against `BASE_URL` (default `https://app.mcpjam.com`) and
  waits for a person to log in. Press Enter in the terminal once you're
  logged in, and it saves a Playwright storage state to
  `.screenshot-auth/state.json` (creating the directory if needed) and exits.
  Closing the browser window instead of pressing Enter aborts cleanly with a
  non-zero exit code and no file written. `.screenshot-auth/` is gitignored
  at the repo root -- the saved file is a live session credential, never
  commit it.

Filters combine: `--kind ui --tier A` runs only tier A UI entries.

### `--validate` checks

- Every `page` file exists under `docs/`.
- Every `output` path is under `docs/images/`.
- Every `id` is unique across the whole manifest.
- Every `ui` entry has a `route`; every `terminal` entry has a `command`.
- Every entry has alt text that does not contain the word "screenshot" or an
  em-dash.
- Entries whose `route` still contains `TODO-resolve` produce a warning, not
  a failure.

## Environment variables

- `BASE_URL` (default `http://localhost:5173`): base URL of the running
  inspector app that UI captures navigate against.
- `STORAGE_STATE` (path, tier C only): path to a Playwright storage-state
  JSON file with a logged-in session for the hosted MCPJam demo account.
  Tier C entries (dashboards, evals, hosted server pages, etc.) require this;
  tiers A and B do not. Produced by `--login` (see CLI usage above); typically
  `.screenshot-auth/state.json`.

## Tiers (UI entries only)

- **Tier A** ("local seedable"): reachable from a local dev build with no
  external services or LLM key, using fixture data seeded by `setup`.
- **Tier B** ("local + LLM key"): local dev build, but the captured state
  requires a real LLM call (for example a Playground tool call that renders
  a widget), so an LLM API key must be configured in the local environment.
- **Tier C** ("hosted logged-in session"): captured against the hosted
  MCPJam app using a `STORAGE_STATE` session for the demo account. These
  entries show account-specific UI (home dashboard, evals, hosted servers)
  that does not exist in a bare local build.

Terminal entries have no tier; they run the `mcpjam` CLI directly and only
need the binary to be built and on `PATH` (or invoked via its built entry
point).

## How to run a capture

1. Build the CLI so the `mcpjam` binary reflects the current source:
   ```sh
   npm run build -w @mcpjam/cli
   ```
2. For UI entries, start the inspector dev app and leave it running:
   ```sh
   npm run dev -w @mcpjam/inspector
   ```
   By default the harness targets `http://localhost:5173`; set `BASE_URL` if
   your dev server runs elsewhere.
3. For tier C entries, obtain a `STORAGE_STATE` file for the MCPJam demo
   account by logging in once with `--login`:
   ```sh
   node docs/scripts/screenshots/capture.mjs --login
   ```
   This opens a headed browser window against `BASE_URL` (default
   `https://app.mcpjam.com`); log in there, then press Enter in the terminal.
   It saves the session to `.screenshot-auth/state.json`. Then run the tier C
   captures against the hosted app with `STORAGE_STATE` pointed at it:
   ```sh
   BASE_URL=https://app.mcpjam.com STORAGE_STATE=.screenshot-auth/state.json node docs/scripts/screenshots/capture.mjs --tier C
   ```
   Never commit a `STORAGE_STATE` file; treat it like a credential
   (`.screenshot-auth/` is gitignored for exactly this reason).
4. Run the harness, optionally scoped to what you're working on:
   ```sh
   node docs/scripts/screenshots/capture.mjs --only oauth-configure-modal
   node docs/scripts/screenshots/capture.mjs --kind terminal
   node docs/scripts/screenshots/capture.mjs --tier A
   node docs/scripts/screenshots/capture.mjs
   ```
5. Check the summary line (`N ok, M failed`). A nonzero exit code means at
   least one entry failed; the per-entry `fail` lines above the summary say
   why.
6. Review every new or changed PNG visually before referencing it from an
   `.mdx` file.

## Known workaround: HTTP add-server is broken in local dev

`SETUP_STEPS.connect-widget-fixture` and `connect-demo-server` in
`capture.mjs` connect servers over STDIO, not HTTP, even though the reservation
fixture (`fixtures/reservation-server.mjs`) speaks both. This is a deliberate
substitution, not the original plan: in this dev environment, the web app's
HTTP "Add Server" flow is blocked before it ever reaches the MCP server. The
shared dev Convex backend's `servers:createServerIfMissing` / `updateServer`
mutations reject the client's `authMethod` field
(`ArgumentValidationError: Object contains extra field "authMethod"`), which is
a pre-existing schema mismatch on that shared backend, not something a
docs-only change can fix. STDIO add-server does not hit that code path and
works normally, and the reservation fixture's MCP server + widget behave
identically regardless of transport, so STDIO is a safe substitution for the
capture's purposes.

The one case that still needs a real HTTP server -- `send-excalidraw-prompt`,
which connects the genuine remote Excalidraw sample server -- sidesteps the
same bug by using the "Import Servers from JSON" modal instead of the regular
"Add Server" form: `parseJsonConfig` builds HTTP `ServerFormData` with no
`authMethod` field at all, so it never triggers the mutation rejection. See
`importHttpServerViaJson` in `capture.mjs` for that path.

## Notes for implementers of the actual capture logic

- All captures render at viewport 1440x900, `deviceScaleFactor: 2`, light
  theme, English locale.
- Terminal renders use a fixed 800px content width, dark template, and no
  ANSI parsing; the `mcpjam` CLI does not emit color codes, but the rare
  `\r\x1b[K` / `\x1b[2m...\x1b[0m` stderr sequences should be stripped before
  rendering.
- PNGs must be written to a temp path and renamed into place only on
  success, and recompressed (for example with `sharp`) if they exceed
  500 KB.
