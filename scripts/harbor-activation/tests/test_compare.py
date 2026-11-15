import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import compare


class ComparisonTests(unittest.TestCase):
    def test_resume_metrics_selected_once_and_missing_final_stays_unknown(self):
        entries = [{'source': 'steps/blocked/verifier/metrics.json', 'metrics': {'successful_recovery': False}},
                   {'source': 'steps/resume/verifier/metrics.json', 'metrics': {'successful_recovery': True}}]
        result = {'step_results': [{'step_name': 'blocked'}, {'step_name': 'resume'}]}
        metrics, source, phase = compare.final_metrics(entries, result)
        self.assertTrue(metrics['successful_recovery'])
        self.assertEqual(phase, 'resume')
        self.assertEqual(compare.final_metrics(entries[:1], result), ({}, None, 'resume'))

    def test_unknown_is_separate_from_failure(self):
        self.assertEqual(compare.fraction([True, False, None]), {'positive': 1, 'observed': 2, 'total': 3, 'unknown': 1})

    def test_strict_failure_and_public_surface_success_remain_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, invalid in [('valid', False), ('invalid', True), ('provider', False)]:
                run = root / ('job--' + name)
                run.mkdir()
                (run / 'result.json').write_text('{}')
                summary = {'run_id': 'job--' + name, 'job': 'job', 'scenario': '/healthy', 'agent': {'name': 'codex'},
                           'outcome': 'harness-invalid' if invalid else 'provider-blocked' if name == 'provider' else 'failed', 'comparison_eligible': not invalid,
                           'rewards': {'reward': 0}, 'concern_count': 1,
                           'metrics': [{'source': 'verifier/metrics.json', 'metrics': {'server_observed_simulated_eval': True}}]}
                (run / 'summary.json').write_text(json.dumps(summary))
            result = compare.write_comparison(root, ['job'], [])
            self.assertEqual(len(result['rows']), 2)
            self.assertEqual(len(result['excluded']), 1)
            group = result['groups'][0]
            self.assertEqual(group['rates']['strict_success']['positive'], 0)
            self.assertEqual(group['rates']['server_observed_simulated_eval']['positive'], 1)
            self.assertEqual(group['rates']['successful_recovery']['unknown'], 1)
            self.assertEqual(group['sample_size'], 1)
            self.assertEqual(group['attempt_count'], 2)
            self.assertEqual(group['provider_blocked_count'], 1)

    def test_supplemental_runs_do_not_enter_primary_denominators(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for job in ['primary', 'cycle2', 'heldout']:
                run = root / (job + '--trial')
                run.mkdir()
                (run / 'result.json').write_text('{}')
                (run / 'summary.json').write_text(json.dumps({'run_id': job + '--trial', 'job': job,
                    'scenario': 'healthy', 'agent': {'name': 'codex'}, 'outcome': 'passed', 'rewards': {'reward': 1}, 'metrics': []}))
            result = compare.write_comparison(root, ['primary'], [], ['cycle2'], ['heldout'])
            self.assertEqual(len(result['rows']), 1)
            supplemental = json.loads((root / 'comparison/supplemental.json').read_text())
            self.assertEqual(len(supplemental['cycle_2_targeted']['rows']), 1)
            self.assertEqual(len(supplemental['heldout_discovery']['rows']), 1)



if __name__ == '__main__':
    unittest.main()
