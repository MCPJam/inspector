# meticulous auth

Authentication management for the Meticulous CLI. OAuth tokens are stored on disk and reused across sessions.

## auth whoami

```bash
meticulous auth whoami
```

**Purpose:** Report how the CLI is currently authenticated, and which project project-scoped commands would use.

**Output:** How the credential was obtained (`OAuth`, `project API token` / `test-run API token` plus where the token came from, or `credentials injected at request time`) and, for OAuth, name, email, admin status, and the organizations the user belongs to. Ends with the selected/pinned project when there is one.

**Options:**

| Flag     | Type    | Default | Description                                                                              |
| -------- | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `--json` | boolean | `false` | Print `{authenticatedVia, selectedProject, …}` on stdout instead of human-readable lines |

**Effects:**

- Read-only — reads the stored token (or probes for injected credentials) and queries the API
- In an interactive terminal with no stored token, the underlying auth chain may open a browser sign-in; with no TTY it instead fails with `Not logged in. Run \`meticulous auth login\`, or set METICULOUS_API_TOKEN. …`
- For an OAuth caller with no default project, additionally logs `No default project set. Run \`meticulous auth set-project\` to choose one.` on stderr

**Example output:**

```
Authenticated via: OAuth
Logged in as: Jane Smith (jane@example.com)
Organizations: acme-corp (member)
Selected project: acme-corp/Web App
```

---

## auth login

```bash
meticulous auth login
```

**Purpose:** Authenticate via browser SSO and store the resulting OAuth token on disk. If the account belongs to multiple projects, also prompts to pick a default project (saved to the account, so it's consistent across machines and available to the MCP server).

**Options:**

| Flag                | Type    | Default | Description                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--non-interactive` | boolean | `false` | Print the login URL and wait on a local callback server instead of opening a browser directly. Only works when a browser on the _same_ machine can reach that callback — for a human at their own terminal, prefer the interactive `meticulous auth login` instead.                                                                         |
| `--device`          | boolean | `false` | Log in via the OAuth device flow: prints a URL and a short code that can be opened and confirmed from a browser on _any_ device. Use this instead of `--non-interactive` when running on a remote or sandboxed machine (SSH session, container, cloud coding agent) where a browser on another device can't reach this machine's localhost. |
| `--project`         | string  | —       | Organization/project to set as default, skipping the interactive picker (e.g. `"Organization/Project"`)                                                                                                                                                                                                                                     |

**Effects:**

- Stores the OAuth token used by subsequent commands
- With `--project`, also sets the default project (see `auth set-project`)

---

## auth set-project

```bash
meticulous auth set-project
```

**Purpose:** Change the default project used by project-scoped commands (and the MCP server) without re-authenticating. Shows an interactive picker when run without `--project`. OAuth-only: it fails outright when a non-OAuth API token is in use (`METICULOUS_API_TOKEN`, or a token in `~/.meticulous/config.json`), since such a token is already bound to a single project. To pick a project as a user instead, remove that token first — unset `METICULOUS_API_TOKEN` and/or delete the `apiToken` entry from `~/.meticulous/config.json` — then run `meticulous auth login`.

**Options:**

| Flag        | Type   | Default | Description                                                                               |
| ----------- | ------ | ------- | ----------------------------------------------------------------------------------------- |
| `--project` | string | —       | Organization/project to set as default, non-interactively (e.g. `"Organization/Project"`) |

**Effects:**

- Updates the default project saved to the account
- Errors without changing anything when authenticated via a non-OAuth API token

---

## auth get-project

```bash
meticulous auth get-project
```

**Purpose:** Print the `organization/project` slug that project-scoped commands would currently resolve to (the account's default project, or the project pinned to an API token).

**No options** beyond global flags.

**Effects:**

- Read-only; exits non-zero if no default project is resolved

---

## auth list-projects

```bash
meticulous auth list-projects
```

**Purpose:** List the projects the authenticated account has access to. OAuth-only — if no token is stored and a TTY is present, this triggers an interactive OAuth login itself.

**Options:**

| Flag     | Type    | Default | Description                                                                           |
| -------- | ------- | ------- | ------------------------------------------------------------------------------------- |
| `--json` | boolean | `false` | Print `{id, name, organization: {name}}[]` instead of one `org/project` slug per line |

---

## auth logout

```bash
meticulous auth logout
```

**Purpose:** Revoke the session at the identity provider and clear all stored OAuth tokens from disk, effectively logging out.

**Effects:**

- Revokes the stored refresh token at the identity provider, so the session behind it can no longer be refreshed from any other copy of the token. If that call fails (offline, issuer unreachable) logout warns and still completes — the local tokens are cleared either way, but the session stays valid until it expires
- Deletes the cached OAuth token file used by the CLI
- Subsequent commands that require authentication will prompt for login again
- Clears **only** OAuth tokens: a `METICULOUS_API_TOKEN` env var or an `apiToken` in `~/.meticulous/config.json` survives and keeps being used — logout warns about each and they have to be removed by hand
- Leaves the account's default project alone (it's a server-side per-user setting, so it's still there after logging back in)

**Example:**

```bash
meticulous auth logout
# Logged out successfully.
```
