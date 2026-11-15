import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import report
import task_metadata


class TaskMetadataTests(unittest.TestCase):
    def test_allowlisted_task_snapshot_has_both_hashes_without_auth_stores(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = root / 'task'
            task.mkdir()
            (task / 'instruction.md').write_text('Assigned goal only.')
            (task / 'task.toml').write_text('schema_version="1.4"\n')
            (task / 'auth.json').write_text('PRIVATE_AUTH_SENTINEL')
            (task / 'environment').mkdir()
            compose = json.dumps({'API_KEY': 'opaque-token-value'})
            (task / 'environment/docker-compose.yaml').write_text(compose)
            manifest = {str(p.relative_to(task)): hashlib.sha256(p.read_bytes()).hexdigest() for p in task.rglob('*') if p.is_file()}
            (task / 'manifest.json').write_text(json.dumps(manifest))
            trial = root / 'jobs/job/trial'
            trial.mkdir(parents=True)
            (trial / 'result.json').write_text(json.dumps({'config': {'task': {'path': str(task)}}, 'task_checksum': 'recorded-checksum'}))
            published = root / 'out/job--trial'
            published.mkdir(parents=True)
            frozen = json.dumps({'run_id': 'job--trial', 'job': 'job'})
            (published / 'summary.json').write_text(frozen)
            entries = task_metadata.publish_task_metadata(root / 'jobs', root / 'out', report.public_object, report.redact)
            self.assertTrue(entries[0]['source_files_verified_against_recorded_manifest'])
            files = list((root / 'out/task-metadata').rglob('*'))
            self.assertFalse(any(p.name == 'auth.json' for p in files))
            text = '\n'.join(p.read_text() for p in files if p.is_file())
            self.assertNotIn('opaque-token-value', text)
            self.assertNotIn('PRIVATE_AUTH_SENTINEL', text)
            self.assertIn('original_sha256', text)
            self.assertIn('sanitized_sha256', text)
            self.assertEqual((published / 'summary.json').read_text(), frozen)

    def test_verifier_diagnostic_copy_without_cli_and_bare_credit_task_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trial = root / 'job/trial'
            (trial / 'verifier').mkdir(parents=True)
            (trial / 'workspace').mkdir()
            (trial / 'verifier/test-stdout.txt').write_text('actual verifier output')
            (trial / 'workspace/test-stdout.txt').write_text('NOT_VERIFIER_SENTINEL')
            (trial / 'result.json').write_text(json.dumps({'task_name': 'credits', 'finished_at': 'done'}))
            summary = report.publish_trial(trial, root / 'out')
            self.assertIn('collection_timing_note', summary)
            self.assertEqual(summary['agent_tool_invocation_count'], 0)
            self.assertEqual((root / 'out/job--trial/verifier-test-stdout.txt').read_text(), 'actual verifier output')
            self.assertFalse((root / 'out/job--trial/workspace-test-stdout.txt').exists())


if __name__ == '__main__':
    unittest.main()
