---
name: sweep-triage
description: Run the inspector driver's sweep over every app surface and triage what it reports into bugs, expected noise and environment problems. Use after a change to shared chrome (sidebar, routing, layout, auth), before a release check, or when someone hands you sweep output to explain.
---

# Sweep and triage

The driver and its commands are described in the `run-inspector` skill
(`.agents/skills/run-inspector/SKILL.md`). This skill covers what to do with
a sweep's output.

## Run the sweep

From the repo root, with an instance started by `start` (or `--base-url` and
`--token` for one you started yourself):

```bash
node mcpjam-inspector/scripts/inspector-driver.mjs sweep
node mcpjam-inspector/scripts/inspector-driver.mjs sweep --only playground,tasks
node mcpjam-inspector/scripts/inspector-driver.mjs sweep --skip xaa-flow
```

Each surface in `mcpjam-inspector/shared/app-surfaces.ts` gets one line:
`ok` or `FAIL`, the surface id, where it landed, counts, and the first
issue. The last line is `SWEEP ok=N fail=N out=<dir>`. Exit code 1 means at
least one surface failed; 2 means the driver itself could not run.

The sweep line shows only the first issue. Every issue for a surface is in
`<out>/<surface>.json` under `classified.issues`, next to its screenshot and
`.aria.yml`. To see one surface's full ISSUE lines, run
`node mcpjam-inspector/scripts/inspector-driver.mjs open <surface>`.

## Group by cause

Many surfaces can fail for one reason. Collect every ISSUE line, then group
the lines that share a cause: the same request path, the same console
message, or the same component on several surfaces. Triage each cause once,
not each line.

## Decide each cause

Find the code that issues the request or logs the message, and the condition
under which it runs. Then put the cause in one of three groups.

- **Environment problem.** Every surface shows `no-app-shell`, or there is an
  `http-429` on `/api/web/guest-session`, or a JWKS `kid` error in the
  console: guest sign-in is failing. Follow "When guest sign-in fails" in
  `run-inspector` and stop re-running once you see rate limiting. The
  authority limits guest mints by network. One driver run mints once and
  replays that guest to every later page, but a failed mint is not replayed,
  so every page of a failing run asks again, and each new driver run or
  manual reload outside the driver mints a fresh guest. If later surfaces fail with
  navigation errors after earlier ones passed, run
  `node mcpjam-inspector/scripts/inspector-driver.mjs status`; `NOT running`
  means the instance died, and its log path is printed. Fix the environment
  and sweep again before you triage anything else.
- **Bug.** The app makes a request it knows cannot succeed in this mode, or
  fails to handle an error it could handle without a console or network
  error. Write a steps file that reproduces it, and confirm it fails on the
  unfixed code ("Fixing a UI bug: reproduce first" in `run-inspector`). Fix
  it on its own branch with a test for the behaviour, and open a fix PR.
- **Expected noise.** The response is the designed outcome for this actor and
  setup, and the app already handles it. Add one rule to
  `mcpjam-inspector/scripts/inspector-driver.allowlist.json` with `kind`,
  `match` and a `reason` that says why the response is expected. A rule
  matches on kind and the one-line text, not on surface, so make `match` an
  anchored regex over the exact method, path and error, write the app's own
  host as `{origin}` so the same path elsewhere still fails, and use a
  specific kind (`http-400`, `request-failed`) instead of `*`. Add
  `"actor": "guest"` when only a guest gets the response, and
  `"replaced": true` when a request is cancelled and the page fetches it
  again: the rule then holds only when the same request later succeeded.
  A sweep's clean count means clean after these rules. Then run
  `node --test mcpjam-inspector/scripts/__tests__/inspector-driver.test.mjs`,
  which checks that the shipped allowlist parses and every rule has a reason.

An error that the current change introduced is never allowlisted, even if it
looks harmless. Compare with a sweep on `main`: an ISSUE line that is absent
there belongs to the change.

When the code alone cannot decide, say so, and name the observation that
would: a status code, a response body, or a request in the report JSON.

## Record

For each cause, record:

- the surfaces it affects;
- the ISSUE line exactly as the driver printed it;
- the verdict: bug, expected noise, or environment problem;
- the evidence: file and line of the code that issues the request, the
  server code that answers it, and why it fails for this actor;
- what was done: the fix branch and test, or the allowlist rule.

Mark anything inferred from code that was not seen in a running app.
