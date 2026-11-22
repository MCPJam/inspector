---
name: flake-hunt
description: Find the tests that fail MCPJam CI and then pass when the same commit runs again, pick the worst one, reproduce it locally and fix its cause. Use when CI needs manual reruns, when someone asks which tests are flaky, or before fixing a test reported as flaky.
---

# Flake hunt

A flaky test is one that failed a CI job and then passed on a later try of
the same commit. `.github/scripts/flake-hunt.mjs` measures them from GitHub
Actions history; this skill turns its top entry into a root-cause fix.

## 1. Run the report

```bash
gh api rate_limit --jq .resources.core      # the 5,000/hour limit is shared
node .github/scripts/flake-hunt.mjs --cache <dir on a disk with room>
```

| Option              | Default                         | Meaning                                         |
| ------------------- | ------------------------------- | ----------------------------------------------- |
| `--days N`          | `14`                            | window, in UTC days back from today             |
| `--workflow <file>` | `test.yml`                      | repeatable; `lint.yml` covers Build and Test    |
| `--cache <dir>`     | `<tmpdir>/mcpjam-flake-hunt`    | logs and job lists; a second run is cheap       |
| `--max-calls N`     | `1000`                          | stops before spending more; the report says so  |
| `--top N`, `--json` | `20`, off                       | length and format of the output                 |

A cold 14-day run of `test.yml` costs a few hundred calls; a warm rerun costs
the last two days' run lists. Keep `--max-calls` well under what
`rate_limit` reports, since other agents use the same token.

Each entry is a test, a Vitest unhandled error (ranked under the test file it
came from), a Playwright failure, or a job whose log named no test (ranked
under its job name and first `##[error]`). Counts are flaked jobs, and each
entry links example job logs.

## 2. Choose the flake

Take the highest count that is a real test or unhandled error. Before you
start, check that nobody is already on it: `gh pr list --search "<file name>"`
and read the diff of any open PR that touches it. Check the test still exists:
`git log -S"<test name>" --oneline` shows the commit that removed it if a
recent change deleted it, and the window can still count its old failures.
Read two or three of the
example logs: the same assertion failing each time points at one race;
different assertions point at shared state or an unhandled error from another
test in the same worker.

A "failed to load" or "does not provide an export named" error can come from
another test file in the same shard. Look at which files finish next to the
failing one in the CI log, and at child processes that write shared generated
files: `writeFileSync` empties a file before writing it, so a reader can load an
empty module.

## 3. Reproduce it

Vitest 4 has no repeat flag, so loop the single file. Inspector example:

```bash
pass=0; fail=0
for i in $(seq 1 30); do
  if npm run test -w @mcpjam/inspector -- client/src/path/to/file.test.tsx > run-$i.log 2>&1
  then pass=$((pass+1)); else fail=$((fail+1)); fi
done
echo "pass=$pass fail=$fail"
```

`npm run test -w @mcpjam/inspector` also runs the workspace's script tests;
for a faster loop run `npx vitest run <file>` from `mcpjam-inspector/`.
Read each exit code directly, never through a pipe.

If it never fails alone, add the load CI has: run it beside its shard
(`-- --shard=N/6`, with N from the job name), or run two or three copies of
the loop at once, or both. Record the failure rate before you change code.

When the race is on a file, a tight read loop beside the suspected writer
measures the window directly (count empty or partial reads per thousand) and is
much cheaper than looping the test.

On a shared machine, parallel loops sometimes stall together and every loop
times out in the same iteration. Count those separately from real failures, and
run a control batch on the old code before you attribute them to a change.

A failure you cannot reproduce is not fixed by a guess. Write down what you
tried and stop.

## 4. Fix the cause

Find what the test races against: a timer or animation frame that outlives
the test, a click before the element is enabled, module-level state shared
between tests, an unawaited promise that resolves after teardown, a
`setTimeout` in app code that fires after the environment is gone.

Do not add `retry`, a longer timeout, a sleep, or `.skip`. Each hides the race
and leaves it for the next PR.

If the race is in application code (for example a timer a component never
clears on unmount), fix it there when the fix is clearly safe, and say in the
PR that it was app code. Otherwise report it with the evidence.

## 5. Prove the fix

Run the same loop, under the same load, with at least as many iterations as
it took to reproduce the failure, and more than 30 for a rare one. Report the
loop count and failure count before and after. Then run the checks in
`preflight-ci`.
