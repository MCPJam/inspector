# Recipe: pytest

Recognize ordinary Python test files (`test_*.py`, `*_test.py`) containing
`def test_*`, `async def test_*`, `@pytest.mark.parametrize`, fixtures and
`assert`. Read the syntax as text. **Never import the module, collect pytest,
install requirements, evaluate decorators, call fixtures or run tests.**

## Structural rules

| Rule | Licenses `exact` only when |
| --- | --- |
| PY-1 | One statically visible test function, or one literal parametrized row, becomes one case. Dynamic parametrization is not exact. |
| PY-2 | Prompt/input is a literal string or a literal parameter value copied verbatim. A fixture, helper, f-string expression or runtime builder is `unresolved`. |
| PY-3 | A plain literal assertion maps identically: `needle in response` → `responseContains` (case-sensitive); `re.search(r"p", response)` → `responseMatches`; `response`/`response.strip()` truthiness → `finalAssistantMessageNonEmpty`. |
| PY-4 | A literal mock-call assertion maps to the same tool predicate only when the mock represents the MCP tool call and its name/args are explicit and discovery-confirmed. Otherwise it is `unresolved` or `unsupported`. |
| PY-5 | No fixture, monkeypatch, setup/teardown, mark, snapshot, exception expectation, helper assertion or side effect contributes to the verdict. |

Fixtures and helpers are code. If their value exists only after execution, use
`unresolved`; if their executable behavior is itself the assertion, use
`unsupported`. Do not guess what they return from their names.

`sourceCaseKey`: `<repo-relative path>::<test function>` and append the literal
param id/index for parametrized rows.

## Before

```python
@pytest.mark.parametrize(
    ("query", "needle"),
    [("Refund invoice 4471.", "refunded")],
)
def test_refund(query, needle):
    response = assistant(query)
    assert needle in response
```

## After

```yaml
- id: c_test_refund_0
  title: test_refund [0]
  steps:
    - id: step-1
      kind: prompt
      prompt: Refund invoice 4471.
  assertions:
    - type: responseContains
      needle: refunded
      caseSensitive: true
  import:
    status: exact
    sourceCaseKey: tests/test_billing.py::test_refund[0]
    note: PY-1/PY-2/PY-3/PY-5 — one literal param row; prompt and case-sensitive containment copied; no fixture, hook or helper affects the verdict.
```

If `assistant(query)` hides a custom provider, system prompt or tool fixture
that materially changes the test, PY-5 fails: keep the useful prompt mapping,
mark it `approximated`, and disable it pending review. A source assertion such as
`assert validate_refund(response, db)` is `unsupported`; do not translate the
helper name into a rubric.
