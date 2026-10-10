# meticulous simulate

```bash
meticulous simulate --sessionId=<id> [options]
# alias:
meticulous replay   --sessionId=<id> [options]
```

**Purpose:** Replay a recorded session in a Chromium browser. Stubs network requests using recorded responses, then optionally takes screenshots and diffs them against a base replay. The primary command for local debugging and manual replay testing.

## Replay Target

Exactly one of these determines what URL the session is replayed against:

| Option                                              | Description                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| _(none)_                                            | Replay against the original URL the session was recorded on                                    |
| `--appUrl=<url>`                                    | Replay against a specific URL (e.g., `http://localhost:3000`)                                  |
| `--appUrl=uploaded-assets://<deploymentUploadId>`   | Replay against previously uploaded static assets                                               |
| `--appUrl=uploaded-container://<containerUploadId>` | Replay against a previously uploaded Docker container                                          |
| `--simulationIdForAssets=<id>`                      | Replay against assets snapshotted from a prior simulation (mutually exclusive with `--appUrl`) |

## Core Options

| Option                    | Type   | Required | Default | Description                                                                    |
| ------------------------- | ------ | -------- | ------- | ------------------------------------------------------------------------------ |
| `--sessionId`             | string | **yes**  | —       | ID of the session to replay                                                    |
| `--apiToken`              | string | no       | —       | Meticulous API token; otherwise use the default auth chain (see `auth whoami`) |
| `--commitSha`             | string | no       | —       | Git commit SHA to associate with this replay                                   |
| `--appUrl`                | string | no       | —       | URL to replay against (see Replay Target above)                                |
| `--simulationIdForAssets` | string | no       | —       | Use snapshotted assets from this prior simulation (conflicts with `--appUrl`)  |

## Screenshot Options

| Option                                  | Type    | Default | Description                                                                                |
| --------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------ |
| `--takeSnapshots` / `--screenshot`      | boolean | `true`  | Take a visual snapshot at the end of the replay                                            |
| `--storyboard`                          | boolean | `false` | Also take screenshots throughout the replay (requires `--takeSnapshots`)                   |
| `--baseReplayId` / `--baseSimulationId` | string  | —       | Replay ID to diff screenshots against; if omitted, screenshots are stored but not compared |
| `--diffThreshold`                       | number  | `0`     | Max proportion of changed pixels (0–1) before a diff is flagged                            |
| `--diffPixelThreshold`                  | number  | `0.1`   | Per-pixel color difference tolerance (0–1)                                                 |

## Step-Through Debugger

```bash
meticulous simulate --sessionId=<id> --appUrl=<url> --debugger
meticulous simulate --sessionId=<id> --appUrl=<url> --debugger --startAtEvent=95
```

| Option           | Type    | Default | Description                                                                                                                       |
| ---------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--debugger`     | boolean | `false` | Open an interactive step-through debugger that advances the replay event by event                                                 |
| `--startAtEvent` | number  | —       | Auto-advance to this event index when the debugger opens (requires `--debugger`). E.g., `--startAtEvent=95` jumps to "Event #95". |

**Constraints:**

- `--debugger` cannot be combined with `--headless`
- `--startAtEvent` requires `--debugger`
- `--storyboard` requires `--takeSnapshots`

## Browser Execution Options

| Option                             | Type    | Default | Description                                                                                       |
| ---------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------- |
| `--headless`                       | boolean | `false` | Run browser in headless mode                                                                      |
| `--devTools`                       | boolean | `false` | Open Chrome DevTools                                                                              |
| `--bypassCSP`                      | boolean | `false` | Bypass Content Security Policy                                                                    |
| `--shiftTime`                      | boolean | —       | Shift the browser clock to the recording time                                                     |
| `--networkStubbing`                | boolean | `true`  | Stub network requests with recorded responses                                                     |
| `--skipPauses`                     | boolean | `false` | Fast-forward through delays in the recording                                                      |
| `--moveBeforeMouseEvent`           | boolean | —       | Simulate mouse movement before each click/hover event                                             |
| `--disableRemoteFonts`             | boolean | `false` | Block remote font loads                                                                           |
| `--noSandbox`                      | boolean | `false` | Pass `--no-sandbox` to Chromium                                                                   |
| `--maxDurationMs`                  | number  | none    | Abort replay after N milliseconds                                                                 |
| `--maxEventCount`                  | number  | none    | Abort replay after N events                                                                       |
| `--essentialFeaturesOnly`          | boolean | `false` | Disable non-essential features (e.g., video recording) to reduce noise when debugging             |
| `--enableCssCoverage`              | boolean | `false` | Collect CSS coverage during the replay                                                            |
| `--cookiesFile`                    | string  | —       | Path to a cookies JSON file to inject before replay starts                                        |
| `--sessionIdForApplicationStorage` | string  | —       | Seed application state (cookies, localStorage, sessionStorage) from this session's recorded state |

## Network Debugging Options

These options enable verbose logging of network activity during replay, useful for diagnosing request-matching or stubbing issues:

| Option                                  | Type     | Description                                                             |
| --------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `--networkDebuggingRequestRegexes`      | string[] | Log requests whose URLs match any of these regexes                      |
| `--networkDebuggingTransformationFns`   | string[] | Log specific request transformations (logs all if omitted)              |
| `--networkDebuggingRequestTypes`        | string[] | Filter by request type: `original-recorded-request`, `request-to-match` |
| `--networkDebuggingWebsocketUrlRegexes` | string[] | Log WebSocket connections whose URLs match any of these regexes         |

## Examples

```bash
# Basic replay against local dev server
meticulous simulate --sessionId=abc123 --appUrl=http://localhost:3000

# Replay with screenshot diff against a known-good base
meticulous simulate \
  --sessionId=abc123 \
  --appUrl=http://localhost:3000 \
  --baseReplayId=rpl_good \
  --takeSnapshots

# Step through event-by-event starting at event 42
meticulous simulate \
  --sessionId=abc123 \
  --appUrl=http://localhost:3000 \
  --debugger \
  --startAtEvent=42

# Debug network stubbing for requests to /api/users
meticulous simulate \
  --sessionId=abc123 \
  --appUrl=http://localhost:3000 \
  --networkDebuggingRequestRegexes='/api/users'
```
