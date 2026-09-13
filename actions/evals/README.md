# MCPJam evals action

Run an existing hosted eval suite, wait for its result, and save reports as a
GitHub Actions artifact. Optional gates can apply thresholds, compare a baseline,
and honor existing run waivers. The action does not create waivers.

This action supports GitHub.com and Ubuntu runners. It tests the suite's saved
server; it does **not** build or deploy the code in a pull request. Use MCPJam's
GitHub App integration for builds from PR source.

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

**Release status:** `evals-v1` becomes usable only after the release procedure
below succeeds and the tag is published. Until then, test with a checkout and
`uses: ./actions/evals`, as the live smoke workflow does.

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
| `project`               | Required    | Existing project name or ID.                                                 |
| `suite`                 | Required    | Existing hosted suite name or ID.                                            |
| `gate`                  | `false`     | Let `eval gate` decide the result.                                           |
| `min-pass-rate-percent` | CLI default | Gate threshold, 0–100; requires `gate: true`.                                |
| `baseline-run`          | None        | Baseline run ID; requires gates.                                             |
| `baseline-sha`          | None        | Stored baseline commit SHA; requires gates. Cannot accompany `baseline-run`. |
| `wait-timeout-ms`       | CLI default | Positive integer; applied to run and gate waits.                             |
| `cli-version`           | `5.7.1`     | Exact published version, not `latest` or a URL.                              |
| `idempotency-key`       | Derived     | Optional stable retry key, at most 256 characters.                           |

The CLI's default wait is 10 minutes, with its existing grading extension when
no explicit limit is supplied. The example workflow sets a 60-minute job limit.
Large suites or several targets may need a longer GitHub job timeout.

There are no automatic retries. The default retry key includes repository,
workflow run, job, matrix cell, action invocation, project and suite, but excludes
the workflow attempt. Re-running the same job therefore reuses the paid run.
Starting a new workflow run produces a new key. A custom key is useful if you
need to preserve identity across changes to the workflow's step layout.

## Reports and outputs

The action saves `eval-report.json`, one `gate-N.xml` per attempted gate when
enabled, and `action-result.json`. It uploads them before the final failure step,
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

The `Evals action tests` workflow runs these checks on action changes. Before
releasing, run `Evals action live smoke` manually against the candidate commit,
supplying an existing project and suite and setting `MCPJAM_API_KEY` in the repo's
Actions secrets. This spends eval credits. Test both gate settings before the
first release. The smoke workflow verifies the pinned CLI is published, runs
the helper tests, executes the local action, and uploads real reports.

Publish only a commit with a successful live smoke run. The release guard checks
the run's repository, workflow, event, conclusion and exact commit:

```sh
node actions/evals/check-release.mjs <successful-smoke-run-id> <full-commit-sha>
```

After that check passes, maintainers can tag that exact commit `evals-v1.0.0`
and create the moving `evals-v1` tag pointing at it. For later releases, repeat the
smoke check for the new commit, create a new immutable version tag, then update
`evals-v1`. These tags are separate from Inspector's application releases. Do not
publish a tag or describe the action as released before the live check passes.
