from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gallery


class ErrorGalleryTests(unittest.TestCase):
    def test_docs_examples_do_not_become_observed_error_classes(self):
        docs = '## Error example\n{"error":{"code":"NOT_OBSERVED"}}\nSee the reference.\n'
        self.assertEqual(gallery.error_classes(docs, '', 0), [])
        native = '{"type":"item.completed","item":{"aggregated_output":"{\\"error\\":{\\"code\\":\\"NOT_OBSERVED\\"}}"}}'
        self.assertEqual(gallery.error_classes(native, '', 0), [])

    def test_actual_root_errors_and_nonzero_failures_are_preserved(self):
        error = '{"error":{"code":"FORBIDDEN","details":{"reason":"PLATFORM_FEE_REQUIRED"}}}'
        self.assertEqual(gallery.error_classes('', 'Using Cloud context\n' + error, 1), ['FORBIDDEN:PLATFORM_FEE_REQUIRED'])
        self.assertEqual(gallery.error_classes('{"isError":true,"content":[]}', '', 0), ['MCP_TOOL_ERROR'])
        self.assertEqual(gallery.error_classes('', '', 2), ['UNCLASSIFIED_NONZERO_EXIT'])
        self.assertEqual(gallery.error_classes('', '', None), [])

    def test_actual_failed_conformance_checks_have_distinct_classes(self):
        text = '{"kind":"protocol-conformance","passed":false,"groups":[{"cases":[{"id":"wire-schema-valid","status":"failed"},{"id":"initialized","status":"passed"}]}]}'
        self.assertEqual(gallery.error_classes(text, '', 1), ['CONFORMANCE:wire-schema-valid'])



if __name__ == '__main__':
    unittest.main()
