---
name: create-mcp-eval
description: Generate comprehensive eval tests for any MCP server using @mcpjam/sdk. Supports Jest and Vitest with deterministic and LLM-driven test patterns.
---

# create-mcp-eval

Generate eval tests for MCP servers using **@mcpjam/sdk**.

Read this file first. It carries the two things you need before writing any code — what to ask the user, and the rules the generated tests must follow — and routes you to the rest only when you actually need it.

## Reference map

Load a reference when you reach the step that needs it, not before.

| You are about to… | Read |
|---|---|
| Scaffold `package.json`, `tsconfig.json`, `.env.example`, `.gitignore` | `references/project-setup.md` |
| Call `MCPClientManager`, `HostRunner`, `PromptResult`, `EvalTest`, `EvalSuite`, validators, or the MCPJam reporter | `references/sdk-api.md` |
| Choose a shape — config block, toggled suites, shared reporter, parameterized agents, save modes, multi-turn, validator coverage | `references/patterns.md` |
| Write the file out | `references/template.md` |
| Debug a test that runs but behaves oddly | `references/common-mistakes.md` |
| Turn an MCPJam **Agent Brief** into tests | `references/agent-brief.md` |

## 1. Context Gathering

Before generating any code, collect the following from the user:

| Question | Options | Default |
|----------|---------|---------|
| **Connection type** | `stdio` (local binary) or `http` (SSE/Streamable HTTP URL) | `http` |
| **Test framework** | `jest`, `vitest`, or `none` (SDK-only) | _(detect from repo; fall back to `vitest`)_ |
| **LLM provider** | See Supported Providers table below. Format: `provider/model` | _(must ask user)_ |
| **Save results to MCPJam** | `none`, `auto` (saves when MCPJAM_API_KEY is set), or `reporter` (shared EvalRunReporter). Use an MCPJam API key (`sk_…`) from **Settings → API keys**; optionally set `MCPJAM_PROJECT_ID` to file results under a specific project (defaults to the org’s Default project). | _(must ask user)_ |
| **Tool list** | Ask user to paste their tool names or an **Agent Brief** (`references/agent-brief.md`) | — |

If the user provides an **Agent Brief** (markdown with `## Tools` table), parse it to auto-populate tool names, descriptions, parameters, and suggested eval scenarios. See `references/agent-brief.md`.

### Provider Selection (REQUIRED)

You MUST ask the developer which LLM provider they want before generating any code. Do not default to any provider.

**Supported Providers:**

| Provider | Model format | Env var | Example model |
|----------|-------------|---------|---------------|
| `openai` | `openai/<model>` | `OPENAI_API_KEY` | `openai/gpt-4o-mini` |
| `anthropic` | `anthropic/<model>` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-20250514` |
| `google` | `google/<model>` | `GOOGLE_API_KEY` | `google/gemini-2.0-flash` |
| `mistral` | `mistral/<model>` | `MISTRAL_API_KEY` | `mistral/mistral-small-latest` |
| `deepseek` | `deepseek/<model>` | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat` |
| `xai` | `xai/<model>` | `XAI_API_KEY` | `xai/grok-2` |
| `openrouter` | `openrouter/<model>` | `OPENROUTER_API_KEY` | `openrouter/openai/gpt-4o-mini` |
| `azure` | `azure/<deployment>` | `AZURE_API_KEY` | `azure/gpt-4o` |
| `ollama` | `ollama/<model>` | _(none, local)_ | `ollama/llama3` |
| Custom | `<name>/<model>` | _(configurable)_ | `litellm/gpt-4` |

Once the user selects a provider, use the corresponding env var name and model format in all generated code:
- `{LLM_ENV_VAR}` — e.g., `OPENAI_API_KEY`
- `{LLM_MODEL}` — e.g., `openai/gpt-4o-mini`
- `{LLM_KEY_EXAMPLE}` — e.g., `sk-...`

### Test Runner Selection

Before generating tests, check what the codebase already uses:

- `package.json` scripts and devDependencies for `jest` or `vitest`
- Config files: `jest.config.*`, `vitest.config.*`, `vite.config.*`

Then:
- If Jest is present, use Jest (and `ts-jest` if TypeScript).
- If Vitest is present, use Vitest.
- If neither is present, default to Vitest.
- If the developer prefers **no test framework**, the `@mcpjam/sdk` classes (`EvalTest`, `EvalSuite`) can run standalone — call `.run()` directly and check results in a plain script without Jest/Vitest.

In all cases, use `@mcpjam/sdk` for the eval harness (`HostRunner`, `EvalTest`, `EvalSuite`, validators).

---

---

## 5. Generation Guidelines

Follow these rules when generating eval test files:

1. **Deterministic suite first** — always include a deterministic test section using `HostRunner.mock()` that validates the test structure itself without requiring LLM calls or server connections.

2. **One EvalTest per tool** — create a separate `EvalTest` for each tool you want to evaluate. Each test should prompt the runner with a natural-language request and assert the correct tool was selected.

3. **Single-shot LLM tests are non-deterministic** — a single `runner.run()` may not select the expected tool every time. For single-shot tests, prefer saving results to MCPJam without hard-asserting (`expect(...).toBe(true)`). Use `EvalTest` with `iterations >= 3` and assert on `accuracy()` for reliable pass/fail gates. Reserve hard asserts for high-confidence cases (negative tests, multi-turn with clear context).

4. **Write unambiguous prompts for similar tools** — when a server has tools with overlapping descriptions (e.g., `create_view` vs `export_to_excalidraw`), prompts must reference the tool's *unique* action. Mention specific verbs, targets, or outcomes. Bad: "Share my diagram". Good: "Export and upload my diagram to excalidraw.com so I can open it in a browser".

5. **Multi-turn for related tools** — when tools logically chain together (e.g., `get_user` then `list_workspaces`), create a multi-turn test using `{ context: previousResult }`.

6. **Negative test** — always include at least one test that verifies the runner does NOT call tools when given an irrelevant prompt (e.g., "What is the capital of France?"). Use `matchNoToolCalls()`.

7. **Reasonable defaults**:
   - `iterations: 5` for EvalTest runs
   - `timeoutMs: 60_000` for LLM tests
   - `maxSteps: 8` for HostRunner
   - `retries: 1` for flaky network tolerance
   - `concurrency: 5` (default, no need to set explicitly)

8. **Timeout on test cases** — set explicit timeouts on `it()` blocks: `90_000` for single-turn, `120_000` for multi-turn and suite tests.

9. **Always `await`** — every `runner.run()`, `test.run()`, `suite.run()`, `reporter.record*()`, and `reporter.finalize()` is async. Never forget `await`.

10. **One reporter per file** — create the reporter at module level to save results to MCPJam, and finalize in `afterAll`. Never create multiple reporters in the same file.

11. **Use `describe.skip` for missing credentials** — wrap LLM tests in conditional describe blocks so CI runs cleanly without secrets.

12. **Match the repo's test runner** — check `package.json` and config files for an existing test framework before generating. Only default to Vitest if the repo has no test runner. If the user prefers no framework at all, use `@mcpjam/sdk` classes (`EvalTest.run()`, `EvalSuite.run()`) standalone in a plain script.

13. **Log key metrics** — add `console.log` statements for accuracy, tool calls, and latency so CI output is informative.
