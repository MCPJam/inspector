# @mcpjam/evaluators

Pure assertions, trajectory matchers, evaluator contracts and bounded execution. The package does not depend on the SDK, MCP clients or model providers. Model judges can implement `Evaluator` with an injected runner; the SDK's built-in model judge remains available from `@mcpjam/sdk`.

```ts
import { assertion, runEvaluatorsProjected } from '@mcpjam/evaluators';

const results = await runEvaluatorsProjected(
  [assertion({ type: 'responseContains', needle: 'refund' })],
  {
    version: 1,
    scenario: { title: 'Explain the refund policy' },
    trace: { messages: [] },
    transcript: { toolCalls: [], finalAssistantMessage: 'Your refund is approved.' },
  },
);
```

`runEvaluators` preserves legacy `ScoreResult[]`. `runEvaluatorsProjected` returns canonical `EvaluatorResult[]`. Errors, skips and inapplicable outcomes carry no score. `toFeedbackEvaluator` and `toNamedEvaluator` adapt one canonical result to destination-shaped feedback, representing unscored outcomes as `null` with status metadata.

For generic messages use `normalizeMessages` and `runMessageEvaluators`. The normalizer recognizes text, tool-call/tool-result parts, tool_use/tool_result parts, and function tool calls. Unsupported input returns diagnostics without a transcript. A message array alone does not prove complete tool capture: provide `capture` only when your producer establishes it. `runMessageEvaluators` refuses tool-dependent evaluation from incomplete capture. Do not bypass that guard by passing a partially captured transcript directly to a negative assertion.

The normalization defaults are 1,000 messages and 4 MiB of serialized input. Oversized or malformed evidence is refused, not truncated into a pass. Provider output and MCP `isError` evidence remain separate from successful tool execution.

Tool-call expectations are graded one assertion at a time. `compileToolExpectations(steps, { matchOptions, isNegativeTest })` reads authored steps into per-turn `toolCalledWith` assertions, keeping each assert's step id, position, `minCount` and own `argumentMatching`. `evaluateToolExpectations(turns, callsByTurn, { skillToolsActive })` then grades every turn once, through the same pairing `evaluateToolCalls` uses (`pairToolCalls`), and reports one result per assertion (`passed`, `failureKind: "missing" | "arguments"`, the calls it was paired with) plus the turn's order, extra-call and "no tool" facts. Order is never a reason an assertion fails; it has its own row. `matcherEquivalent` on each turn is what `evaluateToolCalls` would say for the same turn, so a caller can compare the two. `evaluateAssertionAtPosition` grades one assertion over the calls a turn has made so far, which is what a fail-fast run needs.

Existing SDK imports remain compatibility exports of this implementation. Do not rely on object identity or `instanceof` across separately installed package copies. `internal/*` exports support SDK compatibility; use the root, `assertions`, or `matchers` entry for new consumers.

Run `npm run test:packaging:all -w @mcpjam/evaluators` to pack and install independent npm and pnpm consumers, execute assertions/matchers/adapters, verify declarations and prove SDK/provider packages are absent.
