"""Canonical-field and false-positive controls for the bounded fixture subset."""
import copy
import unittest
from predicates import evaluate, supported
from platform_fixture import execute_cases
from service import tool_result


class PredicateTest(unittest.TestCase):
    def setUp(self):
        self.calls = [{"toolName": "add", "arguments": {"a": 2, "b": 3}, "result": tool_result("add", {"a": 2, "b": 3})}]

    def test_response_contains_never_mistakes_tool_text_for_assistant_message(self):
        # evaluate.ts resolveFinalMessage returns empty without an assistant.
        for needle in ("999", "5"):
            predicate = {"type": "responseContains", "needle": needle}
            self.assertTrue(supported(predicate))
            self.assertIs(evaluate(predicate, self.calls), False)

    def test_tool_result_contains_requires_correct_needle_and_scope(self):
        for needle, expected in (("5", True), ("999", False), ("SUM", True)):
            self.assertIs(evaluate({"type": "toolResultContains", "needle": needle}, self.calls), expected)
        self.assertIs(evaluate({"type": "toolResultContains", "needle": "SUM", "caseSensitive": True}, self.calls), False)
        self.assertIs(evaluate({"type": "toolResultContains", "needle": "5", "toolName": "other"}, self.calls), False)
        self.assertIs(evaluate({"type": "toolResultContains", "needle": "5"}, []), False)

    def test_call_assertions_use_nested_args_count_and_matching_mode(self):
        base = {"type": "toolCalledWith", "toolName": "add", "args": {"args": {"a": 2}}}
        self.assertIs(evaluate(base, self.calls), True)
        self.assertIs(evaluate({**base, "minCount": 2}, self.calls), False)
        self.assertIs(evaluate({**base, "minCount": 2}, self.calls * 2), True)
        self.assertIs(evaluate({**base, "args": {"args": {"a": 999}}}, self.calls), False)
        self.assertIs(evaluate({**base, "args": {"args": {"a": 2}, "argumentMatching": "exact"}}, self.calls), False)
        self.assertIs(evaluate({**base, "args": {"args": {"a": 2, "b": 3}, "argumentMatching": "exact"}}, self.calls), True)
        self.assertIs(evaluate({**base, "args": {"args": {"a": 999}, "argumentMatching": "ignore"}}, self.calls), True)
        for name, expected in (("add", True), ("other", False)):
            self.assertIs(evaluate({"type": "toolCalledAtLeastOnce", "toolName": name}, self.calls), expected)

    def test_no_tool_errors_reads_actual_result(self):
        self.assertIs(evaluate({"type": "noToolErrors"}, self.calls), True)
        bad = copy.deepcopy(self.calls)
        bad[0]["result"] = tool_result("add", {"a": "x", "b": 1})
        self.assertIs(evaluate({"type": "noToolErrors"}, bad), False)

    def test_missing_unknown_and_wrongly_typed_fields_are_never_a_pass(self):
        malformed = [None, {}, {"type": "unknown"},
            {"type": "responseContains"}, {"type": "responseContains", "text": "999"},
            {"type": "responseContains", "value": "999"}, {"type": "responseContains", "needle": ""},
            {"type": "toolResultContains", "needle": "5", "caseSensitive": "false"},
            {"type": "toolResultContains", "needle": "5", "toolName": ""},
            {"type": "toolCalledAtLeastOnce"}, {"type": "toolCalledAtLeastOnce", "toolName": "add", "args": {}},
            {"type": "toolCalledWith", "toolName": "add", "args": {"a": 2}},
            {"type": "toolCalledWith", "toolName": "add", "args": {"args": {"a": "number"}}},
            {"type": "toolCalledWith", "toolName": "add", "args": {"args": {}, "argumentMatching": "fuzzy"}},
            {"type": "toolCalledWith", "toolName": "add", "args": {"args": {}}, "minCount": 0},
            {"type": "toolCalledWith", "toolName": "add", "args": {"args": {}}, "minCount": True}]
        valid = [{"type": "responseContains", "needle": "5"}, {"type": "toolResultContains", "needle": "5"},
                 {"type": "toolCalledWith", "toolName": "add", "args": {"args": {}}},
                 {"type": "toolCalledAtLeastOnce", "toolName": "add"}, {"type": "noToolErrors"}]
        malformed += [{**p, "unknown": "must not be ignored"} for p in valid]
        malformed += [{**p, "role": "advisory", "severity": "warn"} for p in valid]
        for predicate in malformed:
            with self.subTest(predicate=predicate):
                self.assertFalse(supported(predicate))
                self.assertIsNone(evaluate(predicate, self.calls))

    def test_preflight_refuses_unsupported_semantics_before_any_tool_execution(self):
        invoked = []
        def execute(name, args):
            invoked.append(name)
            return tool_result(name, args)
        case = {"id": "one", "steps": [{"kind": "toolCall", "toolName": "add", "arguments": {"a": 2, "b": 3}},
                                         {"kind": "assert", "assertion": {"type": "responseContains", "text": "999"}}]}
        self.assertIsNone(execute_cases([case], execute))
        self.assertEqual(invoked, [])
        case["steps"].pop()
        case["checks"] = [{"type": "noToolErrors"}]
        self.assertIsNone(execute_cases([case], execute))
        self.assertEqual(invoked, [])


if __name__ == "__main__":
    unittest.main()
