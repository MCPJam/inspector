---
name: meticulous-use-session-data
description: Download and use structured Meticulous session data (user flows + network mocks) for testing code changes locally. Use when you need to understand what user interactions and API calls a test covers, or when you want network mocks for writing tests.
user-invocable: true
---

Use this workflow to get structured session data from Meticulous — the recorded user flows and network mocks that cover your code changes.

> Before starting, run the `meticulous-cli-update` skill to ensure the Meticulous CLI and skills are up to date — unless it has already run earlier in this conversation, in which case skip it.

## Step 1 — Find relevant sessions and download their data

Run the following command from the root of the git repository:

```bash
meticulous local relevant-sessions --format=multi-file --minimum-times-to-cover-each-line=1
```

This will:

1. Identify which recorded sessions exercise the code paths changed on your current branch.
2. Download each session's data as a structured directory tree to `.meticulous/sessions/`.

**Options:**

| Option                               | Type         | Default                | Description                                                                                                                       |
| ------------------------------------ | ------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--format`                           | `multi-file` | —                      | Set to `multi-file` to download each relevant session's data as a structured directory tree                                       |
| `--minimum-times-to-cover-each-line` | number       | —                      | Select at least this many sessions to cover each edited line, choosing the most diverse subset when more candidates are available |
| `--include-superfluous-sessions`     | boolean      | `false`                | Also include sessions that do test some changes but were superfluous given `--minimum-times-to-cover-each-line`                   |
| `--outputDir`                        | string       | `.meticulous/sessions` | Output directory for multi-file format                                                                                            |
| `--showMaybeRelevant`                | boolean      | `false`                | Also show sessions that may be affected                                                                                           |
| `--startingPointSha`                 | string       | —                      | Only consider changes since this commit SHA                                                                                       |

## Step 2 — Understand the output structure

The downloaded data is organized as follows:

```
.meticulous/sessions/
  manifest.json                       # List of all sessions with summary metadata
  sessions/
    <sanitized-session-id>/           # Special characters in session IDs are replaced for filesystem safety
      summary.json                    # Session overview: URL, viewport, duration, event count
      user-events.json                # Sequence of user interactions (clicks, typing, navigation)
      network-requests/
        summary.json                  # All network requests: method, URL, status (no bodies)
        <order>.json                  # Individual request/response pairs (with bodies)
      storage/
        cookies.json                  # Initial cookie state
        local-storage.json            # Initial localStorage state
        session-storage.json          # Initial sessionStorage (if present)
        indexed-db.json               # Initial IndexedDB (if present)
      url-history.json                # Page navigation history with timestamps
      context.json                    # Feature flags, user ID, custom context (if present)
      websockets/                     # WebSocket data (if present)
        summary.json                  # WebSocket connections overview
        <connection-id>.json          # Events for each connection
```

## Step 3 — Navigate the data

1. **Start with `manifest.json`** to see all available sessions. Each entry includes the session ID, start URL, event count, duration, and network request count. Pick the session(s) relevant to your task.

2. **Read `summary.json`** inside a session directory for a quick overview of that session — the starting URL, viewport size, total duration, and number of events.

3. **Read `user-events.json`** to understand the user flow. Each event has:
   - `type`: the interaction type (e.g., `click`, `input`, `scroll`)
   - `selector`: the CSS selector of the target element
   - `timestampMs`: when the event occurred
   - `coordinates`: click position (if applicable)

4. **Browse `network-requests/summary.json`** to see all API calls made during the session. Each entry shows the HTTP method, URL, status code, content type, and response time — without response bodies, so it's quick to scan.

5. **Read individual `network-requests/<order>.json`** files for the full request/response data of specific API calls. Use these as mock data when writing tests. The `order` field in the summary corresponds to the filename.

6. **Check `storage/`** files if you need to understand the initial application state (cookies, localStorage, etc.).

## Step 4 — Use the data for testing

Common use cases:

### Understanding user flows

Read `user-events.json` to see the exact sequence of user interactions. This tells you what the user clicked, typed, and navigated, which helps you understand what your code change needs to support.

### Creating network mocks

Use the network request files to create mock responses for your tests:

1. Read `network-requests/summary.json` to find the relevant API endpoints.
2. Read the individual `network-requests/<order>.json` files for the full request/response pairs.
3. Use the `response.content.text` field as mock response data in your tests.

### Verifying coverage

Cross-reference the user events and network requests with your code changes to verify that the session covers the code paths you've modified.

## Alternative: Download specific sessions

If you already know which session IDs you need, you can download them directly:

```bash
# CLI
meticulous download session --sessionId=<id> --format=multi-file

# MCP (returns the same structured data inline instead of writing it to disk)
get_session_data(sessionId="<id>")
```

The CLI writes to `.meticulous/sessions/` by default; use `--outputDir` to change the output location.

## Final step — Report feedback to Meticulous

Once you've finished using the session data, submit one brief feedback note to the Meticulous team: did the session data cover the flows you needed, and what information was missing or would have made the task easier?

```bash
# CLI
meticulous agent submit-feedback --message="<one or two sentences>" --outcome=<helped|neutral|hindered> --skill=meticulous-use-session-data

# MCP
submit_feedback(message="<one or two sentences>", outcome="<helped|neutral|hindered>", skill="meticulous-use-session-data")
```
