"""Audited deterministic subset, never a substitute for MCPJam's evaluator.

Contracts: evaluators/src/predicates/types.ts (ArgMatcher, predicateSchema)
and evaluate.ts (toolCalledWith, toolCalledAtLeastOnce, toolResultContains,
responseContains, noToolErrors). Unknown fields/policies/comparators are refused
before execution. Tool arguments are restricted to this fixture's numeric add.
"""
import math


def nonempty(value):
    return isinstance(value, str) and bool(value)


def positive_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def supported(predicate):
    if not isinstance(predicate, dict):
        return False
    kind = predicate.get("type")
    fields = {
        "toolCalledAtLeastOnce": {"toolName"},
        "toolCalledWith": {"toolName", "args", "minCount"},
        "toolResultContains": {"toolName", "needle", "caseSensitive"},
        "responseContains": {"needle", "caseSensitive"},
        "noToolErrors": set(),
    }.get(kind)
    if fields is None or set(predicate) - fields - {"type", "role"}:
        return False
    # Advisory policy is deliberately unsupported: it must not become a gate.
    if predicate.get("role", "required") not in ("required", "gating"):
        return False
    if kind in ("toolCalledAtLeastOnce", "toolCalledWith") and not nonempty(predicate.get("toolName")):
        return False
    if "toolName" in predicate and not nonempty(predicate["toolName"]):
        return False
    if kind in ("toolResultContains", "responseContains"):
        if not nonempty(predicate.get("needle")):
            return False
        if "caseSensitive" in predicate and not isinstance(predicate["caseSensitive"], bool):
            return False
    if kind == "toolCalledWith":
        matcher = predicate.get("args")
        if not isinstance(matcher, dict) or set(matcher) - {"args", "argumentMatching"}:
            return False
        expected = matcher.get("args")
        if not isinstance(expected, dict) or set(expected) - {"a", "b"}:
            return False
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in expected.values()):
            return False  # Placeholder/nested matcher semantics are not simulated.
        if matcher.get("argumentMatching", "partial") not in ("partial", "exact", "ignore"):
            return False
        if not positive_integer(predicate.get("minCount", 1)):
            return False
    return True


def evaluate(predicate, calls):
    """Only call after supported(); None is never interpreted as a pass."""
    if not supported(predicate):
        return None
    kind = predicate["type"]
    scope = [c for c in calls if "toolName" not in predicate or c["toolName"] == predicate["toolName"]]
    if kind == "toolCalledAtLeastOnce":
        return bool(scope)
    if kind == "toolCalledWith":
        matcher = predicate["args"]
        expected = matcher["args"]
        mode = matcher.get("argumentMatching", "partial")
        def matches(call):
            actual = call["arguments"]
            if mode == "ignore":
                return True
            if mode == "exact":
                return actual == expected
            return all(k in actual and actual[k] == v for k, v in expected.items())
        return sum(matches(c) for c in scope) >= predicate.get("minCount", 1)
    if kind == "noToolErrors":
        return all(not c["result"]["isError"] for c in calls)
    if kind == "responseContains":
        # Canonical resolveFinalMessage returns "" when no assistant message
        # exists. A deterministic tool execution must not invent one.
        texts = [""]
    else:
        texts = [" ".join(part.get("text", "") for part in c["result"]["content"]) for c in scope]
    needle = predicate["needle"]
    if not predicate.get("caseSensitive", False):
        needle, texts = needle.lower(), [value.lower() for value in texts]
    return any(needle in value for value in texts)
