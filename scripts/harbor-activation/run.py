"""Generate a bounded job using Harbor's built-in vendor integrations."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from prepare import prepare


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--phase', choices=['baseline', 'patched'], required=True)
    p.add_argument('--packages', type=Path, required=True)
    p.add_argument('--work', type=Path, required=True)
    p.add_argument('--harbor', default='harbor')
    p.add_argument('--agents', nargs='+', choices=['codex', 'claude-code'], default=['codex', 'claude-code'])
    p.add_argument('--scenarios', nargs='+', choices=['healthy', 'auth', 'credits', 'discovery'], default=['healthy', 'auth', 'credits'])
    p.add_argument('--attempts', type=int, choices=range(1, 4), default=1)
    p.add_argument('--native-login', action='store_true', help='Reuse only provider credentials, never preferences or history')
    p.add_argument('--name', required=True)
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args()
    a.work.mkdir(parents=True, exist_ok=True)
    task_root = a.work / 'tasks' / a.name
    tasks = []
    for scenario in a.scenarios:
        path = task_root / scenario
        prepare(path, a.packages, 'healthy' if scenario == 'discovery' else scenario,
                {'healthy': 'B', 'auth': 'C', 'credits': 'D', 'discovery': 'A'}[scenario], 42)
        tasks.append({'path': str(path.resolve())})
    agents = []
    for name in a.agents:
        kwargs = {'version': '0.160.0', 'reasoning_effort': 'medium', 'reasoning_summary': 'none'} if name == 'codex' else {
            'version': '2.1.323', 'max_turns': 30, 'max_budget_usd': '2', 'thinking_display': 'omitted'}
        agent = {'name': name, 'model_name': 'openai/gpt-6.1-sol' if name == 'codex' else 'anthropic/claude-sonnet-5-5',
                 'kwargs': kwargs, 'resume_trajectory': True}
        if a.native_login and name == 'codex':
            agent['env'] = {'CODEX_FORCE_AUTH_JSON': '1'}
        agents.append(agent)
    config = {'job_name': a.name, 'jobs_dir': str((a.work / 'jobs').resolve()),
              'n_attempts': a.attempts, 'n_concurrent_trials': 2, 'retry': {'max_retries': 0},
              'agents': agents, 'tasks': tasks}
    path = a.work / (a.name + '.json')
    path.write_text(json.dumps(config, indent=2) + '\n')
    if a.native_login and 'claude-code' in a.agents:
        # The exact native login item is read in memory; it never enters the job
        # configuration or arguments. API users can instead pass Harbor's env vars.
        native = subprocess.run(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'],
                                capture_output=True, text=True, check=True)
        token = json.loads(native.stdout).get('claudeAiOauth', {}).get('accessToken')
        if not token:
            raise SystemExit('No native Claude credential; use CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.')
        os.environ['CLAUDE_CODE_OAUTH_TOKEN'] = token
        os.environ['CLAUDE_FORCE_OAUTH'] = '1'
        del native, token
    command = [a.harbor, 'run', '--config', str(path)]
    if a.dry_run:
        command.append('--dry-run')
    # Capture the orchestrator command too. Full native transcripts remain in
    # the private work tree until report.py removes reasoning and credentials.
    import capture
    sys.argv = ['capture', '--id', a.name, '--out', str(a.work / 'orchestrator-events'),
                '--timeout', str(1800 * a.attempts), '--', *command]
    return capture.main()


if __name__ == '__main__':
    raise SystemExit(main())
