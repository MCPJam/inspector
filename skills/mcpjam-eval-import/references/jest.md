# Recipe: Jest / Vitest

Recognize `.test.js`, `.spec.ts` and siblings containing `test`/`it`,
`describe`, `test.each`, `expect` matchers and mocks. Vitest has the same mapping
rules. Read the source text only: do not import it, run Node, install packages,
execute setup files or update snapshots.

## Structural rules

| Rule | Licenses `exact` only when |
| --- | --- |
| JS-1 | One `test`/`it`, or one literal `test.each` row, becomes one case. Dynamically generated tests are not exact. |
| JS-2 | The prompt is a string literal/template with only literal row substitutions. Runtime builders, fixtures and imported constants are `unresolved`. |
| JS-3 | `expect(response).toContain("x")` → case-sensitive `responseContains`; `expect(response).toMatch(/p/)` → `responseMatches` with the source regex pattern. Flags or JS regex semantics that are not representable make it `approximated`. |
| JS-4 | A `toHaveBeenCalledWith`/`toHaveBeenCalled` mock assertion maps to the same tool predicate only when the mock is explicitly the MCP tool, args match exactly, and live discovery confirms the name. Otherwise `unresolved`. |
| JS-5 | No `before*`/`after*`, custom matcher, snapshot, fake timer, module mock, retry, imported fixture or side effect contributes to the verdict. |

`sourceCaseKey`: `<repo-relative path>::<describe chain>::<test title>` and append
the literal `test.each` row index or title expansion.

## Before

```ts
test.each([
  ["Refund invoice 4471.", "refunded"],
])("refunds: %s", async (prompt, needle) => {
  const response = await assistant(prompt);
  expect(response).toContain(needle);
});
```

## After

```yaml
- id: c_refunds_0
  title: "refunds: Refund invoice 4471."
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
    sourceCaseKey: "tests/billing.test.ts::refunds: %s[0]"
    note: JS-1/JS-2/JS-3/JS-5 — one literal each row; prompt and containment copied; no hook, fixture, custom matcher or snapshot changes the verdict.
```

`toMatchSnapshot`, inline snapshots, custom matchers and arbitrary callback
predicates are `unsupported`: MCPJam does not have a snapshot-diff predicate and
you may not execute them. If setup supplies a system prompt or mock tool surface,
the visible prompt may still be useful, but the case is `approximated` and
disabled because the execution environment was lost.
