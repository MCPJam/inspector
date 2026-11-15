"""Index observed failures, excluding error-code examples in successful docs/help."""
import json
import re
from pathlib import Path


def documents(text, allow_mixed=False):
    try:
        yield json.loads(text)
        return
    except ValueError:
        pass
    # Mixed prose, Markdown and documentation examples are not error envelopes.
    try:
        values = [json.loads(line) for line in text.splitlines() if line.strip()]
    except ValueError:
        if allow_mixed:
            for line in text.splitlines():
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
        return
    yield from values


def error_classes(stdout, stderr, exit_status):
    """Only root error envelopes count; native agent/documentation payloads don't."""
    found = set()
    for stream, text in [('stdout', stdout), ('stderr', stderr)]:
        for value in documents(text, allow_mixed=stream == 'stderr' and exit_status not in (0, None)):
            if not isinstance(value, dict):
                continue
            if value.get('kind') == 'protocol-conformance' and value.get('passed') is False:
                for group in value.get('groups', []):
                    found.update('CONFORMANCE:' + case['id'] for case in group.get('cases', []) if case.get('status') == 'failed')
            error = value.get('error')
            if isinstance(error, dict) and error.get('code'):
                reason = (error.get('details') or {}).get('reason')
                found.add(str(error['code']) + (':' + str(reason) if reason else ''))
            elif value.get('name') == 'CliError' or (isinstance(value.get('exitCode'), int) and value['exitCode'] != 0):
                reason = (value.get('details') or {}).get('reason')
                found.add(str(value.get('code', 'CliError')) + (':' + str(reason) if reason else ''))
            elif value.get('isError') is True:
                found.add('MCP_TOOL_ERROR')
    if exit_status not in (0, None):
        # Stderr patterns describe actual failed commands, not successful help.
        for pattern, label in [(r'error: (?:unknown|too many|missing|required)', 'CLI_USAGE_TEXT'),
                               (r'(?:command not found|No such file or directory)', 'MISSING_COMMAND_OR_FILE'),
                               (r'(?i)(?:not logged in|not signed in|invalid authentication|authentication token.*invalid)', 'PROVIDER_AUTHENTICATION'),
                               (r'(?:ModuleNotFoundError|ERR_MODULE_NOT_FOUND|Cannot find module)', 'MODULE_NOT_FOUND'),
                               (r'(?:EACCES|EPERM|Operation not permitted|Permission denied)', 'ENVIRONMENT_PERMISSION'),
                               (r'(?:ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)', 'NETWORK_FAILURE'),
                               (r'(?:SyntaxError|JSONDecodeError)', 'SYNTAX_OR_JSON_ERROR')]:
            if re.search(pattern, stderr):
                found.add(label)
        if not found:
            found.add('UNCLASSIFIED_NONZERO_EXIT')
    return sorted(found)


def attribution(code, run, event):
    if code == 'CONFORMANCE:wire-schema-valid':
        return 'conformance checker; GET405 false positive confirmed by controlled reproduction, other contexts require inspection'
    if code.startswith('CONFORMANCE:'):
        return 'observed conformance check failure; inspect fixture and checker evidence before attribution'
    if code.startswith('FORBIDDEN:PLATFORM_FEE_REQUIRED'):
        return 'simulated fixture billing response' if run != 'preflight' else 'product CLI adapter reproduction with synthetic input'
    if 'fixture_' in code.lower():
        return 'fixture limitation'
    if code == 'MCP_TOOL_ERROR':
        return 'fixture tool result; not a product failure by itself'
    if run == 'preflight':
        return 'orchestrator/product reproduction' if 'product-fixes' in event['id'] else 'harness/provider/environment preflight'
    if code.startswith('USAGE_ERROR') or code == 'CLI_USAGE_TEXT':
        return 'product command interface'
    if code in {'MISSING_COMMAND_OR_FILE', 'MODULE_NOT_FOUND', 'ENVIRONMENT_PERMISSION', 'NETWORK_FAILURE', 'SYNTAX_OR_JSON_ERROR'}:
        return 'tester command/environment; causality requires review'
    return 'unattributed; inspect linked command output'


def write_gallery(root, render):
    target = root / 'gallery'
    target.mkdir(exist_ok=True)
    failures, classes = [], {}
    for source in sorted(root.glob('*/events.json')):
        run = source.parent.name
        for event in json.loads(source.read_text()):
            directory = source.parent / event['path']
            stdout = (directory / 'stdout.txt').read_text()
            stderr = (directory / 'stderr.txt').read_text()
            codes = error_classes(stdout, stderr, event.get('exit_status'))
            if not codes:
                continue
            record = {'run_id': run, 'event_id': event['id'], 'classes': codes, 'exit_status': event.get('exit_status'),
                      'evidence': '../' + str(directory.relative_to(root)) + '/event.json',
                      'stdout': '../' + str(directory.relative_to(root)) + '/stdout.txt',
                      'stderr': '../' + str(directory.relative_to(root)) + '/stderr.txt',
                      'screenshots': ['../' + str(directory.relative_to(root)) + '/' + p for p in event['screenshots']]}
            failures.append(record)
            for code in codes:
                # Prefer a short actual command over nested agent launch envelopes.
                score = len(stdout) + len(stderr) + sum(len(x) for x in event.get('argv') or [])
                candidate = {**record, 'attribution': attribution(code, run, event), 'selection_size': score}
                if code not in classes or score < classes[code]['selection_size']:
                    classes[code] = candidate
    exceptions = {}
    for path in sorted(root.glob('*/result.json')):
        result = json.loads(path.read_text()) or {}
        entries = [('trial', result.get('exception_info'))]
        entries += [(s.get('step_name'), s.get('exception_info')) for s in result.get('step_results') or []]
        for phase, exception in entries:
            if not exception:
                continue
            code = exception.get('exception_type', 'UnknownHarborException')
            if code in exceptions:
                continue
            # Render only actual captured sanitized result metadata, not invented terminal text.
            stem = 'harbor-' + re.sub(r'[^a-zA-Z0-9_-]', '_', code)
            pages = render(json.dumps(exception, indent=2), target, stem, 'Captured Harbor result metadata (not terminal output)')
            exceptions[code] = {'run_id': path.parent.name, 'phase': phase, 'evidence': '../' + path.parent.name + '/result.json', 'screenshots': pages}
    pairs = [('Actionable usage errors', 'before-link-usage', 'after-link-usage'),
             ('Discoverable credit/cost limits in Eval help', 'before-eval-help', 'after-eval-help'),
             ('Plan/role-aware platform-credit recovery guidance', 'before-platform-fee-message', 'after-platform-fee-corrected'),
             ('GET405 HTTP body excluded from JSON-RPC schema checks', 'before-conformance-get405', 'after-conformance-get405')]
    lines = ['# Representative observed errors and fixes', '',
             'Rendered evidence from captured output; no native terminal photographs. These are observed output classes, not an exhaustive state-space inventory. Successful documentation/help examples do not create error classes. Every detected event is listed in [error-gallery.json](error-gallery.json); every command outcome remains in the [complete evidence index](../index.md). Attribution is separate from the observed error.', '',
             '## Before/after product reproductions', '', 'These controlled reproductions demonstrate changed output. Fresh-user improvement is assessed separately in the [comparison](../comparison/index.md).', '']
    for title, before, after in pairs:
        lines += ['### ' + title, '']
        for label, name in [('Before', before), ('After', after)]:
            directory = root / 'preflight' / ('product-fixes--' + name)
            pages = sorted(directory.glob('outcome-*.svg'))
            if not pages:
                lines += [label + ': evidence not yet published.', '']
                continue
            focused = []
            if 'conformance-get405' in name:
                report = json.loads((directory / 'stdout.txt').read_text())
                case = next(c for g in report['groups'] for c in g['cases'] if c['id'] == 'wire-schema-valid')
                focused = render(json.dumps(case, indent=2), target, name, 'Captured stdout JSON excerpt: groups[].cases[]; not a native terminal')
            page = pages[-1] if 'eval-help' in name else pages[0]
            prefix = '../' + str(directory.relative_to(root))
            lines += [f'{label}: [complete stdout]({prefix}/stdout.txt) · [stderr]({prefix}/stderr.txt)', '',
                      *([f'![{label}: {title}; structured excerpt from captured stdout]({p})' for p in focused] if focused else [f'![{label}: {title}; rendered captured evidence](../{page.relative_to(root)})']), '']
    lines += ['## Observed command error classes', '']
    operational = {}
    for code, record in sorted(classes.items()):
        if record['run_id'] == 'preflight' and not record['event_id'].startswith('product-fixes:'):
            operational[code] = record
            continue
        lines += ['### ' + code, '', record['attribution'] + '.', '',
                  f"[{record['run_id']} / {record['event_id']}]({record['evidence']}) · [stdout]({record['stdout']}) · [stderr]({record['stderr']})", '']
        lines += [f'![{code}; rendered captured evidence]({page})' for page in record['screenshots']]
        lines += ['']
    lines += ['<details>', '<summary>Harbor, verifier, cancellation and timeout result exceptions</summary>', '',
              'Harbor can exit zero while a trial fails. These screenshots render captured result metadata, not terminal output.', '']
    for code, record in sorted(operational.items()):
        lines += [f'### Preflight: {code}', '', f"[{record['event_id']}]({record['evidence']}) · [stdout]({record['stdout']}) · [stderr]({record['stderr']})", '']
        lines += [f'![Preflight {code}; rendered captured evidence]({page})' for page in record['screenshots']]
        lines += ['']
    for code, record in sorted(exceptions.items()):
        lines += [f"### {code}", '', f"[{record['run_id']} / {record['phase']}]({record['evidence']})", '']
        lines += [f'![Captured Harbor result metadata: {code}]({page})' for page in record['screenshots']]
        lines += ['']
    lines += ['</details>', '', 'Unclassified nonzero exits are retained for manual review; the detector makes no claim that different messages within that bucket share a cause.', '']
    result = {'classes': classes, 'failed_or_error_events': failures, 'harbor_exceptions': exceptions}
    (target / 'error-gallery.json').write_text(json.dumps(result, indent=2))
    (target / 'representative-error-gallery.md').write_text('\n'.join(lines))
    return result
