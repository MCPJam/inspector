#!/usr/bin/env python3
"""Descriptive comparison of published evidence; never changes verifier rewards."""
import json
import statistics
from pathlib import Path

BOOLEAN_METRICS = {
    'first_meaningful_result': 'Strict first CLI tool result',
    'server_observed_successful_tool_call': 'Ledger-confirmed direct tester tool success',
    'first_eval_completed': 'Strict CLI simulated Eval success',
    'server_observed_simulated_eval': 'Ledger-confirmed simulated Eval success (any public surface)',
    'successful_recovery': 'Ledger-confirmed recovery',
    'state_preserved': 'Eval suite state preserved',
    'evidence_completeness': 'Verifier evidence completeness',
    'correct_diagnosis': 'Correct diagnosis independently measured',
    'human_handoff_correct': 'Correct human handoff independently measured',
    'credit_cost_understanding': 'Credit/cost understanding independently measured',
    'errors_explain_cause_action_actor': 'Cause/action/actor independently measured',
}


def final_metrics(entries, result):
    """Never substitute blocked-step metrics for missing final resume metrics."""
    steps = result.get('step_results') or []
    if steps:
        phase = steps[-1]['step_name']
        candidates = [e for e in entries if e['source'].startswith('steps/' + phase + '/verifier/')]
    else:
        phase = 'trial'
        candidates = [e for e in entries if e['source'] == 'verifier/metrics.json']
    if len(candidates) != 1:
        return {}, None, phase
    return candidates[0]['metrics'], candidates[0]['source'], phase


def fraction(values):
    known = [v for v in values if isinstance(v, bool)]
    return {'positive': sum(known), 'observed': len(known), 'total': len(values), 'unknown': len(values) - len(known)}


def numeric(values):
    known = [v for v in values if isinstance(v, (float, int)) and not isinstance(v, bool)]
    return {'median': statistics.median(known) if known else None, 'min': min(known) if known else None,
            'max': max(known) if known else None, 'observed': len(known), 'total': len(values)}


def build(root, baseline_jobs, patched_jobs):
    rows, excluded = [], []
    cohorts = {job: 'baseline' for job in baseline_jobs}
    cohorts.update({job: 'patched' for job in patched_jobs})
    for path in sorted(root.glob('*/summary.json')):
        summary = json.loads(path.read_text())
        job = summary['job']
        if job not in cohorts:
            excluded.append({'run_id': summary['run_id'], 'reason': 'Outside explicitly selected comparison jobs', 'outcome': summary['outcome']})
            continue
        if not summary.get('comparison_eligible', True) or summary['outcome'] == 'harness-invalid':
            excluded.append({'run_id': summary['run_id'], 'reason': 'Harness-invalid or explicitly noncomparative', 'outcome': summary['outcome']})
            continue
        result = json.loads((path.parent / 'result.json').read_text()) or {}
        metrics, source, phase = final_metrics(summary.get('metrics', []), result)
        reward = summary.get('rewards') or {}
        strict_success = all(float(v) > 0 for v in reward.values()) if reward else None
        rows.append({'run_id': summary['run_id'], 'cohort': cohorts[job], 'agent': (summary.get('agent') or {}).get('name'),
                     'scenario': (summary.get('scenario') or 'unknown').split('/')[-1], 'outcome': summary['outcome'],
                     'strict_reward': reward, 'strict_success': strict_success, 'final_phase': phase,
                     'usable_product_trial': summary['outcome'] != 'provider-blocked',
                     'metrics_source': source, 'metrics': metrics,
                     'native_shell_invocations': summary.get('agent_shell_invocation_count'),
                     'commands_to_first_cli_tool_result': summary.get('first_cli_tool_result', {}).get('commands_to_first_cli_tool_result'),
                     'concern_count': summary.get('concern_count'), 'assessment_flags': summary.get('assessment_flags', []),
                     'evidence': '../' + summary['run_id'] + '/index.md'})
    groups = []
    for key in sorted({(r['cohort'], r['agent'], r['scenario']) for r in rows}):
        selected = [r for r in rows if (r['cohort'], r['agent'], r['scenario']) == key]
        usable = [r for r in selected if r['usable_product_trial']]
        rates = {field: fraction([r['metrics'].get(field) for r in usable]) for field in BOOLEAN_METRICS}
        rates['strict_success'] = fraction([r['strict_success'] for r in usable])
        rates['had_concern_note'] = fraction([bool(r['concern_count']) for r in usable])
        rates['duplicate_charges_observed'] = fraction([r['metrics']['duplicate_charges'] > 0 if isinstance(r['metrics'].get('duplicate_charges'), int) else None for r in usable])
        descriptions = {field: numeric([r.get(field) for r in usable]) for field in ['native_shell_invocations', 'commands_to_first_cli_tool_result']}
        descriptions['time_to_first_direct_tester_tool_seconds'] = numeric([r['metrics'].get('time_to_first_result_seconds') for r in usable])
        descriptions['repeated_ineffective_requests'] = numeric([r['metrics'].get('repeated_ineffective_requests') for r in usable])
        groups.append({'cohort': key[0], 'agent': key[1], 'scenario': key[2], 'sample_size': len(usable), 'attempt_count': len(selected), 'provider_blocked_count': len(selected) - len(usable),
                       'rates': rates, 'descriptive_metrics': descriptions,
                       'outcomes': {outcome: sum(r['outcome'] == outcome for r in selected) for outcome in sorted({r['outcome'] for r in selected})},
                       'run_ids': [r['run_id'] for r in selected]})
    return {'schema_version': 1, 'baseline_jobs': baseline_jobs, 'patched_jobs': patched_jobs,
            'rows': rows, 'groups': groups, 'excluded': excluded,
            'limitations': ['All Eval/credit outcomes are deterministic sandbox simulations, not live billing.',
                            'Final-phase metrics are selected once; blocked-step snapshots never count as separate trials.',
                            'Strict frozen reward and ledger-confirmed public-surface milestones are separate; no retrospective regrading.',
                            'Provider-blocked attempts remain visible but are excluded from usable product-trial rates. Null metrics are unknown, not failures; unknown counts are explicit.',
                            'Time begins at fixture initialization; it is descriptive and includes variable provider/container delays.',
                            'Native command counts include tester installation and compound shell invocations once; exclude Harbor startup and nested wrapper captures.',
                            'A concern note count measures observed statements, not severity, unique issue count, or human prevalence.',
                            'No statistical significance or causal improvement is inferred from these small samples.']}


def display_rate(rate):
    return f"{rate['positive']}/{rate['observed']}" + (f"; {rate['unknown']} unknown" if rate['unknown'] else '')


def write_comparison(root, baseline_jobs, patched_jobs, targeted_jobs=None, heldout_jobs=None):
    result = build(root, baseline_jobs, patched_jobs)
    target = root / 'comparison'
    target.mkdir(exist_ok=True)
    supplemental = {}
    for label, jobs in [('cycle_2_targeted', targeted_jobs or []), ('heldout_discovery', heldout_jobs or [])]:
        observation = build(root, jobs, [])
        observation.pop('excluded')
        for item in observation['rows'] + observation['groups']:
            item['cohort'] = label
        supplemental[label] = observation
    (target / 'supplemental.json').write_text(json.dumps(supplemental, indent=2))
    (target / 'results.json').write_text(json.dumps(result, indent=2))
    lines = ['# Baseline versus patched evidence', '', '[Complete machine-readable comparison](results.json)', '',
             'Each rate shows positive/observed with unknown values separately. Cohorts include failed, timed-out and provider-blocked runs when not harness-invalid. A successful task can still have friction.', '',
             '| Cohort | Agent | Scenario | usable n / attempts | Strict reward pass | Direct tool success | Simulated Eval (any public surface) | Recovery | Concern note |',
             '| --- | --- | --- | ---: | --- | --- | --- | --- | --- |']
    for group in result['groups']:
        rates = group['rates']
        cells = [group['cohort'], group['agent'], group['scenario'], str(group['sample_size']) + '/' + str(group['attempt_count'])]
        cells += [display_rate(rates[key]) for key in ['strict_success', 'server_observed_successful_tool_call', 'server_observed_simulated_eval', 'successful_recovery', 'had_concern_note']]
        lines.append('| ' + ' | '.join(cells) + ' |')
    lines += ['', '## Supplemental experiments', '', 'These samples are separate from primary cycle-1 comparison denominators. [Detailed supplemental results](supplemental.json).', '', '| Experiment | Agent | Scenario | Usable / attempts | Strict pass | Direct tool | Simulated Eval | Recovery |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
    for label, observation in supplemental.items():
        for group in observation['groups']:
            cells = [label, group['agent'], group['scenario'], str(group['sample_size']) + '/' + str(group['attempt_count'])]
            cells += [display_rate(group['rates'][key]) for key in ['strict_success', 'server_observed_successful_tool_call', 'server_observed_simulated_eval', 'successful_recovery']]
            lines.append('| ' + ' | '.join(cells) + ' |')
        lines += ['', *[f"- [{r['run_id']}]({r['evidence']}): {r['outcome']}." for r in observation['rows']], '']
    lines += ['', '## Run evidence', '']
    lines += [f"- [{r['run_id']}]({r['evidence']}): {r['outcome']}; strict reward `{r['strict_reward']}`; final phase `{r['final_phase']}`; metric source `{r['metrics_source']}`." for r in result['rows']]
    lines += ['', '## Excluded observations', '', 'Preserved and visible, outside valid comparison denominators.', '']
    lines += [f"- [{r['run_id']}](../{r['run_id']}/index.md): {r['reason']}; {r['outcome']}." for r in result['excluded']]
    lines += ['', '## Interpretation limits', ''] + ['- ' + limitation for limitation in result['limitations']]
    (target / 'index.md').write_text('\n'.join(lines) + '\n')
    return result
