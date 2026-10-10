---
name: meticulous-cli-update
description: Check whether the Meticulous CLI (@alwaysmeticulous/cli) and skills are installed and up to date, and install/update them if not. Invoked at the start of every other Meticulous skill, since the CLI and skills are under active development with frequent changes and improvements.
user-invocable: false
---

# Install or update the Meticulous CLI

The `@alwaysmeticulous/cli` package is under active development and ships frequent changes and improvements. Other Meticulous skills assume the `meticulous` command is on `PATH` and up to date, so run this skill once at the start of any Meticulous workflow.

This only needs to run **once per conversation**. If you've already run it earlier in this conversation, skip it — there's no need to re-check the version or re-update on every Meticulous skill invocation.

**Using the MCP server instead of the CLI?** Steps 1-4 are about installing/updating the `meticulous` CLI binary and its own local auth — neither applies when calling tools on the hosted [Meticulous MCP server](https://app.meticulous.ai/api/mcp), which is already on the latest version and authenticates via the MCP connection itself, not `meticulous auth login`. Skip straight to **Step 5**: the installed **skills** (this document set) are a separate thing from the CLI/MCP tool itself and still need to stay current either way, regardless of which one you're calling tools through. One MCP-login gotcha worth knowing: if Claude Code fails the sign-in with "Issuer mismatch in authorization response (RFC 9207)", it is reusing a stale cached authorization-server URL — tell the user to choose **Clear authentication** (not Re-authenticate) for the Meticulous server in `/mcp`, then authenticate again.

Full setup instructions — installing the CLI, connecting the MCP server, and installing these skills — live at [app.meticulous.ai/docs/agents/setup](https://app.meticulous.ai/docs/agents/setup).

## How to handle the install/update commands

This skill normally runs as a sub-step of another Meticulous skill. The install/update commands below (Steps 1, 3, and 5) are security-sensitive — they install packages and reach the network — so treat them as **best-effort and non-blocking**:

- You generally can't tell in advance whether a command is whitelisted. If it's whitelisted it runs silently; if not, attempting it surfaces a permission prompt. Either outcome is fine — let that be how you find out.
- **If a command needs permission you don't have** (a prompt appears, or the user declines it), treat that as the signal to _recommend rather than force_. Tell the user it's recommended to do XYZ — e.g. "It's recommended to update the Meticulous CLI by running `npm install --global @alwaysmeticulous/cli@latest`" — and move on. A declined prompt is **not** a failure; it just means "do it later."
- **If the user doesn't want to run it now, continue anyway.** Do not stop the workflow; carry on with the remaining steps and then return to the calling skill. The only hard requirement is that the `meticulous` command exists at all (Step 1) — if it's genuinely not installed and the user declines to install it, no Meticulous skill can proceed, so stop there.

The read-only checks (`meticulous --version`, `npm view …`, `meticulous auth whoami`) are safe to run directly.

## Step 1 — Check the installed version

```bash
meticulous --version
```

**If the command is not found**, the CLI is not installed. Install it globally (best-effort, see the note above):

```bash
npm install --global @alwaysmeticulous/cli@latest
```

If installing isn't whitelisted, recommend the user run that command themselves. Because no Meticulous skill can run without the CLI, this is the one case where you should stop and wait if the user declines — there's nothing to continue with. Once installed, re-run `meticulous --version` to confirm it's on `PATH`, and skip to Step 4.

## Step 2 — Check the latest published version

```bash
npm view @alwaysmeticulous/cli version
```

## Step 3 — Update the CLI if outdated

If the installed version already matches the latest, skip to Step 4.

Otherwise, update according to how the CLI is installed (best-effort, see the note above — if updating isn't whitelisted, recommend the user run the appropriate command and continue regardless):

- **Globally installed** (typical — `which meticulous` resolves to a path outside the current project):

  ```bash
  npm install --global @alwaysmeticulous/cli@latest
  ```

- **Locally installed in the project** (`@alwaysmeticulous/cli` appears in the project's `package.json` and `which meticulous` resolves inside `node_modules/.bin`):
  ```bash
  npm install --save-dev @alwaysmeticulous/cli@latest
  # or, if the project uses pnpm:
  pnpm add --save-dev @alwaysmeticulous/cli@latest
  # or yarn:
  yarn add --dev @alwaysmeticulous/cli@latest
  ```

If the update ran, re-run `meticulous --version` and confirm it matches the latest before proceeding.

## Step 4 — Check authentication and project selection

Verify the user is authenticated with Meticulous and has a project selected:

```bash
meticulous auth whoami
```

Add `--json` if you'd rather branch on structured output — it prints `authenticatedVia` and `selectedProject`.

There are four outcomes:

### (a) Signed in via OAuth, with a project selected

```
Authenticated via: OAuth
Logged in as: Jane Smith (jane@example.com)
Organizations: acme-corp (member)
Selected project: acme-corp/Web App
```

Nothing to do — continue to Step 5.

### (b) Authenticated by an API token or injected credentials

```
Authenticated via: project API token (METICULOUS_API_TOKEN environment variable)
Pinned project: acme-corp/Web App
```

Also seen as `project API token (~/.meticulous/config.json)`, `test-run API token`, or `credentials injected at request time` (agent platforms that attach a bearer credential to outbound requests to `app.meticulous.ai`). These credentials are scoped to a single project, which is already pinned, so there is nothing to select — do **not** run `meticulous auth set-project`: with an API token it errors out (the token is bound to one project), and with injected credentials there is likewise nothing to choose. Continue to Step 5.

### (c) "Not logged in"

The command exits with:

> Not logged in. Run `meticulous auth login`, or set METICULOUS_API_TOKEN. In terminals without a browser, use `meticulous auth login --non-interactive`.

Sign-in is browser SSO, so a human always has to complete it in a browser; which login command to use depends on where you're running:

- **On the user's own machine** (a browser there can reach this machine's localhost):

  ```bash
  meticulous auth login --non-interactive
  ```

  This prints a login URL and then waits on a local callback server, so run it in the background, then surface the printed URL to the user and ask them to open it and complete sign-in. Once they do, the command finishes and stores the token, and you can continue.

  Alternatively, ask the user to run `meticulous auth login` themselves — at their own terminal that opens the browser directly.

- **On a remote or sandboxed machine** (cloud agent, SSH session, container) where a browser on another device can't reach this machine's localhost:

  ```bash
  meticulous auth login --device
  ```

  This uses the OAuth device flow: it prints a URL and a short code instead of waiting on a local callback. Run it in the background, then surface the URL and code to the user and ask them to open the URL on any device and enter the code. Once confirmed, the command finishes and stores the token.

Both forms skip the interactive project picker, so add `--project "Organization/Project"` when you already know which project to use — that logs in and pins the project in one step. Without `--project`, an account with access to several projects lands in case (d) below, so re-run `meticulous auth whoami` once login completes and handle whichever case it reports before continuing to Step 5.

In a CI-like environment with no human available at all, the alternative is an API token: set `METICULOUS_API_TOKEN` (or pass `--apiToken`) instead of logging in.

### (d) Signed in via OAuth, but no default project

`whoami` succeeds and additionally logs (on stderr):

> No default project set. Run `meticulous auth set-project` to choose one.

Project-scoped commands can't resolve a project in this state. It happens for accounts with access to several projects — including right after a `--non-interactive` or `--device` login, which skips the picker. List the options, then pin one:

```bash
meticulous auth list-projects   # one "organization/project" slug per line
meticulous auth set-project --project "Organization/Project"
```

Ask the user which one to use unless it's unambiguous (e.g. only one project is listed, or the repo clearly corresponds to one of them). Alternatively, ask the user to run `meticulous auth set-project` themselves — without `--project` it shows an interactive picker.

The selection is saved to the account rather than the machine, so it also applies to the MCP server and to the user's other machines. `meticulous auth get-project` prints the currently resolved project on its own.

## Step 5 — Update the installed Meticulous skills

The skills themselves are also under active development. How to update them depends on how they were installed (best-effort, see the note above):

- **Installed with `npx skills`** — the default. Skill files live under `.claude/skills/`, `.cursor/skills/`, or the equivalent for the agent, alongside a `skills-lock.json`:

  ```bash
  # Install or update all skills, for the specified agents
  npx skills add alwaysmeticulous/skills --skill "*" --agent claude-code --agent codex --agent cursor -y
  ```

  Only run this once you've seen a `skills-lock.json` (or the skill files themselves) in the project, since it would otherwise install a second copy alongside a plugin install.

- **Installed as the Claude Code plugin** — the skills show up namespaced as `/meticulous:<skill-name>`, and `claude plugin list` lists `meticulous@meticulous`. `npx skills` won't touch these; update the plugin instead:

  ```bash
  claude plugin update meticulous@meticulous
  ```

  Tell the user the update only takes effect after they restart Claude Code (they can also do this from the `/plugin` menu themselves). One exception: if `claude plugin list` reports the plugin's scope as `managed`, it's pinned by their organization's managed settings — don't try to update it, just mention it to the user.

- **Installed as the Codex plugin** — `codex plugin list` lists `meticulous@meticulous`. `npx skills` won't touch these either; refresh the marketplace, which also reinstalls the plugin if it changed:

  ```bash
  codex plugin marketplace upgrade meticulous
  ```

  The update takes effect in the next Codex session.

- **Installed from the Cursor plugin marketplace** — there's no command to run; recommend the user update it from Cursor's **Customize → Plugins**.

If the applicable command isn't whitelisted, recommend the user run it themselves. Either way — whether it ran, or the user declined — proceed with the calling skill.
