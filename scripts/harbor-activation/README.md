# First-use Harbor evaluation

This suite observes Claude Code and Codex CLI as first-time MCPJam users. It is
an activation study, not a live billing certification or a human-user prevalence
estimate. The Figma [activation and billing board](https://www.figma.com/board/CXX0rzePjHb6yBP1nVzoI6/Activation---Billing-%E2%80%94-Brainstorm)
supplies hypotheses. Kestral task: [KES-903](https://app.kestral.ai/workspace/yhNILB2/task/1ZGSn6st).

## Boundaries

- **Orchestrator:** materializes tasks, runs Harbor, changes private synthetic
  account state between credit steps, collects evidence, and grades.
- **Tester:** Harbor's built-in `claude-code` or `codex` integration in a fresh
  Docker container. It receives a goal, public documentation entry point, fixture
  endpoint, and appropriate account credentials. It never sees the source
  checkout, other transcripts, hidden tests, or the private fixture filesystem.
- **Coding agent:** separate context reads evidence/source and edits the product.
  It never serves as a tester. Baseline npm archives are preserved before edits.

The agent image caches Node and vendor CLI dependencies. Each trial starts new
HOME/config/auth/configuration caches/history/workspace and a new fixture ledger.
Only the provider credential is reused; no host preferences, skills, plugins,
memory, or history are copied. Harbor explicitly stages credentials, removes its
Codex secret files, and destroys trial containers afterward.

The fixture serves MCP Streamable HTTP and a subset of the current MCPJam API.
Its npm registry serves the exact built package archives under test. Ordinary
third-party dependencies and public docs are fetched normally. The synthetic
account never calls Stripe, Convex, hosted inference, or production billing.
Eval execution is deterministic arithmetic; prompt/model execution is explicitly
unsupported. One synthetic unit is a fixture counter, **not an MCPJam price**.

## Reproduce

See [REPRODUCE.md](REPRODUCE.md) for the complete baseline/patched matrix,
including the no-agent preflight and held-out discovery run.

Run from the repository root with Node 24.22.1, Python 3.12+, Docker and Docker
Compose. Harbor's official [agent integrations](https://docs.harborframework.com/agents/pre-integrated-agents),
[task format](https://docs.harborframework.com/tasks/overview), and installed
`harbor run --help` / `harbor agent schema` were checked before the trial commands.
Harbor 0.26.0, Codex 0.160.0, and Claude Code 2.1.323 are pinned.

```sh
HARBOR_ACTIVATION_WORK=$(mktemp -d)
uv venv "$HARBOR_ACTIVATION_WORK/venv" --python 3.12
uv pip install --python "$HARBOR_ACTIVATION_WORK/venv/bin/python" harbor==0.26.0
npm install --legacy-peer-deps --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --include-workspace-root
npm run build:packages
mkdir -p "$HARBOR_ACTIVATION_WORK/packages"
npm pack --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --pack-destination "$HARBOR_ACTIVATION_WORK/packages" --ignore-scripts
docker build -t mcpjam-harbor-agent:v1 scripts/harbor-activation
python3 scripts/harbor-activation/run.py --phase baseline \
  --packages "$HARBOR_ACTIVATION_WORK/packages" --work "$HARBOR_ACTIVATION_WORK" \
  --harbor "$HARBOR_ACTIVATION_WORK/venv/bin/harbor" --native-login \
  --name baseline-six
python3 scripts/harbor-activation/report.py \
  --jobs "$HARBOR_ACTIVATION_WORK/jobs" --out "$HARBOR_ACTIVATION_WORK/evidence" \
  --job baseline-six
```

`--native-login` uses the existing macOS Claude Keychain credential only in
process memory and Harbor's supported `CODEX_FORCE_AUTH_JSON` flow. On other
systems omit it and supply `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` via your normal secret environment. Never pass tokens as flags
or commit them. API-key runs can incur provider costs; the study used existing
subscriptions. MCPJam synthetic credits are entirely separate.

For an exact baseline, build the archives in a separate checkout of
`c8c4d47141ee0374ca83ae89a8356414026cd5ab`. Build patched archives in another
directory, then rerun with `--phase patched --packages <patched-dir>` and a new
job name. Do not overwrite a baseline archive or materialized task. To repeat
priority cases use `--scenarios healthy credits --attempts 3`; for unguided
discovery use `--scenarios discovery`. Prompt A never counts as directed Eval
discovery. Prompt B explicitly requests an Eval.

## Bounds and independent checks

Each phase has a 240-second hard agent timeout; credits have a blocked phase
and a resumed phase in the same native session. Every trial starts fresh. Job
concurrency is two per job (four globally when baseline and patched jobs overlap),
orchestration retries zero, and repetitions are capped at
three per invocation. Claude has 30 turns and a $2 reported-cost limit per phase.
Codex has no supported native max-turn flag in the checked integration: its
40-shell-command prompt bound is advisory; wall time is the enforced bound.
There is no claimed hard Codex token/dollar cap. With subscription credentials
there are no purchases or pay-as-you-go charges, but quota is consumed.

The verifier runs in its own container after the tester stops. Harbor collects
private fixture state from the sidecar, plus captured commands and user work.
Successful MCPJam calls must correlate with private tool execution and returned
values. Directed activation also requires a completed simulated Eval and a
reproducible artifact. Recovery requires a refusal followed by verified success;
credit recovery must occur after the private account change. Correct owner
handoff is reported separately and never promoted to completed recovery.
Missing evidence or verifier failures cannot pass. Unmeasured semantic metrics
remain null; the model's success statement is not the verifier.

## Evidence and retention

`shell_capture.py` is installed before tester commands. It records invocations,
working directories, an environment allowlist, both streams including empties,
read-ordered chunks, times, and exit status. Native CLI event logs capture public
notes and tool responses. Shell subprocess nesting produces multiple capture
events; public agent tool invocation counts are reported separately.

Noninteractive trials use pipes; no PTY fidelity is claimed. Compound-command
child exits and output discarded by the shell are not separately observable.
Redirected output is collected from saved work where available. Interrupted
captures retain missing exit metadata rather than inventing a result.
Screenshots are paginated SVG renderings of captured text, prominently labeled
as rendered evidence. Private reasoning and credential stores are excluded.
Every observed event remains indexed, including failure and empty output.

Raw jobs stay in the private work directory and must not be committed. Publish
only `report.py` output after privacy review. Baseline reports contain SHA-256
manifests and refuse replacement by default. Retain the sanitized, versioned
evidence branch for the PR lifetime; raw local jobs can be removed after review.
There is no automatic deletion of the user's unrelated state. The capture
inventory is finite; it does not claim exhaustive possible product output.

## Local harness checks

```sh
python3 -m unittest discover -s scripts/harbor-activation/tests -v
python3 -m unittest discover -s scripts/harbor-activation/fixtures -p 'test_*.py' -v
python3 -m unittest discover -s scripts/harbor-activation -p 'test_prepare.py' -v
```

The no-agent two-step preflight must produce `reward.txt` and metrics in both
steps before funded trials. A zero reward from `nop` is expected. Benchmark
corrections are versioned; v1.0/v1.1 smoke runs remain harness-invalid and are
excluded from valid product denominators. See the PR's results and evidence
index for observed sample sizes, fixes, failures, and untested branches.

v1.2 is also preliminary: a tester's negative control found that the fixture
misread `responseContains.needle` and falsely passed a wrong expectation.
v1.3 validates the supported predicate subset before charging, keeps response
assertions separate from tool results, and rejects unsupported fields. Its
negative controls must pass before provider trials. Comparable baseline and
patched trials use v1.3; older runs remain indexed, never silently discarded.

The frozen v1.3 reward is deliberately reported separately from broader task
completion. It requires direct CLI tool-call evidence and CLI Eval launch;
successful public-API Evals and Eval-as-first-value can therefore receive zero.
A tester who supplies the available credential before any refusal validates
authentication but does not exercise recovery. Preserve these outcomes and
report ledger-confirmed completion alongside rewards. Changing these criteria
requires a new benchmark version and comparable reruns.
