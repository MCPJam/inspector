# Worked example: kanban-demo, inline rename + keyboard card move

A complete run of the skill against a small app, including one target that gained coverage and one that recorded fine and then failed to replay. Use it to calibrate what "well-traced" looks like, and what a partial result looks like when you report it honestly.

App: a Kanban board (`kanban-demo`), ~11 source files.

## Step 0-1 — Baseline

`meticulous auth get-project` came back as an unrelated project — the CLI's selection drifts, so check it every time. After setting it correctly, `test-run-for-commit` gave the baseline run id (keep it; Step 7 needs it).

Baseline: the `--summary` headline, then the least-covered files:

```bash
meticulous agent js-coverage --summary
meticulous agent js-coverage --orderBy=coveragePercentage --order=asc \
  --includeCoveragePercentage --limit=10
```

```
src/components/Card.tsx           78.3   <- lowest
src/components/Board.tsx          81.4   <- second lowest
src/components/Column.tsx         95.1
src/lib/utils.ts                  96.7
src/components/CommandPalette.tsx 97.4
src/components/CardModal.tsx      99.5
src/components/Toasts.tsx        100.0
...
```

## Step 2 — Picking targets

**There were no 0% files at all.** A skill that only hunts zeros would have reported "nothing to do" on a codebase with two files a fifth uncovered. The targets are simply the lowest percentages.

## Step 3 — Tracing

Percentages don't say _what_ is uncovered — get the executed ranges and read the gaps:

```bash
meticulous agent js-coverage --globFilter "src/components/Card.tsx"
# executedRanges: 5-45;56-64;68-71;76-104;124-166
```

Gaps at 45-55, 65-67, 72-75, 105-123. Reading those lines showed they are not scattered edge cases but two coherent features:

| Feature            | Uncovered code                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Inline rename      | `Card.tsx` 45-54 (`commitTitle`), 64-67 (`onDoubleClick`), 105-123 (the rename `<input>`) |
| Keyboard card move | `Card.tsx` 72-75 (alt+arrow branch), `Board.tsx` 127-153 (`onKeyboardMove`)               |

Both lowest-coverage files shared the second feature — so one interaction was expected to move both. That is the pattern to look for: group by feature, not by file.

## Steps 4-6 — Driving

Two attempts, because the first one taught something.

**Attempt 1 (`agent-browser`).** Double-click the card title, type, Enter; then focus a card and press Alt+ArrowRight. Everything worked live — title changed, "renamed" toast, card moved. 13 events recorded.

Coverage afterwards was _worse_ than baseline. `get_session_data` showed why: only **one** pointerdown/pointerup pair was recorded for the double-click. On replay that is a single click, the rename input never opens, and the recorded typing and Enter then target an element that does not exist — so the replay diverges and covers less than the golden set did.

**Attempt 2 (Playwright).** Same flow, but the double-click sent two full press/release pairs and `press('Alt+ArrowRight')` recorded a discrete Alt keydown. 17 events.

## Step 7 — Comparing

```bash
meticulous agent js-coverage --summary --headPlusTestRunIds "<newRunId>"
meticulous agent js-coverage --headPlusTestRunIds "<newRunId>" \
  --globFilter "src/components/Board.tsx" --globFilter "src/components/Card.tsx" \
  --includeCoveragePercentage
```

| File                       | Before | After    |
| -------------------------- | ------ | -------- |
| `src/components/Board.tsx` | 81.4   | **92.1** |
| `src/components/Card.tsx`  | 78.3   | **80.7** |

The union's summary was above the Step 1 headline, which is the first thing to check. A union summary _below_ the headline isn't a regression: it means the run you unioned into wasn't the golden-set baseline.

## Step 8 — What actually moved, and what didn't

Compare executed ranges, not just percentages:

- `Board.tsx` gained 127-153 — `onKeyboardMove` ran. **The alt+arrow modifier survived replay**, because Playwright recorded the discrete Alt press.
- `Card.tsx` gained 72-75, the alt+arrow branch, and nothing else.
- `Card.tsx` 45-54 and 105-123 are **still uncovered**: the rename never replayed even with two real press/release pairs. The feature is only reachable via double-click, so there is no alternative path to drive.

Reported honestly: keyboard card move is now covered end to end; inline rename records but does not replay, and is the open item. Don't let a headline "+10.7% on Board.tsx" imply the whole flow landed.

Note also that the coverage gain only becomes the project's own number once a session-selection cycle picks these sessions into the selected set.

## Step 9 — `.meticulousignore`

Nothing proposed. Every file in this repo executes in the browser, and the one `n/a` file (`src/lib/types.ts`) is types-only and already outside the report. An empty ignore-list PR is a legitimate outcome — better than inventing rules to look productive.
