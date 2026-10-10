# meticulous debug

Commands for setting up self-contained debug workspaces that bundle replay data, session recordings, diffs, analysis artifacts, and AI agent context files. The workspace is designed to be opened in an AI coding tool (Claude Code, Cursor, etc.) for assisted debugging.

Workspaces are created under `~/.meticulous/debug-sessions/` by default.

## debug replay-diff

```bash
meticulous debug replay-diff <replayDiffId> [options]
```

**Purpose:** Debug a specific replay diff. Downloads the head and base replays, session data, diff results, and PR diff, then generates a workspace with analysis artifacts and AI context.

**Required arguments:**

| Argument       | Type                | Description                 |
| -------------- | ------------------- | --------------------------- |
| `replayDiffId` | string (positional) | The replay diff ID to debug |

**Options:**

| Option            | Type   | Default   | Description                                                                    |
| ----------------- | ------ | --------- | ------------------------------------------------------------------------------ |
| `--apiToken`      | string | —         | Meticulous API token; otherwise use the default auth chain (see `auth whoami`) |
| `--sessionId`     | string | —         | Override the session ID for this replay diff                                   |
| `--workspaceName` | string | timestamp | Custom name for the debug workspace directory                                  |
| `--screenshot`    | string | —         | Screenshot filename to focus analysis on                                       |

**Example:**

```bash
meticulous debug replay-diff rd_abc123
meticulous debug replay-diff rd_abc123 --screenshot="checkout-page.png"
```

---

## debug replay

```bash
meticulous debug replay <replayId> [options]
```

**Purpose:** Debug a replay by ID, optionally comparing it against a base replay. Useful when you have replay IDs from simulation output rather than a replay diff ID.

**Required arguments:**

| Argument   | Type                | Description                          |
| ---------- | ------------------- | ------------------------------------ |
| `replayId` | string (positional) | The replay ID to debug (head replay) |

**Options:**

| Option            | Type   | Default   | Description                                                                    |
| ----------------- | ------ | --------- | ------------------------------------------------------------------------------ |
| `--apiToken`      | string | —         | Meticulous API token; otherwise use the default auth chain (see `auth whoami`) |
| `--baseReplayId`  | string | —         | Base replay ID to compare against                                              |
| `--sessionId`     | string | —         | Override the session ID                                                        |
| `--workspaceName` | string | timestamp | Custom name for the debug workspace directory                                  |
| `--screenshot`    | string | —         | Screenshot filename to focus analysis on                                       |

**Example:**

```bash
# Debug a single replay
meticulous debug replay rpl_aaa

# Debug with comparison against a base replay
meticulous debug replay rpl_aaa --baseReplayId=rpl_bbb
```

---

## debug clean

```bash
meticulous debug clean [--all]
```

**Purpose:** Clean up debug workspaces. By default, opens an interactive menu to select which workspaces to delete. Use `--all` for non-interactive deletion (e.g. from scripts or AI agents).

**Options:**

| Option  | Type    | Default | Description                                                                       |
| ------- | ------- | ------- | --------------------------------------------------------------------------------- |
| `--all` | boolean | `false` | Delete all workspaces without prompting (useful for non-interactive environments) |

**Interactive mode (default):** Lists all workspaces with their sizes, then offers three choices:

1. Delete all workspaces (with confirmation)
2. Select individual workspaces to delete
3. Cancel

**Non-interactive mode (`--all`):** Lists all workspaces and deletes them immediately without prompting.

**Example:**

```bash
# Interactive cleanup
meticulous debug clean

# Non-interactive — delete everything
meticulous debug clean --all
```

---

## Workspace Contents

Each debug workspace contains:

| Directory       | Contents                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `debug-data/`   | Replay archives, session recordings, diff results, filtered logs, and analysis artifacts          |
| `.claude/`      | AI agent context files (CLAUDE.md, rules, skills, hooks) for assisted debugging                   |
| `project-repo/` | A git worktree of your codebase at the relevant commit (only if run from within a git repository) |

The workspace path is copied to the clipboard on creation. Open it in your preferred tool:

```bash
# Claude Code
cd "<workspace-path>" && claude

# Cursor
cursor "<workspace-path>"
```

## Git Worktree

When run from within a git repository, the command detects the repository root, fetches the relevant commit SHA (from the replay diff or replay), and creates a `git worktree` at `project-repo/` inside the workspace. This is automatically cleaned up by `debug clean`.
