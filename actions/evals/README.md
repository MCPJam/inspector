# MCPJam evals action

Run an existing hosted eval suite or an SDK eval command, publish a detailed job
summary, and save reports as a GitHub Actions artifact. On pull requests it can
also post the client/model and failed-case tables as one updated comment.

This action supports GitHub.com and Ubuntu runners. Hosted mode tests a suite's
saved server. Command mode runs the repository's own SDK eval command against
whatever server its workflow started.

## Setup

1. Create an API key in MCPJam Settings → API keys.
2. In your GitHub repository, open Settings → Secrets and variables → Actions.
   Add a repository secret named `MCPJAM_API_KEY` containing the key.
3. Copy [mcpjam.yml](./mcpjam.yml) to `.github/workflows/mcpjam.yml` in your repo.
   Replace the project and suite placeholders. Names and IDs are both supported.

The workflow references the secret; never paste the key into YAML. No checkout or
Node setup step is required when using the published action.

```yaml
- uses: MCPJam/inspector/actions/evals@evals-v1
  with:
    # Add the real API key to GitHub Actions secrets, not this file.
    api-key: ${{ secrets.MCPJAM_API_KEY }}
    project: "My project"
    suite: "My eval suite"
```

### SDK eval command and PR comment

Use `command` after checking out the repository, installing its dependencies,
and starting any server the evals need. The command must use an MCPJam SDK version
that supports action receipts. The action links each uploaded run directly; it
never searches for the latest run.

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - run: npm ci
  - run: npm run build
  - name: Start the MCP server
    run: npm run serve &
  - uses: MCPJam/inspector/actions/evals@evals-v1
    with:
      api-key: ${{ secrets.MCPJAM_API_KEY }}
      command: npm run eval:smoke
      comment: true
```

The checks summary contains the complete report. The PR comment contains only
the client/model result table, the failed-case matrix, and MCPJam run links.
Failure reasons are copied from stored results in the full summary; the action
does not infer them. A missing comment permission warns without changing the eval
verdict.

**Behind an identity proxy:** a deployment fronted by Cloudflare Access needs a
service token to answer the API at all. Set `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` in the step's `env:`; the action sends them with its
MCPJam reads and with nothing else. Both are required — one alone is ignored.

**Release status:** `evals-v1` is published by the `Release` workflow (see
[Tests and release](#tests-and-release)). Check whether it exists yet:

```sh
git ls-remote --tags https://github.com/MCPJam/inspector 'evals-v*'
```

While that prints nothing the action has never been released, so the examples
above cannot resolve. Test with a checkout and `uses: ./actions/evals`, as the
live smoke workflow does.

## Optional gates

```yaml
- uses: MCPJam/inspector/actions/evals@evals-v1
  with:
    api-key: ${{ secrets.MCPJAM_API_KEY }}
    project: "My project"
    suite: "My eval suite"
    gate: true
    min-pass-rate-percent: 95
    # Optional: a commit SHA already stored on a completed baseline run.
    # baseline-sha: '0123456789abcdef0123456789abcdef01234567'
```

Without gates, only run exit code `0` passes. With gates, each completed run's
gate must return `0` (passed or waived), and every launched run must have complete
results and reports. Gate success can clear a measured eval failure; it cannot
clear a failed launch, missing result, or reporting error. Existing suite policies
remain enabled: a run waiver does not override a separate suite-policy failure.

Waiver details remain in the CLI's JUnit report, including skipped cases. An
expired waiver or an unresolved baseline remains blocking according to the CLI's
gate result. The action delegates these rules to the CLI rather than calculating
its own thresholds or deciding whether a waiver is active.

## Inputs

| Input                   | Default     | Meaning                                                                      |
| ----------------------- | ----------- | ---------------------------------------------------------------------------- |
| `api-key`               | Required    | API key from GitHub Actions secrets.                                         |
| `project`               | Hosted mode | Existing project name or ID.                                                 |
| `suite`                 | Hosted mode | Existing hosted suite name or ID.                                            |
| `command`               | None        | SDK eval command; replaces `project` and `suite`.                             |
| `comment`               | `false`     | Create or update the PR result comment.                                      |
| `github-token`          | Workflow token | Optional token override for PR comments.                                  |
| `gate`                  | `false`     | Let `eval gate` decide the result.                                           |
| `min-pass-rate-percent` | CLI default | Gate threshold, 0–100; requires `gate: true`.                                |
| `baseline-run`          | None        | Baseline run ID; requires gates.                                             |
| `baseline-sha`          | None        | Stored baseline commit SHA; requires gates. Cannot accompany `baseline-run`. |
| `wait-timeout-ms`       | CLI default | Positive integer; applied to run and gate waits.                             |
| `cli-version`           | `5.7.1`     | Exact published version, not `latest` or a URL.                              |
| `idempotency-key`       | Derived     | Optional stable retry key, at most 256 characters.                           |

### Targeting a non-production deployment

Set `MCPJAM_BASE_URL` (or the CLI's `MCPJAM_API_URL`) on the step to point both
modes at one deployment; the action reduces either to its origin, hands it to
the eval command as `MCPJAM_BASE_URL`, and refuses a run receipt that names any
other origin rather than sending it the API key. It defaults to
`https://app.mcpjam.com`.

The CLI's default wait is 10 minutes, with its existing grading extension when
no explicit limit is supplied. The example workflow sets a 60-minute job limit.
Large suites or several targets may need a longer GitHub job timeout.

There are no automatic retries. The default retry key includes repository,
workflow run, job, matrix cell, action invocation, project and suite, but excludes
the workflow attempt. Re-running the same job therefore reuses the paid run.
Starting a new workflow run produces a new key. A custom key is useful if you
need to preserve identity across changes to the workflow's step layout.

## Reports and outputs

The action saves JSON and Markdown eval reports, one `gate-N.xml` per attempted
hosted gate when enabled, and `action-result.json`. The checks summary always
ends with the action's own verdict, its message and the exit codes, after the
rendered report; the rendered report is trimmed if it would otherwise push the
summary past the size GitHub accepts. It uploads them before the
final failure step,
using a unique artifact name per invocation. Reports use the CLI's redaction, with
an additional literal API-key scrub. Raw CLI stdout and stderr are not uploaded.

| Output            | Format                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `run-ids`         | JSON array, including runs that launched but did not finish.      |
| `run-exit-code`   | Original CLI exit code; empty if the CLI could not start.         |
| `gate-exit-codes` | JSON object mapping each attempted run ID to its gate exit code.  |
| `report-path`     | Local report directory; empty if it could not be safely prepared. |
| `artifact-url`    | GitHub URL returned by the successful artifact upload.            |

Run exit codes: `0` passed, `1` measured eval failure, `2` usage, `3` auth,
`4` setup/connection/report write, `5` no valid verdict. Gate codes retain their
separate contract: `0` passed/waived, `1` failed, `2` usage, `3` incomplete.
GitHub displays success or failure; the outputs retain the more precise codes.
An upload failure also fails the action, even if evaluation passed. Cancellation
or a runner shutdown can prevent report upload.

## Tests and release

Run the tests without installing workspace dependencies:

```sh
node --test actions/evals/*.test.mjs
```

The `Evals action tests` workflow runs these checks on action changes.

### How the tags are published

`Release` publishes the action. It compares this folder against whatever
`evals-v1` points at, ignoring `README.md`, and when they differ it runs
`Evals action live smoke` against the release commit. Only if that smoke passes
does it create the next immutable `evals-v1.X.Y` and force-move `evals-v1` to
the same commit. The smoke verifies the pinned CLI is published, runs the helper
tests, executes the local action and uploads real reports — it spends eval
credits, which is why a release that did not touch the folder skips both jobs.

The action has no changeset of its own, so it rides along with the next package
release that includes the change. Re-running a release after a successful one is
a no-op: the folder now matches `evals-v1`.

Set these once, in the repository's settings:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `MCPJAM_API_KEY` | Key the smoke runs its evals with |
| Variable | `EVALS_SMOKE_PROJECT` | An existing MCPJam project |
| Variable | `EVALS_SMOKE_SUITE` | An existing hosted suite in it |

`Evals action live smoke` can still be dispatched by hand — do that to exercise
both `gate` settings before the first release.

### Releasing out of band

`check-release.mjs` guards a tag pushed by hand, and only recognises a manually
dispatched smoke run:

```sh
node actions/evals/check-release.mjs <successful-smoke-run-id> <full-commit-sha>
```

It rejects a `Release` run, because there the smoke is a job of the release
itself rather than its own run — a stronger guarantee than this after-the-fact
check, since the tag cannot be pushed unless that job passed. These tags are
separate from Inspector's application releases.
