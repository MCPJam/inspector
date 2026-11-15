"""Materialize immutable Harbor tasks without putting fixture code in the tester."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent


def prepare(destination, packages, scenario, prompt, seed):
    destination.mkdir(parents=True, exist_ok=False)
    environment = destination / 'environment'
    environment.mkdir()
    shutil.copytree(ROOT / 'fixtures', destination / 'private-fixture', ignore=shutil.ignore_patterns('__pycache__'))
    tests = destination / 'tests'
    shutil.copytree(ROOT / 'verifier', tests, ignore=shutil.ignore_patterns('__pycache__'))
    (tests / 'prompt.txt').write_text(prompt + '\n')
    # A separate verifier image is self-contained: Harbor skips test uploads
    # for both explicit images and tests/Dockerfile definitions.
    (tests / 'Dockerfile').write_text('FROM mcpjam-harbor-agent:v1\nRUN rm /bin/bash && mv /bin/bash.real /bin/bash\nCOPY . /tests\nRUN chmod +x /tests/test.sh\n')
    templates = json.loads((ROOT / 'prompts.json').read_text())
    instruction = templates[prompt].format(endpoint='http://fixture:8765/mcp', entry_point='https://docs.mcpjam.com')
    instruction += '\n\n' + templates['concern']
    instruction += '\n\nTrial context: public documentation entry point https://docs.mcpjam.com; MCP server http://fixture:8765/mcp. MCPJam account API is configured in MCPJAM_API_URL and MCPJAM_API_KEY. Project: project_fixture. Account: team owner. This isolated account uses synthetic credits; do not contact production billing or buy anything. Save reproducible work under /workspace. Budget: 240 seconds, at most 40 shell commands. Use only public documentation and normal product interfaces; do not read product source, test fixtures, or verifier internals.\n'
    if scenario == 'auth':
        instruction += 'The server credential is available in MCP_SERVER_TOKEN. Your existing configuration is /workspace/mcp.json.\n'
    (destination / 'instruction.md').write_text(instruction)
    (environment / 'Dockerfile').write_text('FROM mcpjam-harbor-agent:v1\nRUN printf "@mcpjam:registry=http://fixture:8765/registry/\\n" > /usr/local/etc/npmrc\n')
    compose = {'services': {'main': {'environment': {
        'MCPJAM_API_URL': 'http://fixture:8765/api/v1', 'MCPJAM_API_KEY': 'sk_fixture_synthetic',
        'MCP_SERVER_TOKEN': 'fixture-server-token', 'XDG_CONFIG_HOME': '/root/.config',
        'XDG_CACHE_HOME': '/root/.cache'}, 'depends_on': {'fixture': {'condition': 'service_healthy'}}},
        'fixture': {'image': 'mcpjam-harbor-agent:v1', 'working_dir': '/fixture',
                    'entrypoint': ['python3', '/fixture/service.py'],
                    'command': ['--state', '/private/state.json', '--scenario', scenario, '--seed', str(seed), '--port', '8765', '--public-url', 'http://fixture:8765'],
                    'volumes': [f'{destination.resolve() / "private-fixture"}:/fixture:ro', f'{packages.resolve()}:/packages:ro'],
                    'healthcheck': {'test': ['CMD', 'curl', '-fsS', 'http://localhost:8765/health'], 'interval': '1s', 'timeout': '2s', 'retries': 20}}}}
    # JSON is valid YAML; avoids an extra generator dependency.
    (environment / 'docker-compose.yaml').write_text(json.dumps(compose, indent=2))
    (destination / 'task.toml').write_text('''schema_version = "1.4"
[task]
name = "mcpjam/''' + scenario + '''"
[metadata]
benchmark_version = "1.3.0"
fixture_seed = ''' + str(seed) + '''
simulation = true
[agent]
timeout_sec = 240
[environment]
build_timeout_sec = 180
cpus = 2
memory_mb = 2048
workdir = "/workspace"
[verifier]
timeout_sec = 60
environment_mode = "separate"
[[artifacts]]
source = "/private"
destination = "fixture"
service = "fixture"
[[artifacts]]
source = "/workspace"
destination = "workspace"
exclude = ["node_modules", ".npm", ".cache"]
[[artifacts]]
source = "/capture"
destination = "capture"
''')
    if scenario == 'auth':
        with (environment / 'Dockerfile').open('a') as f:
            f.write('RUN printf \'{"mcpServers":{"arithmetic":{"url":"http://fixture:8765/mcp"}}}\\n\' > /workspace/mcp.json\n')
    if scenario == 'credits':
        config = destination / 'task.toml'
        config.write_text(config.read_text().replace('schema_version = "1.4"', 'schema_version = "1.4"\nmulti_step_reward_strategy = "final"') + '''
[[steps]]
name = "blocked"
[[steps.verifier.collect]]
service = "fixture"
command = "python3 /fixture/control.py resolve --state /private/state.json"
[[steps]]
name = "resume"
''')
        for name, text in [('blocked', instruction), ('resume', 'The environment reports that the account issue has been resolved. Resume your original task using the work you preserved.\n\n' + templates['concern'])]:
            step = destination / 'steps' / name
            step.mkdir(parents=True)
            (step / 'instruction.md').write_text(text)
    manifest = {str(p.relative_to(destination)): hashlib.sha256(p.read_bytes()).hexdigest() for p in destination.rglob('*') if p.is_file()}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--packages', type=Path, required=True)
    p.add_argument('--scenario', choices=['healthy', 'auth', 'credits'], required=True)
    p.add_argument('--prompt', choices=['A', 'B', 'C', 'D'], required=True)
    p.add_argument('--seed', type=int, default=42)
    a = p.parse_args()
    prepare(a.out, a.packages, a.scenario, a.prompt, a.seed)
