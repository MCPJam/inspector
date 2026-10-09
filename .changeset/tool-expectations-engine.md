---
"@mcpjam/evaluators": minor
---

Adds the tool-expectation engine: `compileToolExpectations` reads authored steps into per-turn tool-call assertions (step id, position, `minCount`, the assert's own `argumentMatching`), and `evaluateToolExpectations` / `evaluateTurnExpectations` / `evaluateAssertionAtPosition` grade a turn's calls once, through the matcher's own pairing, into one result per assertion plus the order, extra-call and "no tool" facts. Each turn also reports `matcherEquivalent`, today's matcher verdict, for comparison. `pairToolCalls` is now exported from `@mcpjam/evaluators/matchers`; `evaluateToolCalls` is unchanged and grades through it. Nothing calls the engine yet.
