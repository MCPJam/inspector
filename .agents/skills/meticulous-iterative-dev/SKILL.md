---
name: meticulous-iterative-dev
description: Iterative frontend development loop using Meticulous for per-step visual validation. Use when implementing a multi-step frontend change and want to catch visual regressions and unintended side effects at each step, before the final cloud test run.
user-invocable: true
---

# Iterative Frontend Development with Meticulous

Use this skill when implementing a multi-step frontend change. After each step, run a quick local visual check using Meticulous to catch regressions and unintended side effects early. After all steps are complete, run a full cloud test run to validate across all recorded sessions.

> Before starting, run the `meticulous-cli-update` skill to ensure the Meticulous CLI and skills are up to date — unless it has already run earlier in this conversation, in which case skip it.

## Prerequisites

- Local dev server running (e.g. `npm run dev` or `pnpm dev`), serving the app at a known URL such as `http://localhost:3000`
- Authenticated with Meticulous: run `meticulous auth whoami` to log in via OAuth (an API token via `METICULOUS_API_TOKEN` or `~/.meticulous/config.json` also works)
- Meticulous CLI installed and on `PATH` (the `meticulous-cli-update` skill handles this)

---

## Per-step loop

Repeat the following for each step of your change.

### Step 1 — Implement the step's changes

Make your code changes for this step.

### Step 2 — Find relevant sessions

Run:

```bash
meticulous local relevant-sessions
```

If you have already committed previous steps and want to find sessions relevant only to this step's uncommitted changes, pass the SHA of the last commit:

```bash
meticulous local relevant-sessions --startingPointSha=<sha-of-last-commit>
```

For full option reference see the `meticulous-cli` skill's [`local` reference](../meticulous-cli/references/local.md). The key fields to extract from each session in the output:

- **Session ID** — pass as `--sessionId` when simulating
- **Base replay ID** — the replay of this session on the base branch; pass as `--baseReplayId` to diff against. May be absent if the session has never been replayed on the base branch.
- **Relevance** — `IsRelevant` / `IsRelevantBeta` means the session directly exercises changed code.

If no sessions are returned, the changed code is not covered by any recorded session. Proceed to Step 4 (commit) and rely on the final cloud run for coverage.

### Step 3 — Simulate and analyse

Pick 1–2 of the most relevant sessions (prefer `IsRelevant` over `IsRelevantBeta`). For each, follow the `meticulous-simulate-and-diff` skill using:

- `--sessionId` and `--baseReplayId` from step 2's output
- `--appUrl=http://localhost:<port>` pointing at your local dev server
- `--headless` (required — agents should not operate a visible browser)

If `baseReplayId` was absent from the output, omit it; use quick-check mode from that skill instead.

Also consider simulating a session for an unexpected flow surfaced by `local relevant-sessions` — one that covers code you didn't intend to change — to check for unintended side effects.

Once you have the analysis, classify each visual difference:

- **Expected** — a direct, intended consequence of this step's changes. Proceed.
- **Unexpected** — a visual change that was not a goal of this step (including side effects of your code, even if explainable). Investigate.

**If unexpected and the cause is clear:** fix the code and re-simulate.

**If the cause is unclear:** create a self-contained AI-readable debug workspace using the replay IDs from the simulation output URL (see debug.md):

```bash
meticulous debug replay <headReplayId> --baseReplayId=<baseReplayId>
```

Both IDs come from the simulation output URL: the head replay ID is the last path segment of the `View simulation at:` URL; the base replay ID is the `--baseReplayId` used in the simulate command. Open the workspace to diagnose, fix, and re-simulate.

### Step 4 — Commit

Once the step's visual output is correct, commit your changes:

```bash
git add -p
git commit -m "<concise description of this step>"
```

Committing after each step means the next iteration's `--startingPointSha` call computes the diff relative to this checkpoint, preventing prior steps' changes from inflating the set of relevant sessions.

Return to Step 1 for the next step.

---

## After all steps — full cloud test run

Once all steps are complete and committed, run a full cloud test run to validate across all recorded sessions (not just the 1–2 you simulated locally):

> Follow the `meticulous-test` skill.

The cloud run compares your branch against the base branch across the full golden set of sessions and reports any visual regressions.

---

## Final step — Report feedback to Meticulous

After the cloud test run completes (the `meticulous-test`/`meticulous-review` skills end with their own feedback step covering the run itself), submit one brief feedback note about the iterative loop: did per-step simulation catch regressions early, and what would have made the workflow easier?

```bash
# CLI
meticulous agent submit-feedback --message="<one or two sentences>" --outcome=<helped|neutral|hindered> --skill=meticulous-iterative-dev

# MCP
submit_feedback(message="<one or two sentences>", outcome="<helped|neutral|hindered>", skill="meticulous-iterative-dev")
```
