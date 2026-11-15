#!/usr/bin/env python3
"""Publish captured evidence, never agent reasoning or authentication stores.

Only shell captures, public CLI event projections and explicit result/metric
files enter the bundle. Native session directories are deliberately excluded.
"""
import argparse
import hashlib
import html
import json
import re
import shutil
from pathlib import Path

PRIVATE_TYPES = {'thinking', 'redacted_thinking', 'reasoning', 'analysis'}
PRIVATE_KEYS = {'thinking', 'analysis', 'reasoning', 'encrypted_content', 'signature'}
PRIVATE_VALUES = []
SECRET_ASSIGNMENT = re.compile(r'''(?i)\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|KEY|SECRET|PASSWORD)(?:_[A-Z0-9_]*)?=)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'<>]+))''')
SECRET_KEY = re.compile(r'^(?:(?:.*[_-])?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|password|secret)|clientSecret|authorization|orgId|organizationId|accountId|userId)$', re.I)
PATTERNS = [
    (SECRET_ASSIGNMENT, r'\1[REDACTED]'),
    (re.compile(r'\bsk[-_][A-Za-z0-9_-]{8,}\b'), '[REDACTED]'),
    (re.compile(r'\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b'), '[REDACTED]'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b'), '[REDACTED]'),
    (re.compile(r'(?i)\bBearer\s+(?!\$)[A-Za-z0-9._~+/=-]{8,}'), 'Bearer [REDACTED]'),
    (re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}'), '[EMAIL REDACTED]'),
    (re.compile(r'/(?:Users|home)/[^/\s"\\]+'), '$USER_HOME'),
    (re.compile(r'(?i)([?&](?:token|key|secret|code|signature|credential|access_token)=)[^\s&"\\]+'), '[SENSITIVE QUERY REDACTED]'),
    (re.compile(r'(?i)(?:https?://)[^/\s:@]+:[^@\s]+@'), 'https://[CREDENTIALS REDACTED]@'),
    (re.compile(r'(?i)(?:fixture-server-token|sk_fixture_synthetic)'), '[SYNTHETIC CREDENTIAL REDACTED]'),
    (re.compile(r'(?is)<thinking>.*?(?:</thinking>|\Z)'), '[PRIVATE REASONING REMOVED]'),
    (re.compile(r'(?i)("(?:(?:[\w-]+[_-])?(?:token|secret|api[_-]?key)|accessToken|refreshToken|idToken|apiKey|password|clientSecret|authorization|orgId|organizationId|accountId|userId)"\s*:\s*)"[^"\n]*"'), '"sensitive_value": "[REDACTED]"'),
]
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def redact(text):
    for pattern, replacement in PATTERNS:
        text = pattern.sub(replacement, text)
    for value in PRIVATE_VALUES:
        text = re.sub(re.escape(value), '[PRIVATE IDENTIFIER REDACTED]', text, flags=re.I)
    return text


def public_object(value):
    if isinstance(value, list):
        return [public_object(v) for v in value if not (isinstance(v, dict) and v.get('type') in PRIVATE_TYPES)]
    if isinstance(value, dict):
        if value.get('type') in PRIVATE_TYPES:
            return {'type': 'private_reasoning_removed'}
        return {k: '[REDACTED]' if SECRET_KEY.match(k) and v else public_object(v)
                for k, v in value.items() if k not in PRIVATE_KEYS}
    if isinstance(value, str):
        # Tool-result text may itself be a serialized native CLI event.
        if value.lstrip().startswith('{') and '\n' in value:
            return apply_slice(value, 0, len(value), edits_for(value))
        return redact(value)
    return value


def edits_for(text):
    """Offsets allow secrets split across recording chunks to be removed safely."""
    edits = []
    for match in re.finditer(r'^.*(?:\n|\Z)', text, re.M):
        line = match.group().strip()
        if not line.startswith('{'):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and ('type' in event or any(SECRET_KEY.match(k) for k in event)):
            clean = json.dumps(public_object(event), ensure_ascii=False) + ('\n' if match.group().endswith('\n') else '')
            edits.append((match.start(), match.end(), clean))
    for pattern, replacement in PATTERNS:
        for match in pattern.finditer(text):
            if not any(a <= match.start() < b for a, b, _ in edits):
                edits.append((match.start(), match.end(), match.expand(replacement)))
    for value in PRIVATE_VALUES:
        for match in re.finditer(re.escape(value), text, re.I):
            if not any(a <= match.start() < b for a, b, _ in edits):
                edits.append((match.start(), match.end(), '[PRIVATE IDENTIFIER REDACTED]'))
    accepted = []
    for edit in sorted(edits, key=lambda e: (e[0], -e[1])):
        if not accepted or edit[0] >= accepted[-1][1]:
            accepted.append(edit)
    return accepted


def apply_slice(text, start, end, edits):
    parts, cursor = [], start
    for a, b, replacement in edits:
        if b <= start or a >= end:
            continue
        if cursor < a:
            parts.append(text[cursor:min(a, end)])
        if start <= a < end:
            parts.append(replacement)
        cursor = max(cursor, b)
    if cursor < end:
        parts.append(text[cursor:end])
    return ''.join(parts)


def sanitize_stream(events):
    texts = {name: ''.join(e.get('data', '') for e in events if e.get('stream') == name) for name in {'stdout', 'stderr'}}
    offsets = {name: 0 for name in texts}
    edits = {name: edits_for(text) for name, text in texts.items()}
    clean = []
    for event in events:
        name = event.get('stream')
        if name not in texts:
            clean.append(public_object(event))
            continue
        start, length = offsets[name], len(event.get('data', ''))
        copy = public_object({k: v for k, v in event.items() if k != 'data'})
        copy['data'] = apply_slice(texts[name], start, start + length, edits[name])
        offsets[name] += length
        clean.append(copy)
    return clean


def safe_terminal(text):
    text = ANSI.sub('', text).replace('\r', '\n')
    return ''.join(c if c in '\n\t' or ord(c) >= 32 else '�' for c in text)


def render(text, directory, stem, label):
    lines = []
    for line in safe_terminal(text).splitlines():
        lines.extend([line[i:i + 130] for i in range(0, len(line), 130)] or [''])
    pages = []
    for page, offset in enumerate(range(0, max(1, len(lines)), 65), 1):
        rows = lines[offset:offset + 65]
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="1220" height="{85 + len(rows) * 20}"><rect width="100%" height="100%" fill="#101820"/><g font-family="monospace" font-size="14" fill="#e8edf2">'
        svg += '<text x="20" y="25" fill="#86d9c4">Rendered evidence from captured output</text>'
        svg += f'<text x="20" y="47">{html.escape(label)} — page {page}</text>'
        svg += ''.join(f'<text x="20" y="{75 + i * 20}">{html.escape(line)}</text>' for i, line in enumerate(rows)) + '</g></svg>'
        target = directory / f'{stem}-{page:03}.svg'
        target.write_text(svg)
        pages.append(target.name)
    return pages


def load(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def publish_event(source, destination):
    destination.mkdir(parents=True)
    meta = public_object(load(source / 'event.json', {}))
    raw = []
    stream = source / 'stream.jsonl'
    if stream.exists():
        for line in stream.read_text(errors='replace').splitlines():
            if line.strip():
                try:
                    raw.append(json.loads(line))
                except ValueError:
                    meta['recording_parse_error'] = True
    clean = sanitize_stream(raw)
    for name in ['stdout', 'stderr']:
        path = source / f'{name}.txt'
        text = path.read_text(errors='replace') if path.exists() else ''
        (destination / f'{name}.txt').write_text(apply_slice(text, 0, len(text), edits_for(text)))
    (destination / 'stream.jsonl').write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in clean))
    (destination / 'event.json').write_text(json.dumps(meta, indent=2))
    ordered = ''.join(e.get('data', '') for e in clean)
    if not raw:
        ordered = (destination / 'stdout.txt').read_text() + (destination / 'stderr.txt').read_text()
    command = '$ ' + ' '.join(meta.get('argv', []))
    outcome = f'\n[exit={meta.get("exit_status", "unrecorded")}; signal={meta.get("signal")}; timeout={meta.get("timed_out", "unrecorded")}]'
    pages = render(command + '\n' + ordered + outcome, destination, 'outcome', meta.get('event_id', source.name))
    intermediates, seen = [], set()
    for e in clean:
        data = e.get('data', '')
        if re.search(r'(?i)error|warning|password|confirm|authorize|retry|prompt', data):
            digest = hashlib.sha256(data.encode()).hexdigest()
            if digest not in seen:
                seen.add(digest)
                intermediates += render(data, destination, f'intermediate-{len(seen):03}', f'Observed at +{e.get("seconds", "?")}s')
    return {'id': meta.get('event_id', source.name), 'path': destination.name, 'argv': meta.get('argv'),
            'start': meta.get('start'), 'end': meta.get('end'), 'exit_status': meta.get('exit_status'),
            'complete': 'exit_status' in meta and all((source / f).exists() for f in ['stdout.txt', 'stderr.txt', 'stream.jsonl']),
            'screenshots': pages, 'intermediate_screenshots': intermediates,
            'output_classes': sorted(set(re.findall(r'"(?:code|reason)"\s*:\s*"([A-Z][A-Z0-9_]+)"', ordered)))
            + (['empty_output'] if not ordered else [])
            + (['tool_error'] if re.search(r'"isError"\s*:\s*true', ordered) else [])}


def public_cli(path):
    events, notes = [], []
    if not path.exists():
        return events, notes
    for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
        try:
            event = json.loads(line)
        except ValueError:
            events.append({'source_line': number, 'unstructured_output': redact(line)})
            continue
        clean = public_object(event)
        public_line = len(events) + 1
        events.append({'source_line': number, 'event': clean})
        item = event.get('item', {})
        texts = [item.get('text', '')] if item.get('type') == 'agent_message' else []
        if event.get('type') == 'assistant':
            texts += [c.get('text', '') for c in event.get('message', {}).get('content', []) if c.get('type') == 'text']
        for text in texts:
            for paragraph in text.split('\n\n'):
                has_concern = re.search(r'(?i)\bconcern\b|\bconfus(?:ed|ing|ion)\b|\bexpected\b.*\b(?:observed|instead|but)\b', paragraph)
                no_concern = re.match(r'(?is)^\s*(?:\*\*)?no concerns?\b', paragraph)
                if has_concern and not no_concern:
                    notes.append({'source_line': number, 'public_line': public_line, 'text': redact(paragraph),
                                  'source_event_id': item.get('id') or event.get('uuid') or event.get('message', {}).get('id')})
    return events, notes


def classify(result, invalid):
    if invalid:
        return 'harness-invalid'
    exceptions = [(result.get('exception_info') or {}).get('exception_type', '')]
    exceptions += [(step.get('exception_info') or {}).get('exception_type', '') for step in result.get('step_results') or []]
    exceptions = [e for e in exceptions if e]
    provider = ['Auth', 'Credential', 'Provider', 'RateLimit']
    if any('AgentTimeout' not in e and not any(word in e for word in provider) for e in exceptions):
        return 'harness-invalid'
    if any('AgentTimeout' in e for e in exceptions):
        return 'timed-out'
    if exceptions:
        return 'provider-blocked'
    if result.get('reward_valid') is False:
        return 'harness-invalid'
    rewards = (result.get('verifier_result') or {}).get('rewards', {})
    if not rewards:
        return 'unscored'
    return 'passed' if all(float(v) > 0 for v in rewards.values()) else 'failed'


def phase_of(path):
    parts = path.parts
    return parts[parts.index('steps') + 1] if 'steps' in parts else 'trial'


def cli_sources(trial):
    paths = [p for p in trial.rglob('*') if p.name in ['codex.txt', 'claude-code.txt']
             and 'agent' in p.relative_to(trial).parts and 'artifacts' not in p.relative_to(trial).parts
             and 'sessions' not in p.relative_to(trial).parts]
    selected = {}
    # Harbor may retain a live agent log plus its phase snapshot. The phase
    # snapshot is authoritative; never count the same transcript twice.
    for path in sorted(paths, key=lambda p: (not p.relative_to(trial).parts[0] == 'steps', str(p))):
        selected.setdefault((phase_of(path.relative_to(trial)), path.name), path)
    has_phases = any(phase != 'trial' for phase, _ in selected)
    return [path for (phase, _), path in selected.items() if phase != 'trial' or not has_phases]


def output_facts(text):
    success = False
    for line in text.splitlines():
        try:
            value = json.loads(line)
            success |= isinstance(value, dict) and not value.get('isError', False) and isinstance(value.get('structuredContent', {}).get('sum'), (float, int))
        except (ValueError, AttributeError):
            continue
    return {'observed_output_sha256': hashlib.sha256(text.strip().encode()).hexdigest(), 'successful_sum_output': success}


def tool_invocations(events, phase):
    invocations = {}
    for public_line, record in enumerate(events, 1):
        event = record.get('event', {})
        item = event.get('item', {})
        kind = item.get('type')
        if kind in {'command_execution', 'mcp_tool_call', 'web_search', 'file_change'} and item.get('id'):
            key = (phase, 'codex', item['id'])
            invocation = invocations.setdefault(key, {'phase': phase, 'id': item['id'], 'type': kind, 'is_shell_command': kind == 'command_execution', 'public_line': public_line})
            invocation['command'] = item.get('command')
            if event.get('type') == 'item.completed':
                invocation.update(output_facts(item.get('aggregated_output', '')))
                invocation['result_public_line'] = public_line
        for content in event.get('message', {}).get('content', []) if isinstance(event.get('message', {}).get('content'), list) else []:
            if content.get('type') == 'tool_use' and content.get('id'):
                key = (phase, 'claude', content['id'])
                invocations[key] = {'phase': phase, 'id': content['id'], 'type': content.get('name'),
                                    'is_shell_command': content.get('name') == 'Bash', 'public_line': public_line,
                                    'command': (content.get('input') or {}).get('command')}
            elif content.get('type') == 'tool_result':
                invocation = invocations.get((phase, 'claude', content.get('tool_use_id')))
                if invocation is not None:
                    output = content.get('content', '')
                    if isinstance(output, list):
                        output = '\n'.join(c.get('text', '') for c in output if c.get('type') == 'text')
                    invocation.update(output_facts(output))
                    invocation['result_public_line'] = public_line
    return list(invocations.values())


def first_cli_result(invocations, events, target, metrics):
    verified = {event_id for entry in metrics for event_id in entry['metrics'].get('mcpjam_tool_event_ids', [])}
    hashes = {}
    for event in events:
        if event['id'] in verified:
            text = (target / event['path'] / 'stdout.txt').read_text()
            hashes.setdefault(hashlib.sha256(text.strip().encode()).hexdigest(), []).append(event['id'])
    for ordinal, invocation in enumerate((i for i in invocations if i['is_shell_command']), 1):
        digest = invocation.get('observed_output_sha256')
        if invocation.get('successful_sum_output') and 'tools call' in (invocation.get('command') or '') and digest in hashes:
            return {'commands_to_first_cli_tool_result': ordinal, 'invocation_id': invocation['id'], 'phase': invocation['phase'],
                    'source': invocation.get('source'), 'public_line': invocation['result_public_line'], 'corroborating_capture_ids': hashes[digest]}
    return {'commands_to_first_cli_tool_result': None, 'reason': 'No unique native shell output with successful structuredContent.sum exactly matched a verifier-confirmed capture.'}


def publish_artifacts(trial, target):
    inventory = []
    allowed = {'.json', '.jsonl', '.yaml', '.yml', '.md', '.sh', '.js', '.cjs', '.mjs', '.log', '.txt', '.toml'}
    forbidden = {'node_modules', '.npm', '.cache', '.codex', '.claude', 'sessions', '__pycache__', '.git'}
    for source in trial.rglob('*'):
        if not source.is_file() or 'artifacts' not in source.parts or forbidden.intersection(source.parts):
            continue
        relative = source.relative_to(trial)
        if 'workspace' not in relative.parts and 'fixture' not in relative.parts:
            continue
        if source.name in {'auth.json', '.credentials.json', '.env', '.npmrc'} or source.suffix not in allowed:
            inventory.append({'source': str(relative), 'published': False, 'reason': 'not a supported reviewable text artifact'})
            continue
        text = source.read_text(errors='replace')
        clean = apply_slice(text, 0, len(text), edits_for(text))
        destination = target / 'artifacts' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(clean)
        inventory.append({'source': str(relative), 'published': True, 'path': str(destination.relative_to(target)),
                          'sha256': hashlib.sha256(clean.encode()).hexdigest()})
    (target / 'artifact-inventory.json').write_text(json.dumps(inventory, indent=2))
    return inventory


def assessment_flags(metrics):
    flags = set()
    for entry in metrics:
        metric = entry['metrics']
        if metric.get('server_observed_simulated_eval') and not metric.get('first_eval_completed'):
            flags.add('simulated_eval_observed_but_strict_command_match_missing')
        if metric.get('prompt') == 'C' and metric.get('auth_refusal_count') == 0 and metric.get('server_observed_successful_tool_call'):
            flags.add('authentication_succeeded_without_exercising_refusal_recovery')
        if metric.get('prompt') == 'B' and metric.get('first_eval_completed') and not metric.get('first_meaningful_result'):
            flags.add('eval_completed_but_strict_first_tool_value_check_not_met')
    return sorted(flags)


def publish_trial(trial, out, invalid=False):
    observed_result = load(trial / 'result.json')
    result = observed_result or {}
    if not invalid and not result.get('finished_at'):
        return None
    run_id = trial.parent.name + '--' + trial.name
    target = out / run_id
    if target.exists():
        raise FileExistsError(f'Immutable run already exists: {target}')
    target.mkdir(parents=True)
    (target / 'result.json').write_text(json.dumps(public_object(observed_result), indent=2))
    collection = {'result_present': observed_result is not None, 'finished_at_observed': result.get('finished_at'),
                  'explicitly_harness_invalid': invalid, 'comparison_eligible': not invalid,
                  'missing_result_policy': 'Missing results, exit statuses and completion times remain null; observed partial output is retained.'}
    (target / 'collection.json').write_text(json.dumps(collection, indent=2))
    metrics = []
    for p in trial.rglob('metrics.json'):
        if 'node_modules' not in p.parts and ('verifier' in p.parts):
            metrics.append({'source': str(p.relative_to(trial)), 'metrics': public_object(load(p))})
    (target / 'metrics.json').write_text(json.dumps(metrics, indent=2))
    events, concerns, invocations, seen_notes = [], [], [], set()
    captures = [p.parent for p in trial.rglob('event.json') if 'capture' in p.parts and 'node_modules' not in p.parts]
    for i, source in enumerate(sorted(captures), 1):
        event = publish_event(source, target / 'commands' / f'{i:04}-{source.name}')
        event['path'] = 'commands/' + event['path']
        events.append(event)
    for path in cli_sources(trial):
        cli, notes = public_cli(path)
        phase = phase_of(path.relative_to(trial))
        phase_invocations = tool_invocations(cli, phase)
        name = 'public-' + '-'.join(path.relative_to(trial).parts) + '.jsonl'
        invocations += [{**invocation, 'source': name} for invocation in phase_invocations]
        (target / name).write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in cli))
        for note in notes:
            key = (phase, note['source_event_id'], note['text'])
            if key in seen_notes:
                continue
            seen_notes.add(key)
            concerns.append({'run_id': run_id, 'scenario_id': result.get('task_name'), 'step_id': phase,
                             'agent': (result.get('agent_info') or {}).get('name'), 'stage': None, 'concern': note['text'],
                             'expected': None, 'observed': None, 'missing_information': None, 'next_action': None,
                             'evidence_links': [name + '#L' + str(note['public_line'])], 'outcome': classify(result, invalid)})
    (target / 'concerns.jsonl').write_text(''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in concerns))
    (target / 'events.json').write_text(json.dumps(events, indent=2))
    (target / 'agent-tool-invocations.json').write_text(json.dumps(invocations, indent=2))
    artifacts = publish_artifacts(trial, target)
    summary = {'run_id': run_id, 'job': trial.parent.name, 'scenario': result.get('task_name'), 'agent': result.get('agent_info'),
               'outcome': classify(result, invalid), 'rewards': (result.get('verifier_result') or {}).get('rewards'),
               'usage': result.get('agent_result'), 'exception': public_object(result.get('exception_info')),
               'capture_event_count': len(events), 'unique_capture_event_count': len({e['id'] for e in events}),
               'agent_tool_invocation_count': len(invocations),
               'agent_shell_invocation_count': sum(i['is_shell_command'] for i in invocations),
               'incomplete_events': sum(not e['complete'] for e in events),
               'concern_count': len(concerns), 'metrics': metrics, 'assessment_flags': assessment_flags(metrics),
               'product_failure_attribution': None, 'collection': collection, 'comparison_eligible': not invalid,
               'first_cli_tool_result': first_cli_result(invocations, events, target, metrics),
               'native_command_count_scope': 'Unique agent Bash/command_execution invocations in phase order, including tester install commands; excludes Harbor startup and nested shells. Compound shell invocation counts once.'}
    if str(result.get('task_name', '')).endswith('/credits'):
        summary['collection_timing_note'] = ('Step artifacts are collected after the orchestrator account-resolution hook. '
            'A blocked-step snapshot may already contain account resolution applied after the agent stopped. '
            'Use refusal/request timestamps and captured output for temporal attribution, not snapshot presence alone.')
    (target / 'summary.json').write_text(json.dumps(summary, indent=2))
    # Human-readable verifier diagnostics are safe evidence; session stores,
    # arbitrary workspace files and auth-bearing native configuration are not.
    for source in trial.rglob('test-stdout.txt'):
        if 'verifier' in source.parts:
            name = '-'.join(source.relative_to(trial).parts)
            text = source.read_text(errors='replace')
            invocations += [{**invocation, 'source': name} for invocation in phase_invocations]
        (target / name).write_text(apply_slice(text, 0, len(text), edits_for(text)))
    lines = [f'# {run_id}', '', f'Outcome: **{summary["outcome"]}**. Concern notes: {len(concerns)}. Shell capture events: {len(events)}; actual agent shell invocations: {summary["agent_shell_invocation_count"]}.', '', '[Results](result.json) · [Metrics](metrics.json) · [Concerns](concerns.jsonl) · [Agent tool invocations](agent-tool-invocations.json)', '', 'Capture events include nested wrapper shells and are not a user-command denominator. Legacy verifier `command_count` is also a capture-event count.', '']
    lines += ['The outcome above reflects Harbor errors and the frozen strict reward. A zero reward alone does not establish a product failure.', '']
    if summary.get('collection_timing_note'):
        lines += [summary['collection_timing_note'], '']
    lines += [f'- Assessment flag: `{flag}`' for flag in summary['assessment_flags']]
    lines += ['']
    lines += ['## Public agent messages and tools', '', 'Private reasoning is omitted from these projections.', '']
    lines += [f'- [{path.name}]({path.name})' for path in sorted(target.glob('public-*.jsonl'))]
    lines += ['']
    lines += ['## Collected artifacts', '', '[Complete artifact inventory](artifact-inventory.json)', '']
    lines += [f'- [{a["source"]}]({a["path"]})' for a in artifacts if a['published']]
    lines += ['']
    for event in events:
        path = event['path']
        lines += [f'## {event["id"]}', '', f'Exit: `{event["exit_status"]}`. Complete: `{event["complete"]}`.', '',
                  f'[Metadata]({path}/event.json) · [stdout]({path}/stdout.txt) · [stderr]({path}/stderr.txt) · [ordered recording]({path}/stream.jsonl)', '']
        lines += [f'![Rendered captured evidence]({path}/{page})' for page in event['screenshots'] + event['intermediate_screenshots']]
        lines += ['']
    (target / 'index.md').write_text('\n'.join(lines))
    manifest = {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest() for p in target.rglob('*') if p.is_file()}
    (target / 'sha256.json').write_text(json.dumps(manifest, indent=2))
    return summary


def publish_bootstrap(sources, out, replace=False):
    target = out / 'preflight'
    if target.exists() and replace:
        shutil.rmtree(target)
    target.mkdir(exist_ok=True)
    events = []
    for source in sources:
        for path in sorted(source.glob('*/event.json')):
            event_path = target / (source.name + '--' + path.parent.name)
            if event_path.exists():
                events.append(load(event_path / 'published-event.json'))
                continue
            event = publish_event(path.parent, event_path)
            event['source_group'] = source.name
            event['id'] = source.name + ':' + event['id']
            (event_path / 'published-event.json').write_text(json.dumps(event, indent=2))
            events.append(event)
    events = [load(path) for path in sorted(target.glob('*/published-event.json'))]
    index = ['# Orchestrator preflight evidence', '', 'Setup observations are not fresh-user product trials.', '']
    for event in events:
        name = event['path']
        index += [f'## {event["id"]}', '', f'Exit `{event["exit_status"]}`; complete `{event["complete"]}`.', '',
                  f'[Metadata]({name}/event.json) · [stdout]({name}/stdout.txt) · [stderr]({name}/stderr.txt) · [recording]({name}/stream.jsonl)', '']
        index += [f'![Rendered preflight evidence]({name}/{page})' for page in event['screenshots'] + event['intermediate_screenshots']]
    (target / 'index.md').write_text('\n'.join(index) + '\n')
    (target / 'events.json').write_text(json.dumps(events, indent=2))


def publish_diagnostics(jobs, out, replace=False):
    summaries = []
    for result_path in sorted(jobs.glob('*/*/result.json')):
        result = load(result_path)
        if not result.get('finished_at') or (result.get('agent_info') or {}).get('name') != 'nop':
            continue
        trial = result_path.parent
        name = trial.parent.name + '--' + trial.name
        target = out / 'preflight' / 'diagnostics' / name
        if target.exists() and replace:
            shutil.rmtree(target)
        if not target.exists():
            target.mkdir(parents=True)
            (target / 'result.json').write_text(json.dumps(public_object(result), indent=2))
            metrics = [{'source': str(p.relative_to(trial)), 'metrics': public_object(load(p))}
                       for p in trial.rglob('metrics.json') if 'verifier' in p.parts]
            (target / 'metrics.json').write_text(json.dumps(metrics, indent=2))
        summaries.append({'diagnostic_id': name, 'role': 'harness_diagnostic', 'agent': 'nop',
                          'outcome': classify(result, False), 'result': 'diagnostics/' + name + '/result.json'})
    target = out / 'preflight'
    target.mkdir(exist_ok=True)
    (target / 'diagnostics.json').write_text(json.dumps(summaries, indent=2))
    index = target / 'index.md'
    text = index.read_text() if index.exists() else '# Orchestrator preflight evidence\n'
    text = text.split('\n## Non-agent diagnostic jobs\n')[0]
    text += '\n## Non-agent diagnostic jobs\n\nThese `nop` runs validate harness packaging; they are excluded from agent metrics.\n\n'
    text += '\n'.join(f'- [{s["diagnostic_id"]}]({s["result"]}): {s["outcome"]}' for s in summaries) + '\n'
    index.write_text(text)


def privacy_audit(paths, root):
    categories = {
        'private_identifiers': [re.compile(re.escape(v), re.I) for v in PRIVATE_VALUES],
        'jwt': [re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b')],
        'provider_token': [re.compile(r'\b(?:sk[-_]|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b')],
        'email': [re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}')],
        'native_reasoning_block': [re.compile(r'"type"\s*:\s*"(?:thinking|reasoning|analysis)"')],
    }
    counts = {category: 0 for category in categories}
    counts['secret_assignments'] = 0
    findings = []
    for path in paths:
        text = path.read_text(errors='replace')
        for category, patterns in categories.items():
            count = sum(len(pattern.findall(text)) for pattern in patterns)
            if count:
                counts[category] += count
                findings.append({'file': str(path.relative_to(root)), 'category': category, 'count': count})
        assignment_text = text
        if path.suffix in {'.json', '.jsonl'}:
            def strings(value):
                if isinstance(value, str):
                    return [value]
                if isinstance(value, dict):
                    return [part for item in value.values() for part in strings(item)]
                if isinstance(value, list):
                    return [part for item in value for part in strings(item)]
                return []
            try:
                values = [json.loads(line) for line in text.splitlines() if line.strip()] if path.suffix == '.jsonl' else [json.loads(text)]
                assignment_text = '\n'.join(strings(values))
            except ValueError:
                pass
        exposed = [match for match in SECRET_ASSIGNMENT.finditer(assignment_text)
                   if not next((v for v in match.groups()[1:] if v is not None), '').startswith(('[', '$'))]
        if exposed:
            counts['secret_assignments'] += len(exposed)
            findings.append({'file': str(path.relative_to(root)), 'category': 'secret_assignments', 'count': len(exposed)})
    return {'scanned_files': len(paths), 'matches_by_category': counts, 'findings': findings,
            'passed': not findings, 'scope': 'publication allowlist only; pattern audit, not a proof of absence of all sensitive data'}


def discover_secret_values(jobs, roots):
    """Use raw assignment values only in memory to mask unlabelled copies too."""
    paths = [p for p in jobs.rglob('stdout.txt') if 'capture' in p.parts]
    paths += [p for p in jobs.rglob('stderr.txt') if 'capture' in p.parts]
    paths += [p for root in roots for p in root.glob('*/*.txt')]
    secrets = set()
    # Only uppercase environment dump lines yield literal secret values. Code
    # such as key=os.environ[...] is an expression, not a credential.
    environment_assignment = re.compile('^' + SECRET_ASSIGNMENT.pattern.removeprefix('(?i)'), re.M)
    for path in paths:
        for match in environment_assignment.finditer(path.read_text(errors='replace')):
            value = next((v for v in match.groups()[1:] if v is not None), '')
            if len(value) >= 8 and not value.startswith(('$', '[', '<')) and '\\' not in value:
                secrets.add(value)
    PRIVATE_VALUES.extend(sorted(secrets, key=len, reverse=True))
    return len(secrets)


def publish_analysis(sources, out):
    target = out / 'analysis'
    target.mkdir(exist_ok=True)
    event_paths = {}
    for path in out.glob('*/events.json'):
        for event in load(path, []):
            event_paths.setdefault(event['id'], '../' + path.parent.name + '/' + event['path'] + '/event.json')
    def remap(text):
        return re.sub(r'work/jobs/([^/\s`"]+)/([^/\s`".,]+)(?:/[^\s`"),]+)?',
                      lambda m: '../' + m[1] + '--' + m[2] + '/index.md', redact(text))
    for source in sources:
        if not source.exists():
            continue
        if source.suffix == '.json':
            value = public_object(load(source))
            def walk(item):
                if isinstance(item, str):
                    return remap(item)
                if isinstance(item, list):
                    return [walk(v) for v in item]
                if isinstance(item, dict):
                    item = {k: walk(v) for k, v in item.items()}
                    if 'evidence_event_ids' in item:
                        item['published_event_links'] = [event_paths[e] for e in item['evidence_event_ids'] if e in event_paths]
                    return item
                return item
            value = walk(value)
            value['publication_note'] = 'Preliminary, noncomparative v1.2 observations. Invalid benchmark assertion fixture; excluded from improvement denominators. Raw trajectory references map to run indexes containing public-only CLI projections; raw private trajectories are not published.'
            text = json.dumps(value, indent=2)
        else:
            text = remap(source.read_text())
            text = re.sub(r'`(\.\./[^`]+/index\.md)`', r'[Published run evidence](\1)', text)
            text = re.sub(r'`([a-f0-9]{32})`', lambda m: '[' + m[1] + '](' + event_paths[m[1]] + ')' if m[1] in event_paths else m[0], text)
            text = ('> Preliminary, noncomparative v1.2 observations. The assertion fixture was invalid; exclude these results from improvement denominators. Raw trajectory references link to run indexes with public-only projections; private trajectories are not published.\n\n' + text)
        (target / source.name).write_text(text)
    (target / 'index.md').write_text('# Independent analysis appendix\n\n' + '\n'.join(f'- [{p.name}]({p.name})' for p in sorted(target.iterdir()) if p.name != 'index.md') + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--jobs', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--job', action='append', default=[])
    parser.add_argument('--invalid-job', action='append', default=[])
    parser.add_argument('--replace', action='store_true')
    parser.add_argument('--bootstrap', type=Path, action='append', default=[], help='Additive orchestrator capture root; repeat for each source group')
    parser.add_argument('--analysis-source', type=Path, action='append', default=[], help='Sanitized independent analysis appendix with remapped evidence links')
    parser.add_argument('--versions', type=Path, help='Orchestrator version/starting-state metadata JSON')
    parser.add_argument('--redact-file', type=Path, help='Private JSON array of literal identifiers; read in memory, never copied')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.redact_file:
        values = load(args.redact_file)
        if not isinstance(values, list) or any(not isinstance(value, str) or len(value) < 3 for value in values):
            parser.error('--redact-file must contain a JSON array of strings, each at least three characters')
        PRIVATE_VALUES.extend(values)
    discovered_secrets = discover_secret_values(args.jobs, args.bootstrap)
    if args.bootstrap:
        publish_bootstrap(args.bootstrap, args.out, args.replace)
    publish_diagnostics(args.jobs, args.out, args.replace)
    if args.versions:
        (args.out / 'versions.json').write_text(json.dumps(public_object(load(args.versions)), indent=2))
    for job in sorted(args.jobs.iterdir()):
        if not job.is_dir() or (args.job and job.name not in args.job):
            continue
        if not (load(job / 'result.json', {}) or {}).get('finished_at') and job.name not in args.invalid_job:
            continue
        for trial in sorted(job.iterdir()):
            if not trial.is_dir() or not any((trial / name).exists() for name in ['result.json', 'config.json', 'agent', 'artifacts']):
                continue
            if ((load(trial / 'result.json') or {}).get('agent_info') or {}).get('name') == 'nop':
                continue
            target = args.out / (job.name + '--' + trial.name)
            if target.exists() and args.replace:
                shutil.rmtree(target)
            summary = publish_trial(trial, args.out, job.name in args.invalid_job)
            if summary:
                print(json.dumps({k: summary[k] for k in ['run_id', 'outcome', 'capture_event_count', 'agent_shell_invocation_count', 'concern_count']}))
    if args.analysis_source:
        publish_analysis(args.analysis_source, args.out)
    summaries = [load(p) for p in sorted(args.out.glob('*/summary.json'))]
    (args.out / 'summaries.json').write_text(json.dumps(summaries, indent=2))
    concerns = ''.join(p.read_text() for p in sorted(args.out.glob('*/concerns.jsonl')))
    (args.out / 'concerns.jsonl').write_text(concerns)
    classes = {}
    for path in args.out.glob('*/events.json'):
        for event in load(path, []):
            for code in event.get('output_classes', []):
                classes.setdefault(code, []).append({'run': path.parent.name, 'event_id': event['id'], 'evidence': path.parent.name + '/' + event['path'] + '/event.json'})
    (args.out / 'observed-output-classes.json').write_text(json.dumps(classes, indent=2))
    index = ['# Harbor activation evidence', '', 'All screenshots are rendered from captured transcripts. They are not native terminal photographs. Recorded outcomes reflect Harbor errors and frozen strict rewards; zero reward is not proof of a product failure. Per-run assessment flags expose known construct limits without changing rewards.', '', '[Orchestrator preflight events](preflight/index.md) · [Version and starting-state record](versions.json) · [Independent analysis](analysis/index.md)', '',
             '## Capture limits', '', 'Separate stdout/stderr pipes preserve each stream. Cross-stream ordering is recorder observation order. Events correspond to shell tool invocations; compound-command child exit statuses are not separately observed. Redirected output is present only when subsequently observed or explicitly collected. Missing exit metadata remains incomplete. No PTY was used for these noninteractive trials. Private reasoning, native sessions, authentication stores and sensitive values are excluded from publishable evidence. This inventory covers observed output, not every possible product state.', '',
             '| Run | Agent | Outcome | Capture events | Agent shell invocations | Concerns |', '| --- | --- | --- | ---: | ---: | ---: |']
    index += [f'| [{s["run_id"]}]({s["run_id"]}/index.md) | {(s.get("agent") or {}).get("name")} | {s["outcome"]} | {s.get("capture_event_count", s.get("command_events"))} | {s.get("agent_shell_invocation_count", "uncomputed")} | {s["concern_count"]} |' for s in summaries]
    (args.out / 'index.md').write_text('\n'.join(index) + '\n')
    publishable = [args.out / name for name in ['index.md', 'summaries.json', 'concerns.jsonl', 'observed-output-classes.json', 'versions.json']]
    for directory in [args.out / 'preflight', args.out / 'analysis', *[args.out / s['run_id'] for s in summaries]]:
        publishable += [p for p in directory.rglob('*') if p.is_file()]
    # Upload only this allowlist. In particular, the original bootstrap input
    # directory may predate privacy fixes and must remain local.
    audit = privacy_audit([p for p in publishable if p.exists()], args.out)
    audit_path = args.out / 'privacy-audit.json'
    audit_path.write_text(json.dumps(audit, indent=2))
    publishable.append(audit_path)
    publication = {str(p.relative_to(args.out)): hashlib.sha256(p.read_bytes()).hexdigest() for p in publishable if p.exists()}
    (args.out / 'publication-manifest.json').write_text(json.dumps(publication, indent=2))
    print(json.dumps({'privacy_audit': audit['passed'], 'scanned_files': audit['scanned_files'], 'matches_by_category': audit['matches_by_category'], 'in_memory_secret_values': discovered_secrets}))


if __name__ == '__main__':
    main()
