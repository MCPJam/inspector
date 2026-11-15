"""Publication must not leak secrets or turn infrastructure failures into wins."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import report


class EvidencePublicationTests(unittest.TestCase):
    def test_secret_split_across_chunks_is_fully_removed(self):
        text = 'before sk-ant-oat01-testsecrettokensecret after\n'
        events = [{'stream': 'stdout', 'seconds': 0, 'data': text[:17]},
                  {'stream': 'stderr', 'seconds': .1, 'data': 'warning\n'},
                  {'stream': 'stdout', 'seconds': .2, 'data': text[17:]}]
        clean = report.sanitize_stream(events)
        self.assertNotIn('testsecret', json.dumps(clean))
        self.assertEqual(''.join(e['data'] for e in clean if e['stream'] == 'stdout'),
                         'before [REDACTED] after\n')
        self.assertEqual([e['seconds'] for e in clean], [0, .1, .2])

    def test_mixed_claude_message_keeps_public_text_only(self):
        event = {'type': 'assistant', 'message': {'content': [
            {'type': 'thinking', 'thinking': 'PRIVATE_REASONING_SENTINEL'},
            {'type': 'text', 'text': 'Concern: missing guidance.'}]}}
        text = json.dumps(event) + '\n'
        clean = report.apply_slice(text, 0, len(text), report.edits_for(text))
        self.assertNotIn('PRIVATE_REASONING_SENTINEL', clean)
        self.assertIn('Concern: missing guidance.', clean)

    def test_private_reasoning_is_never_a_concern_quote(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'claude-code.txt'
            path.write_text(json.dumps({'type': 'assistant', 'message': {'content': [
                {'type': 'thinking', 'thinking': 'Concern: PRIVATE'},
                {'type': 'text', 'text': 'Concern: public.'}]}}) + '\n')
            events, notes = report.public_cli(path)
            self.assertEqual([n['text'] for n in notes], ['Concern: public.'])
            self.assertNotIn('PRIVATE', json.dumps(events))

    def test_account_and_email_are_redacted(self):
        text = '{"orgId": "person-account-id", "email": "person@example.com"}'
        clean = report.redact(text)
        self.assertNotIn('person-account-id', clean)
        self.assertNotIn('person@example.com', clean)

    def test_multiline_opaque_token_fields_are_redacted(self):
        text = '{\n  "refresh_token": "opaque-random-value",\n  "ANTHROPIC_API_KEY": "another-opaque-value"\n}\n'
        clean = report.apply_slice(text, 0, len(text), report.edits_for(text))
        self.assertNotIn('opaque-random-value', clean)
        self.assertNotIn('another-opaque-value', clean)

    def test_arbitrary_local_messaging_token_is_redacted(self):
        text = 'CLAUDE_CODE_MESSAGING_TOKEN=opaque-local-value\nEXAMPLE_PRIVATE_KEY="opaque-key-value"\nNORMAL=visible\n'
        clean = report.apply_slice(text, 0, len(text), report.edits_for(text))
        self.assertNotIn('opaque-local-value', clean)
        self.assertNotIn('opaque-key-value', clean)
        self.assertIn('NORMAL=visible', clean)
        pieces = [{'stream': 'stdout', 'data': text[:41]}, {'stream': 'stdout', 'data': text[41:]}]
        self.assertNotIn('opaque-local-value', json.dumps(report.sanitize_stream(pieces)))

    def test_assignment_secret_masks_unlabelled_copies_in_memory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'jobs/job/trial/artifacts/capture/event/stdout.txt'
            path.parent.mkdir(parents=True)
            path.write_text('APP_MESSAGING_TOKEN=unlabelled-secret-value\nkey=os.environ[\"APP_TOKEN\"]\n')
            initial = list(report.PRIVATE_VALUES)
            try:
                report.discover_secret_values(root / 'jobs', [])
                self.assertNotIn('unlabelled-secret-value', report.redact('Echo unlabelled-secret-value'))
                self.assertNotIn('os.environ[', report.PRIVATE_VALUES)
            finally:
                report.PRIVATE_VALUES[:] = initial

    def test_audit_decodes_json_escaped_newlines(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'stream.jsonl'
            path.write_text(json.dumps({'data': 'AUTH_TOKEN=\nOTHER=visible\nLOCAL_TOKEN=[REDACTED]\n'}) + '\n')
            self.assertTrue(report.privacy_audit([path], root)['passed'])
            path.write_text(json.dumps({'data': 'LOCAL_TOKEN=opaque-leaked-value\n'}) + '\n')
            self.assertFalse(report.privacy_audit([path], root)['passed'])

    def test_assessment_flags_do_not_rewrite_strict_reward(self):
        metric = {'prompt': 'C', 'auth_refusal_count': 0, 'server_observed_successful_tool_call': True,
                  'server_observed_simulated_eval': True, 'first_eval_completed': False, 'reward': 0}
        flags = report.assessment_flags([{'metrics': metric}])
        self.assertIn('authentication_succeeded_without_exercising_refusal_recovery', flags)
        self.assertIn('simulated_eval_observed_but_strict_command_match_missing', flags)
        self.assertEqual(metric['reward'], 0)

    def test_private_identifier_list_covers_split_recordings(self):
        report.PRIVATE_VALUES.append('unique-private-handle')
        try:
            events = [{'stream': 'stdout', 'data': 'User UNIQUE-PRIVATE-'},
                      {'stream': 'stdout', 'data': 'HANDLE signed in'}]
            clean = report.sanitize_stream(events)
            self.assertEqual(''.join(e['data'] for e in clean), 'User [PRIVATE IDENTIFIER REDACTED] signed in')
            self.assertNotIn('unique-private-handle', report.redact('unique-private-handle'))
        finally:
            report.PRIVATE_VALUES.remove('unique-private-handle')

    def test_harbor_exception_overrides_process_exit(self):
        result = {'exception_info': {'exception_type': 'RewardFileNotFoundError'},
                  'verifier_result': None}
        self.assertEqual(report.classify(result, False), 'harness-invalid')
        self.assertEqual(report.classify({'verifier_result': {'rewards': {'reward': 0}}}, False), 'failed')

    def test_nested_verifier_exception_is_harness_invalid(self):
        result = {'exception_info': None, 'reward_valid': False, 'verifier_result': None,
                  'step_results': [{'step_name': 'blocked', 'exception_info': {'exception_type': 'RewardFileNotFoundError'}}]}
        self.assertEqual(report.classify(result, False), 'harness-invalid')

    def test_initial_blocked_reward_does_not_override_final_recovery(self):
        result = {'reward_valid': True, 'verifier_result': {'rewards': {'reward': 1}},
                  'step_results': [{'step_name': 'blocked', 'exception_info': None, 'verifier_result': {'rewards': {'reward': 0}}},
                                   {'step_name': 'resume', 'exception_info': None, 'verifier_result': {'rewards': {'reward': 1}}}]}
        self.assertEqual(report.classify(result, False), 'passed')
        self.assertEqual(report.classify({'reward_valid': False}, False), 'harness-invalid')

    def test_actual_tool_ids_count_once_per_phase(self):
        started = {'event': {'type': 'item.started', 'item': {'id': 'item_2', 'type': 'command_execution'}}}
        completed = {'event': {'type': 'item.completed', 'item': {'id': 'item_2', 'type': 'command_execution'}}}
        calls = report.tool_invocations([started, completed], 'blocked')
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]['is_shell_command'])

    def test_phase_snapshot_wins_over_live_duplicate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ['agent/codex.txt', 'steps/blocked/agent/codex.txt', 'agent/steps/blocked/codex.txt', 'steps/resume/agent/codex.txt']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}\n')
            self.assertEqual([str(p.relative_to(root)) for p in report.cli_sources(root)],
                             ['steps/blocked/agent/codex.txt', 'steps/resume/agent/codex.txt'])

    def test_additive_capture_roots_keep_colliding_event_ids_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for group in ['bootstrap', 'product-fixes']:
                event = root / group / 'same-id'
                event.mkdir(parents=True)
                (event / 'event.json').write_text(json.dumps({'event_id': 'same-id', 'argv': ['example'], 'exit_status': 0}))
                for name in ['stdout.txt', 'stderr.txt', 'stream.jsonl']:
                    (event / name).write_text('')
            out = root / 'out'
            out.mkdir()
            report.publish_bootstrap([root / 'bootstrap'], out)
            report.publish_bootstrap([root / 'product-fixes'], out)
            events = json.loads((out / 'preflight/events.json').read_text())
            self.assertEqual({e['id'] for e in events}, {'bootstrap:same-id', 'product-fixes:same-id'})

    def test_nop_diagnostics_do_not_create_agent_summary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trial = root / 'jobs/packaging/trial'
            trial.mkdir(parents=True)
            (trial / 'result.json').write_text(json.dumps({'finished_at': 'done', 'agent_info': {'name': 'nop'}, 'verifier_result': {'rewards': {'reward': 0}}}))
            out = root / 'out'
            out.mkdir()
            report.publish_diagnostics(root / 'jobs', out)
            diagnostics = json.loads((out / 'preflight/diagnostics.json').read_text())
            self.assertEqual(diagnostics[0]['role'], 'harness_diagnostic')
            self.assertEqual(list(out.glob('*/summary.json')), [])

    def test_cancelled_missing_result_retains_observed_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trial = root / 'job/trial'
            trial.mkdir(parents=True)
            summary = report.publish_trial(trial, root / 'out', invalid=True)
            self.assertEqual(summary['outcome'], 'harness-invalid')
            self.assertFalse(summary['collection']['result_present'])
            self.assertFalse(summary['comparison_eligible'])
            self.assertIsNone(json.loads((root / 'out/job--trial/result.json').read_text()))

    def test_commands_to_first_result_requires_verified_exact_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            output = '{"structuredContent":{"sum":5},"isError":false}\n'
            capture = target / 'commands/event'
            capture.mkdir(parents=True)
            (capture / 'stdout.txt').write_text(output)
            invocations = [{'id': 'install', 'is_shell_command': True},
                           {'id': 'call', 'is_shell_command': True, 'phase': 'trial', 'result_public_line': 4,
                            'command': 'mcpjam tools call --tool-name add', **report.output_facts(output)}]
            events = [{'id': 'capture-id', 'path': 'commands/event'}]
            metrics = [{'metrics': {'mcpjam_tool_event_ids': ['capture-id']}}]
            first = report.first_cli_result(invocations, events, target, metrics)
            self.assertEqual(first['commands_to_first_cli_tool_result'], 2)
            self.assertIsNone(report.first_cli_result(invocations, events, target, [])['commands_to_first_cli_tool_result'])
            self.assertFalse(report.output_facts('{"structuredContent":{"sum":5},"isError":true}')['successful_sum_output'])

    def test_analysis_links_use_published_runs_and_events(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / 'out/job--trial'
            run.mkdir(parents=True)
            event_id = 'a' * 32
            (run / 'events.json').write_text(json.dumps([{'id': event_id, 'path': 'commands/001'}]))
            source = root / 'analysis.md'
            source.write_text('Source: `work/jobs/job/trial/agent/trajectory.json`, step 1. Event `' + event_id + '`.')
            report.publish_analysis([source], root / 'out')
            text = (root / 'out/analysis/analysis.md').read_text()
            self.assertNotIn('work/jobs/', text)
            self.assertIn('../job--trial/index.md', text)
            self.assertIn('../job--trial/commands/001/event.json', text)

    def test_schema_type_object_is_not_private_reasoning(self):
        schema = {'type': {'type': 'string'}, 'properties': [{'type': ['string', 'null']}]}
        self.assertEqual(report.public_object(schema), schema)
        text = json.dumps(schema) + '\n'
        self.assertIn('properties', report.apply_slice(text, 0, len(text), report.edits_for(text)))

    def test_native_provider_oauth_failure_is_not_harness_or_product_auth(self):
        native = {'exception_info': {'exception_type': 'UnknownApiError',
                  'exception_message': '{"api_error_status":401,"api_error_origin":"first_party","result":"OAuth access token expired"}'}}
        self.assertEqual(report.classify(native, False), 'provider-blocked')
        product = {'exception_info': {'exception_type': 'UnknownApiError', 'exception_message': 'MCP server returned 401'}}
        self.assertEqual(report.classify(product, False), 'harness-invalid')

    def test_audit_handles_nested_serialization_and_empty_html_env_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'outcome.svg'
            path.write_text('TOKEN=&quot;&quot;\\nNEXT_TOKEN=[REDACTED]')
            self.assertTrue(report.privacy_audit([path], root)['passed'])
            path.write_text('TOKEN=&quot;opaque-leak-value&quot;')
            self.assertFalse(report.privacy_audit([path], root)['passed'])
            text = json.dumps({'data': json.dumps({'data': 'TOKEN=\nOTHER=visible\n'})})
            path = root / 'stdout.txt'
            path.write_text(text)
            self.assertTrue(report.privacy_audit([path], root)['passed'])

    def test_cycle2_list_appendix_is_labeled_and_linked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            out = root / 'out'
            out.mkdir()
            source = root / 'cycle2-conformance-comparison.json'
            source.write_text(json.dumps([{'event_directory': 'before-conformance-get405', 'score': 87.5}]))
            report.publish_analysis([source], out)
            value = json.loads((out / 'analysis' / source.name).read_text())
            self.assertIn('cycle-2', value['publication_note'])
            self.assertEqual(value['source_document'][0]['published_event_link'], '../preflight/product-fixes--before-conformance-get405/event.json')

    def test_finalized_run_is_immutable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trial = root / 'job' / 'trial'
            trial.mkdir(parents=True)
            (trial / 'result.json').write_text(json.dumps({'finished_at': '2026-11-15T00:00:00Z'}))
            out = root / 'out'
            (out / 'job--trial').mkdir(parents=True)
            with self.assertRaises(FileExistsError):
                report.publish_trial(trial, out)


if __name__ == '__main__':
    unittest.main()
