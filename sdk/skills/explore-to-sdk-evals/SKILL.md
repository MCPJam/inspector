---
name: explore-to-sdk-evals
description: Convert MCPJam Explore-generated test cases into @mcpjam/sdk eval tests. Produces one test per case, exactly matching the user's prompts and expectations.
---

# explore-to-sdk-evals

## 1. Purpose

This skill converts **pre-existing MCPJam Explore test cases** (in the same document above, under `## Explore-generated test cases`)  into runnable **`@mcpjam/sdk`** eval tests.

**Rules:**

- **Generate exactly the cases provided** — do not invent new cases, do not skip any, do not reword user prompts (use the exact query text from each case’s fenced block).
- The brief above already includes `## Tools`, resources/prompts if any, suggested scenarios, and `## Explore-generated test cases` — parse titles, prompts, negative flags, expected tool-call shapes, and expected output from there.
- For full SDK API (advanced validators, suite patterns, error handling), see the **`create-mcp-eval`** skill in the MCPJam SDK or package documentation — this file stays minimal.

---

## 2. Framework detection

Before emitting imports, inspect the target repo:

1. Read **`package.json`**: `scripts` and `devDependencies` for **`jest`** or **`vitest`**.
2. Look for **`jest.config.*`**, **`vitest.config.*`**, or **`vite.config.*`** that references Vitest.

**Apply:**

| Condition | Imports / runner |
|-----------|------------------|
| Jest present | `describe`, `it`, `expect`, `beforeAll`, `afterAll` from `@jest/globals` (or rely on Jest globals); use **`ts-jest`** if TypeScript. |
| Vitest present (no Jest) | `import { describe, it, expect, beforeAll, afterAll } from "vitest"` |
| Neither present | **Default to Vitest** in generated scaffold (mention adding dep). |
| User explicitly wants no test framework | Use `EvalTest` / `EvalSuite` **`.run()`** in a plain `async function main()` script with manual assertions — no `describe`/`it`. |

---

## 3. Quick API reference (Explore flows only)

```typescript
import { MCPClientManager, TestAgent, createEvalRunReporter } from "@mcpjam/sdk";
import { matchNoToolCalls, matchToolCallWithPartialArgs } from "@mcpjam/sdk";
```

**Connection**

- `const manager = new MCPClientManager();`
- HTTP: `await manager.connectToServer(SERVER_ID, { url: MCP_SERVER_URL });`
- Stdio: `await manager.connectToServer(SERVER_ID, { command: "node", args: ["./server.js"] });`
- `const tools = await manager.getToolsForAiSdk([SERVER_ID]);`
- `await manager.disconnectAllServers();` in `afterAll`

**Agent**

- `new TestAgent({ tools, model: MODEL, apiKey: LLM_API_KEY, maxSteps: 8 })`
- `await agent.prompt(caseQuery)` — use **verbatim** `caseQuery` from Explore
- Multi-turn only if a **single** Explore case clearly requires follow-up in one narrative; otherwise one prompt per `it()` (see §4c)

**Result inspection**

- `result.hasToolCall("tool_name")`
- `result.toolsCalled()` — `string[]`
- `result.getToolCalls()` — for validators

**Validators**

- Negative: `matchNoToolCalls(result.toolsCalled())`
- Partial args: `matchToolCallWithPartialArgs("tool", { key: value }, result.getToolCalls())`

**Optional MCPJam upload**

- `createEvalRunReporter({ suiteName, apiKey, strict: true, ... })`
- `await reporter.recordFromPrompt(result, { caseTitle, passed, expectedToolCalls?, isNegativeTest? })`
- `await reporter.finalize()` in `afterAll` (with timeout)

---

## 4. Per-case translation

Use the **Explore case title** as the human-readable basis for `it("...")` description (sanitize quotes if needed). Use the **exact** user prompt from the ``` fenced block as `agent.prompt(\`...\`)` argument.

### 4a. Positive (expected tool calls, not negative)

For each expected tool line like `` `tool_name({arg: val})` ``:

```typescript
it("Explore case title here", async () => {
  const result = await agent.prompt(`paste exact query from Explore`);
  expect(result.hasToolCall("tool_name")).toBe(true);
  // When the brief shows specific args:
  expect(
    matchToolCallWithPartialArgs(
      "tool_name",
      { arg: val },
      result.getToolCalls(),
    ),
  ).toBe(true);
  if (reporter) {
    await reporter.recordFromPrompt(result, {
      caseTitle: "Explore case title here",
      passed: result.hasToolCall("tool_name"),
      expectedToolCalls: [{ toolName: "tool_name" }],
    });
  }
}, 90_000);
```

### 4b. Negative test (`**Negative test:**` / NEG-style case)

```typescript
it("Explore case title here", async () => {
  const result = await agent.prompt(`paste exact query from Explore`);
  expect(matchNoToolCalls(result.toolsCalled())).toBe(true);
  if (reporter) {
    await reporter.recordFromPrompt(result, {
      caseTitle: "Explore case title here",
      passed: matchNoToolCalls(result.toolsCalled()),
      isNegativeTest: true,
    });
  }
}, 90_000);
```

### 4c. Multiple expected tools in one Explore case

Prefer **one** `it()` that asserts all listed tools (unless the case text explicitly describes a conversation turn — then use `context: r1` for the second `prompt`).

```typescript
it("Explore case title", async () => {
  const result = await agent.prompt(`exact query`);
  expect(result.hasToolCall("first_tool")).toBe(true);
  expect(result.hasToolCall("second_tool")).toBe(true);
  // Optional: partial arg checks per tool using matchToolCallWithPartialArgs
}, 90_000);
```

Do **not** merge two separate Explore cases into one `it()` — **one Explore case → one `it()`** unless the plan above explicitly allows multi-tool-in-one-case as above.

---

## 5. Scaffold template

**Provider (required):** Same rule as **`create-mcp-eval`** — **ask** which LLM provider / model / env var before generating code; never silently pick a default provider.

Use **connection** from the brief blockquote (`Connection:` or `Connection (stdio):`) for `MCP_SERVER_URL` or the joined command string.

```typescript
// ─── Config ─────────────────────────────────────────────────────────────────
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "<from brief>";
const LLM_API_KEY = process.env.<PROVIDER_ENV>!;
const MODEL = process.env.EVAL_MODEL ?? "<provider/model>";
const SERVER_ID = "<server id from brief # MCP Server Brief: name>";
const MCPJAM_API_KEY = process.env.MCPJAM_API_KEY;
const RUN_LLM_TESTS = Boolean(LLM_API_KEY && MCP_SERVER_URL);
```

```typescript
let manager: MCPClientManager;
let agent: TestAgent;
let reporter: ReturnType<typeof createEvalRunReporter> | undefined;

beforeAll(async () => {
  manager = new MCPClientManager();
  await manager.connectToServer(SERVER_ID, { url: MCP_SERVER_URL });
  const tools = await manager.getToolsForAiSdk([SERVER_ID]);
  agent = new TestAgent({ tools, model: MODEL, apiKey: LLM_API_KEY, maxSteps: 8 });
  if (MCPJAM_API_KEY) {
    reporter = createEvalRunReporter({
      suiteName: "Explore-exported evals",
      apiKey: MCPJAM_API_KEY,
      strict: true,
      serverNames: [SERVER_ID],
      expectedIterations: <count Explore cases with reporter records>,
    });
  }
}, 90_000);

afterAll(async () => {
  await manager?.disconnectAllServers();
  if (reporter?.getAddedCount()) {
    await reporter.finalize();
  }
}, 90_000);

(RUN_LLM_TESTS ? describe : describe.skip)("Explore cases", () => {
  // one it() per Explore case — §4
});
```

Set **`expectedIterations`** to the exact number of `recordFromPrompt` / iteration records you emit (same contract as `create-mcp-eval`).

---

## 6. Operational reminders

- **`it(..., 90_000)`** on every async test; **120_000** only if genuinely multi-turn-heavy.
- **`await`** every `agent.prompt`, `reporter.record*`, `reporter.finalize`, `connectToServer`, `disconnectAllServers`.
- **One reporter per file**; **`finalize()` in `afterAll`** with a generous timeout.
- **`maxSteps: 8`** on `TestAgent` unless the Explore case implies a longer tool chain.
- Wrap LLM suites with **`(RUN_LLM_TESTS ? describe : describe.skip)`** so CI without secrets skips cleanly.

---

## 7. Explicit non-goal

Full **`@mcpjam/sdk`** encyclopedia, project greenfield setup, and long-form templates — use the **`create-mcp-eval`** skill for that.
