# meticulous local

Commands for working with Meticulous data relative to your local git branch.

## local relevant-sessions

```bash
meticulous local relevant-sessions [options]
```

**Purpose:** Find recorded user sessions that exercise the code paths changed on your current branch (relative to the merge-base with the base branch). For each session, also returns the `baseReplayId` — the replay of that session on the merge-base commit — so you can immediately diff your local changes against it.

**Options:**

| Option                                                                       | Type         | Default                | Description                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--apiToken`                                                                 | string       | —                      | Meticulous API token; otherwise use the default auth chain (see `auth whoami`)                                                                                                                                                          |
| `--showMaybeRelevant`                                                        | boolean      | `false`                | Also show sessions that may be affected by the changes                                                                                                                                                                                  |
| `--startingPointSha`                                                         | string       | —                      | Only consider changes since this commit SHA. The merge-base is still used to find the base test run, but the diff is computed from `startingPointSha` instead. Use in agentic loops to scope each iteration to only the latest changes. |
| `--minimum-times-to-cover-each-line` (alias `--minimumTimesToCoverEachLine`) | number       | —                      | Select at least this many sessions to cover each edited line, choosing the most diverse subset when more candidates are available                                                                                                       |
| `--include-superfluous-sessions` (alias `--includeSuperfluousSessions`)      | boolean      | `false`                | Also include sessions that do test some of the changes but were superfluous given `--minimum-times-to-cover-each-line` — other sessions already cover the code sufficiently                                                             |
| `--format`                                                                   | `multi-file` | —                      | Set to `multi-file` to download each relevant session's data as a structured directory tree. See the `meticulous-use-session-data` skill for details on the output structure.                                                           |
| `--outputDir`                                                                | string       | `.meticulous/sessions` | Output directory for multi-file format                                                                                                                                                                                                  |

**Exit behaviour:** Exits with code 1 if the project cannot be retrieved or the repository is not a git repo.

## Output

The command prints to stderr. Example output:

```
Base test run ID: tr_abc123
Base test run URL: https://app.meticulous.ai/...

Found 2 relevant sessions:
  Session ID: ses_aaa111
  Title: User logs in and views dashboard
  Description: Covers the login form and redirect to /dashboard
  Base replay ID: rpl_base_aaa
  Relevance: IsRelevant

  Session ID: ses_bbb222
  Title: Checkout flow
  Base replay ID: rpl_base_bbb
  Relevance: IsRelevantBeta

Also found 3 maybe relevant sessions. Run command with --showMaybeRelevant to show these.
```

**Key fields per session:**

| Field                   | Description                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Session ID`            | Pass as `--sessionId` to `meticulous simulate`                                                                                                                                                                           |
| `Title` / `Description` | Human-readable summary of the user flow this session covers                                                                                                                                                              |
| `Base replay ID`        | Replay of this session on the merge-base commit. Pass as `--baseReplayId` to `meticulous simulate` to diff your local changes against the base. May be absent if the session has never been replayed on the base branch. |
| `Relevance`             | `IsRelevant` or `IsRelevantBeta` — directly exercises changed code. `IsMaybeRelevant` — may be affected (only shown with `--showMaybeRelevant`).                                                                         |

## Using `--startingPointSha` in an iterative loop

When implementing a multi-step change and committing after each step, pass the SHA of the most recent step's commit so the command only considers changes since that checkpoint:

```bash
# After committing step N, find sessions for step N+1's uncommitted changes
LAST_SHA=$(git rev-parse HEAD)
# ... make changes for step N+1 ...
meticulous local relevant-sessions --startingPointSha=$LAST_SHA
```

Without `--startingPointSha`, the diff is computed against the merge-base, which includes all changes on the branch so far.

## Examples

```bash
# Find sessions relevant to all uncommitted + committed changes on this branch
meticulous local relevant-sessions

# Include maybe-relevant sessions
meticulous local relevant-sessions --showMaybeRelevant

# Only consider changes since a specific commit (useful after committing step N)
meticulous local relevant-sessions --startingPointSha=abc1234

# Download structured session data for relevant sessions
meticulous local relevant-sessions --format=multi-file

# Download to a custom directory
meticulous local relevant-sessions --format=multi-file --outputDir=./test-data
```
