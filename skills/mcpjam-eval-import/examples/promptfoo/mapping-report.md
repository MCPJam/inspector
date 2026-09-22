# Mapping report — promptfooconfig.yaml → suite.yaml

Source: `promptfooconfig.yaml` (promptfoo config, 4 tests)
Output: `suite.yaml` (`s_billing_promptfoo_import`, 4 cases, 1 enabled)
Converter: an agent following `skills/mcpjam-eval-import`

Every source test produced exactly one MCPJam case. No source test was dropped,
and no case was invented. Prompts were interpolated from `vars` into the single
`prompts` template (`{{query}}`), which is the only normalization applied.

| Source test | Case | Status | Why |
|---|---|---|---|
| refunds a duplicate charge | `c_refunds_duplicate_charge` | `exact` | PF-1, PF-2, PF-3, PF-5: single prompt template, one var substituted, `contains` → `responseContains` (case-sensitive, as promptfoo compares), `regex` → `responseMatches` with the pattern copied verbatim. Nothing else in the test. |
| quotes the account balance | `c_quotes_account_balance` | `approximated` | `llm-rubric` is a model-graded rubric with no deterministic predicate. The rubric text was carried into `expectedOutput` for judge scoring, which grades differently from promptfoo's rubric. Disabled pending human review. |
| looks up the invoice before answering | `c_looks_up_invoice` | `unresolved` | The `javascript` assertion asserts a tool call by name. `toolCalledAtLeastOnce` has those semantics, but `lookup_invoice` was never resolved against the target server's live discovery. Offline `eval validate` does not resolve tool names, and an ASSERTION is not a deterministic reference — so neither the offline check nor `--project` will settle this one. Disabled until a human confirms the tool exists. |
| refuses to delete an invoice | `c_refuses_delete` | `unsupported` | The `javascript` assertion calls `checkAuditLog(context)`, a repo helper whose behavior lives in executable code that was deliberately not run. No MCPJam predicate represents it. The prompt is kept so a human can re-author the assertion; the assertion itself was not guessed. Disabled. |

## Not represented

- `providers: openai:gpt-4o-mini` — the suite's `defaults.model` is the MCPJam
  model id an operator chooses; the source provider id was not translated.
- `checkAuditLog` and every other helper in the source repo. Source code was
  read as text and never executed.
