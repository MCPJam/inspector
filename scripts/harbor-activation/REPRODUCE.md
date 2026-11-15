# Exact study commands

The run inventory and command events are linked from the draft PR. Commands below
reproduce the final v1.3 matrix with new work directories, rather than resuming
native sessions from the original evidence. Prerequisites: Node 24.22.1,
Python 3.12+, uv, Docker/Compose, and provider authentication.

Run from the source branch's repository root:

```sh
HARBOR_ACTIVATION_WORK=$(mktemp -d)
uv venv "$HARBOR_ACTIVATION_WORK/venv" --python 3.12
uv pip install --python "$HARBOR_ACTIVATION_WORK/venv/bin/python" harbor==0.26.0
git worktree add --detach "$HARBOR_ACTIVATION_WORK/baseline-src" c8c4d47141ee0374ca83ae89a8356414026cd5ab
git worktree add --detach "$HARBOR_ACTIVATION_WORK/cycle1-src" 2b6c6470308870ec5784dfc2d25c70c0402b42ce
mkdir -p "$HARBOR_ACTIVATION_WORK/packages/baseline" "$HARBOR_ACTIVATION_WORK/packages/patched" "$HARBOR_ACTIVATION_WORK/packages/patched-cycle2"
(
  cd "$HARBOR_ACTIVATION_WORK/baseline-src"
  npm install --legacy-peer-deps --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --include-workspace-root
  npm run build:packages
  npm pack --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --pack-destination "$HARBOR_ACTIVATION_WORK/packages/baseline" --ignore-scripts
)
(
  cd "$HARBOR_ACTIVATION_WORK/cycle1-src"
  npm install --legacy-peer-deps --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --include-workspace-root
  npm run build:packages
  npm pack --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --pack-destination "$HARBOR_ACTIVATION_WORK/packages/patched" --ignore-scripts
)
npm install --legacy-peer-deps --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --include-workspace-root
npm run build:packages
npm pack --workspace @mcpjam/cli --workspace @mcpjam/sdk --workspace @mcpjam/evaluators --pack-destination "$HARBOR_ACTIVATION_WORK/packages/patched-cycle2" --ignore-scripts
docker build -t mcpjam-harbor-agent:v1 scripts/harbor-activation
python3 -m unittest discover -s scripts/harbor-activation/fixtures -p 'test_*.py' -v
python3 -m unittest discover -s scripts/harbor-activation -p test_prepare.py -v
python3 -m unittest discover -s scripts/harbor-activation/tests -v
python3 scripts/harbor-activation/prepare.py --out "$HARBOR_ACTIVATION_WORK/tasks/nop-credits" --packages "$HARBOR_ACTIVATION_WORK/packages/baseline" --scenario credits --prompt D
python3 - "$HARBOR_ACTIVATION_WORK" <<'PY'
import json, pathlib, sys
work = pathlib.Path(sys.argv[1]).resolve()
config = {'job_name': 'nop-credits', 'jobs_dir': str(work / 'jobs'),
          'n_attempts': 1, 'n_concurrent_trials': 1, 'retry': {'max_retries': 0},
          'agents': [{'name': 'nop'}], 'tasks': [{'path': str(work / 'tasks/nop-credits')}]}
(work / 'nop.json').write_text(json.dumps(config))
PY
"$HARBOR_ACTIVATION_WORK/venv/bin/harbor" run --config "$HARBOR_ACTIVATION_WORK/nop.json"
```

Before provider trials, confirm both nop steps have `reward.txt` and
`metrics.json`, no verifier exception, and complete evidence. Zero nop reward
is expected. Do not include the nop job in fresh-user success denominators.

For macOS native subscriptions, the following commands reuse only provider
credentials. Otherwise omit `--native-login` and provide the supported provider
environment variables described in [README.md](README.md). Do not put secret
values on command lines. Each command is one job with at most two active trials.
Run at most two jobs concurrently to preserve the study's global cap of four.

```sh
python3 scripts/harbor-activation/run.py --phase baseline --packages "$HARBOR_ACTIVATION_WORK/packages/baseline" --work "$HARBOR_ACTIVATION_WORK" --harbor "$HARBOR_ACTIVATION_WORK/venv/bin/harbor" --native-login --scenarios healthy credits --attempts 3 --name baseline-priority-v13
python3 scripts/harbor-activation/run.py --phase patched --packages "$HARBOR_ACTIVATION_WORK/packages/patched" --work "$HARBOR_ACTIVATION_WORK" --harbor "$HARBOR_ACTIVATION_WORK/venv/bin/harbor" --native-login --scenarios healthy credits --attempts 3 --name patched-priority-v13
python3 scripts/harbor-activation/run.py --phase baseline --packages "$HARBOR_ACTIVATION_WORK/packages/baseline" --work "$HARBOR_ACTIVATION_WORK" --harbor "$HARBOR_ACTIVATION_WORK/venv/bin/harbor" --native-login --scenarios auth --name baseline-auth-v13
python3 scripts/harbor-activation/run.py --phase patched --packages "$HARBOR_ACTIVATION_WORK/packages/patched" --work "$HARBOR_ACTIVATION_WORK" --harbor "$HARBOR_ACTIVATION_WORK/venv/bin/harbor" --native-login --scenarios auth --name patched-auth-v13
python3 scripts/harbor-activation/run.py --phase patched --packages "$HARBOR_ACTIVATION_WORK/packages/patched-cycle2" --work "$HARBOR_ACTIVATION_WORK" --harbor "$HARBOR_ACTIVATION_WORK/venv/bin/harbor" --native-login --scenarios auth --name patched-cycle2-auth-v13
python3 scripts/harbor-activation/run.py --phase patched --packages "$HARBOR_ACTIVATION_WORK/packages/patched-cycle2" --work "$HARBOR_ACTIVATION_WORK" --harbor "$HARBOR_ACTIVATION_WORK/venv/bin/harbor" --native-login --scenarios discovery --name heldout-discovery-v13
python3 scripts/harbor-activation/report.py --jobs "$HARBOR_ACTIVATION_WORK/jobs" --out "$HARBOR_ACTIVATION_WORK/evidence" --job baseline-priority-v13 --job patched-priority-v13 --job baseline-auth-v13 --job patched-auth-v13 --job patched-cycle2-auth-v13 --job heldout-discovery-v13 --targeted-job patched-cycle2-auth-v13 --heldout-job heldout-discovery-v13 --compare-baseline-job baseline-priority-v13 --compare-baseline-job baseline-auth-v13 --compare-patched-job patched-priority-v13 --compare-patched-job patched-auth-v13 --gallery
```

The original macOS run also supplied a task-local `DOCKER_CONFIG` containing
Compose/Buildx and `DOCKER_HOST` pointing to its Colima socket. Those machine
paths are not needed with a normally configured Docker installation.

The held-out A prompt is intentionally excluded from the B/C/D comparison:
being instructed to run an Eval is not natural Eval discovery. All trials use
seed42; repetitions vary fresh agent behavior, not the fixture dataset.

Cycle one is commit `2b6c647` (three CLI guidance fixes). Cycle two adds the
GET/405 conformance correction at `a6e25a8`; its two auth retests and two held-out
discovery trials are supplemental. Do not pool them into the primary comparison.
The original study also retained two provider-blocked Claude auth attempts and
ran fresh, separately named replacements after native login refresh. A fresh
reproduction need not manufacture expired provider credentials.

Before publication, provide `report.py --redact-file` with a private JSON list
of local account identifiers, inspect its allowlisted outputs, and publish only
`publication-manifest.json` paths. Do not upload raw Harbor jobs or native
session directories. Existing run exports refuse replacement by default.
