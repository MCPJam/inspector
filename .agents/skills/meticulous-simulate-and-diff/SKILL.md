---
name: meticulous-simulate-and-diff
description: Run a Meticulous session simulation against a live URL and analyze the visual output — either by inspecting screenshots directly (quick-check mode) or by comparing pixel and HTML diffs against a base replay. Use when checking whether a code change has introduced visual regressions for a specific session.
user-invocable: true
---

# Simulate a session and analyze diffs

This skill covers running a single simulation and interpreting the results. For the `simulate` command's full option reference see the `meticulous-cli` skill's [`simulate` reference](../meticulous-cli/references/simulate.md).

> Before starting, run the `meticulous-cli-update` skill to ensure the Meticulous CLI and skills are up to date — unless it has already run earlier in this conversation, in which case skip it.

## Prerequisites

- A `sessionId` to replay
- An `appUrl` (local dev server, or leave blank to use the original recorded URL)
- Optionally: a `baseReplayId` — the ID of a prior replay to diff screenshots against. Without this, screenshots are stored but not compared.

If you don't have a `baseReplayId`, you can find one from a downloaded test run:

```bash
meticulous download test-run
# Then inspect ~/.meticulous/test-runs/<testRunId>/coverage.json
# or check the testCases[].replayId fields
```

## Step 1 — Run the simulation

### With a base replay (diff mode)

```bash
meticulous simulate \
  --sessionId=<sessionId> \
  --appUrl=<url> \
  --baseReplayId=<baseReplayId> \
  --headless
```

Capture the full stdout. Key things to look for:

```
# Per-screenshot diff outcomes (one line each):
0.412% pixel mismatch for screenshot screenshot-1234.png (threshold is 0.100%) => FAIL!
0.000% pixel mismatch for screenshot screenshot-5678.png (threshold is 0.100%) => PASS

# Final summary block:
=======
View simulation at: https://app.meticulous.ai/projects/<org>/<project>/simulations/<headReplayId>
View comparison with base: https://app.meticulous.ai/projects/<org>/<project>/simulations/<baseReplayId>/compare-to/<headReplayId>
=======
```

**If there are no `FAIL!` lines:** the session is visually identical to the base — report no regressions, then proceed to Step 6.

Proceed to Steps 2–6 to locate and analyse any diffs, then submit feedback.

### Without a base replay (quick-check mode)

If no `baseReplayId` is available, omit it. Screenshots are still stored locally for direct visual inspection:

```bash
meticulous simulate \
  --sessionId=<sessionId> \
  --appUrl=<url> \
  --headless
```

Then locate the replay directory (Step 2) and open the screenshots in `<replayDir>/screenshots/` to verify the UI looks correct. There are no diff images in this mode — inspection is purely visual. Steps 3–5 do not apply; still complete Step 6 after inspection.

## Step 2 — Extract the head replay ID and locate the replay directory

From the `View simulation at:` URL, extract the `<headReplayId>` (the last path segment).

To find the local replay directory created by this run:

```bash
ls -lt ~/.meticulous/replays/ | head -5
```

The most recently created entry will be the head replay's directory (named with a timestamp, e.g. `2024-01-15T12-30-45.123Z-abc123/`). Note this path — it's referred to below as `<replayDir>`.

## Step 3 — Identify which screenshots diffed

```bash
ls ~/.meticulous/replays/<replayDir>/diffs/<baseReplayId>/
```

Each `.png` file here corresponds to a screenshot where a visual difference was detected. The pixel diff image highlights changed pixels in color. There are also `thumb_` prefixed thumbnail versions.

Note the filenames — they match the screenshot identifiers (e.g. `screenshot-after-event-42.png`).

## Step 4 — Analyze the HTML diff for each diffed screenshot

Each screenshot has a corresponding metadata file containing a full HTML snapshot of the page taken just before the screenshot was captured. These files are already on disk:

- **Head metadata:** `~/.meticulous/replays/<replayDir>/screenshots/<screenshotFilename>.metadata.json`
- **Base metadata:** `~/.meticulous/replays/<baseReplayId>/screenshots/<screenshotFilename>.metadata.json`

The base metadata is permanently cached when the simulation downloads the base replay, so no additional download is needed.

Read both `.metadata.json` files. The relevant fields are:

- `before.dom` — full HTML of the page at screenshot time; diff these two strings to understand what changed
- `before.routeData.url` — which page/route the screenshot was taken on

When diffing the HTML, focus on tag additions/removals, `class` attribute changes, and text content changes.

The per-screenshot stdout lines also report `mismatchFraction` (proportion of pixels that changed). If there is a pixel diff but the `before.dom` strings are identical, the change is purely visual (e.g. a color shift) rather than structural.

## Step 5 — Summarize the findings

The key output from this skill is a **high-level human-readable description of what visually changed and why**. Use the pixel diff counts, route URLs, changed class names, and HTML diffs gathered above to answer: _what did the user experience change, and which part of the UI is responsible?_

Present this in whatever format fits the current context (conversational answer, structured report, input to a calling workflow, etc.). Useful signals to draw on:

- Which routes were affected
- Which CSS classes appeared in the changed DOM regions (these usually map directly to components)
- Whether changes were structural (DOM additions/removals) or purely visual (pixel shift with no HTML diff)
- Whether the same change appears across multiple screenshots (suggesting a shared component changed) vs. isolated to one screenshot

The comparison URL logged to stdout is always worth surfacing, as it lets a human quickly verify the diff visually:
`https://app.meticulous.ai/.../simulations/<baseReplayId>/compare-to/<headReplayId>`

## Notes

- The pixel diff images at `~/.meticulous/replays/<replayDir>/diffs/<baseReplayId>/` can be opened directly for visual inspection.
- If `--baseReplayId` is omitted, no diff analysis is possible. Screenshots are still stored locally and can be compared later by re-running with `--baseReplayId` set to the head replay ID from the first run.
- For the full iterative development workflow (session discovery, per-step commits, and final cloud run), see the `meticulous-iterative-dev` skill.

## Step 6 — Report feedback to Meticulous

As the last step, after summarizing the findings, submit one brief feedback note to the Meticulous team: did the simulation and diffs help you verify the change, was anything confusing, and what information would have made the task easier?

```bash
# CLI
meticulous agent submit-feedback --message="<one or two sentences>" --outcome=<helped|neutral|hindered> --skill=meticulous-simulate-and-diff

# MCP
submit_feedback(message="<one or two sentences>", outcome="<helped|neutral|hindered>", skill="meticulous-simulate-and-diff")
```
