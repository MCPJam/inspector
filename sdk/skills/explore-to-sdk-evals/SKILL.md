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
import {
  matchNoToolCalls,
  matchToolCallWithPartialArgs,
  matchToolArgument,
  matchToolArgumentWith,
} from "@mcpjam/sdk";
```

**Connection**

- `const manager = new MCPClientManager();`
- HTTP: `await manager.connectToServer(SERVER_ID, { url: MCP_SERVER_URL });`
- Stdio: `await manager.connectToServer(SERVER_ID, { command: "node", args: ["./server.js"] });`
- `const tools = await manager.getToolsForAiSdk([SERVER_ID]);`
- `await manager.disconnectAllServers();` in `afterAll`

**Agent**

- `new TestAgent({ tools, model: MODEL, apiKey: LLM_API_KEY, maxSteps: 8 })` — **`apiKey` and `model` must match the LLM provider the user chose** (see §5); there is no default assumption that the key is an OpenAI key.
- `await agent.prompt(caseQuery)` — use **verbatim** `caseQuery` from Explore; for slow MCP + multi-step chains use **`{ timeoutMs }`** (or `timeout`) so the prompt does not abort before tools finish (see §6).
- Multi-turn only if a **single** Explore case clearly requires follow-up in one narrative; otherwise one prompt per `it()` (see §4c)

**Result inspection**

- `result.hasToolCall("tool_name")`
- `result.toolsCalled()` — `string[]`
- `result.getToolCalls()` — for validators

**Validators**

- Negative: `matchNoToolCalls(result.toolsCalled())`
- Partial args: `matchToolCallWithPartialArgs("tool", { key: value }, result.getToolCalls())` — use only when those values are **real literals** from Explore, not placeholders (§4).
- Single-arg exact / predicate: `matchToolArgument`, `matchToolArgumentWith` (see **`create-mcp-eval`** / SDK validators).

**Optional MCPJam upload**

- `createEvalRunReporter({ suiteName, apiKey, strict: true, ... })`
- `await reporter.recordFromPrompt(result, { caseTitle, passed, expectedToolCalls?, isNegativeTest? })`
- `await reporter.finalize()` in `afterAll` (with timeout). **`finalize()` can throw** (network, DNS, 401) even when all eval assertions passed. For best-effort upload: wrap in **try/catch**, log a warning, and continue; or gate uploads on something like **`MCPJAM_REPORTING=1`** so local/CI runs do not go red purely on reporting.

---

## 4. Per-case translation

Use the **Explore case title** as the human-readable basis for `it("...")` description (sanitize quotes if needed). Use the **exact** user prompt from the ``` fenced block as `agent.prompt(\`...\`)` argument.

**Placeholder values in `tool_name({ ... })` lines:** Explore often shows **illustrative** arguments — e.g. `create_view({ elements: "" })` usually means **“this argument key exists / this shape,”** not “the value must be the empty string.” Blindly passing `{ elements: "" }` into `matchToolCallWithPartialArgs` will fail on real calls. **Prefer `hasToolCall("tool_name")`** when the brief does not state a concrete literal. When you need stricter checks: use **`matchToolArgumentWith("tool", "key", predicate, calls)`** (e.g. “present and non-empty”), or **`matchToolArgument`** only when Explore documents an **actual** expected value. Reserve **`matchToolCallWithPartialArgs`** for **real literals** listed in the case, not for `""`, `"..."`, or other stand-ins.

### 4a. Positive (expected tool calls, not negative)

For each expected tool line like `` `tool_name({arg: val})` ``:

```typescript
it("Explore case title here", async () => {
  const result = await agent.prompt(`paste exact query from Explore`);
  expect(result.hasToolCall("tool_name")).toBe(true);
  // Only when Explore lists real literals — not placeholders (see §4 intro).
  // expect(
  //   matchToolCallWithPartialArgs("tool_name", { arg: literalVal }, result.getToolCalls()),
  // ).toBe(true);
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
  // Optional: arg checks only for real literals (§4) — else hasToolCall is enough
}, 90_000);
```

Do **not** merge two separate Explore cases into one `it()` — **one Explore case → one `it()`** unless the plan above explicitly allows multi-tool-in-one-case as above.

---

## 5. Scaffold template

### 5a. Required environment variables — ask the user before generating code

**Do not emit the full scaffold until the user has supplied values (or explicit env var names) for everything needed to run the evals locally and in CI.**

1. **Prompt the user** for each required variable below. If they prefer names only, use placeholders like `process.env.ANTHROPIC_API_KEY` and document those names in a short comment or README snippet in the same response — but the skill’s default is to **confirm what must be set**, not to guess secrets.

| Concern | Typical env vars (examples only — not exhaustive) | Notes |
|--------|-----------------------------------------------------|--------|
| MCP reachability | `MCP_SERVER_URL`, or stdio `command` / `args` from the brief | Always align with the brief’s `Connection:` / `Connection (stdio):`. |
| LLM credential | **Provider-specific** — e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `AZURE_OPENAI_API_KEY`, or a key your codebase already uses | **`OPENAI_API_KEY` is one option, not the assumed default.** Ask which provider and model they use, then wire `apiKey` and `EVAL_MODEL` (or equivalent) to **that** provider’s SDK expectations. |
| Model string | `EVAL_MODEL` or provider’s convention | Must match the chosen provider’s model id format. |
| Optional MCPJam upload | `MCPJAM_API_KEY` | Omit reporter wiring if not provided. |

2. **Never imply OpenAI-only copy:** avoid phrasing like “paste your OpenAI key” unless the user already said OpenAI. Default language: **“which LLM provider and API key env var are you using?”**

3. Same rule as **`create-mcp-eval`**: **ask** which LLM provider, model, and env var name before generating code; **never silently default** to a single vendor.

4. **Required assistant output (before codegen):** After the user answers, echo an explicit **env contract** so the model cannot “skip” to OpenAI-flavored code without mirroring what was agreed:

```text
Env contract (confirmed — use in generated file):
- provider: <e.g. anthropic | openai | google | azure | other>
- EVAL_MODEL: <exact model id string>
- LLM API key env var: <e.g. ANTHROPIC_API_KEY>
- MCP: <MCP_SERVER_URL and any other vars, or stdio command source>
- Optional reporting: MCPJAM_API_KEY present? <yes|no>; fail run on finalize error, or try/catch + warn; optional gate MCPJAM_REPORTING=1? <as agreed>
```

Do not generate the eval file until this block is filled from **user-provided** choices (not inferred defaults).

### 5b. Template (after env contract is clear)

Use **connection** from the brief blockquote (`Connection:` or `Connection (stdio):`) for `MCP_SERVER_URL` or the joined command string.

```typescript
// ─── Config ─────────────────────────────────────────────────────────────────
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "<from brief>";
// Replace <PROVIDER_ENV> with the env var the user named (e.g. ANTHROPIC_API_KEY, not only OPENAI_API_KEY).
const LLM_API_KEY = process.env.<PROVIDER_ENV>!;
const MODEL = process.env.EVAL_MODEL ?? "<provider/model>";
const SERVER_ID = "<server id from brief # MCP Server Brief: name>";
const MCPJAM_API_KEY = process.env.MCPJAM_API_KEY;
// See §5c: put `import "dotenv/config"` first in this file (or use Vitest setupFiles) so
// RUN_LLM_TESTS sees .env in workers — config-only dotenv is unreliable.
const RUN_LLM_TESTS = Boolean(LLM_API_KEY && MCP_SERVER_URL);
```

**Hooks and `RUN_LLM_TESTS`:** File-level **`beforeAll` / `afterAll` run even when a later `describe` is `.skip`ped** (Vitest does this; **Jest can behave similarly** depending on suite structure). That can still hit the MCP when you meant “no API key → skip everything.” **Nest `beforeAll` / `afterAll` inside the same `describe` block** that is toggled with `(RUN_LLM_TESTS ? describe : describe.skip)`, so skipped suites do not connect. (Alternative: a single file-level `beforeAll` that starts with `if (!RUN_LLM_TESTS) return;` — but nesting is clearer.)

```typescript
(RUN_LLM_TESTS ? describe : describe.skip)("Explore cases", () => {
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
  }, 120_000);

  afterAll(async () => {
    await manager?.disconnectAllServers();
    if (reporter?.getAddedCount()) {
      try {
        await reporter.finalize();
      } catch (e) {
        console.warn("MCPJam reporter finalize failed (non-fatal):", e);
      }
    }
  }, 120_000);

  // one it() per Explore case — §4
});
```

Set **`expectedIterations`** to the exact number of `recordFromPrompt` / iteration records you emit (same contract as `create-mcp-eval`). Teams that want **no upload attempts** unless explicitly enabled can guard `createEvalRunReporter` with e.g. **`MCPJAM_REPORTING=1`**. Omit the **try/catch** around `finalize` if reporting failures must fail the run; **document** the choice in the env contract (§5a.4).

### 5c. `.env` files and Vitest workers

`RUN_LLM_TESTS = Boolean(process.env…)` at **module top level** often runs **before** `process.env` is populated if **`dotenv` only loads inside `vitest.config.ts`** (config runs in a different context than test workers; evals then look “always skipped”).

**Mitigations (pick one or combine):**

- Add **`import "dotenv/config"`** (or project equivalent) as the **first import** in the eval test file so workers see secrets before `RUN_LLM_TESTS` is computed.
- Set Vitest **`test.setupFiles`** (or **`setupFiles`**) to a small module that loads `.env` before any test file body runs.
- In CI, inject secrets via the runner env (no `.env`); locally, prefer **setupFiles** over relying on config-time dotenv alone.

Optionally: **fail loudly** in dev when vars are missing (`throw` or `describe` with one `it` that explains what to export) instead of only `describe.skip`, if that matches the team’s expectation.

---

## 6. Operational reminders

- **Default `it(..., 90_000)`** per test. Use **`120_000`–`180_000`** and a matching **`agent.prompt(..., { timeoutMs: ... })`** when the brief implies **streaming, animation, slow MCP, or long multi-tool** runs (wall-clock often exceeds 90s end-to-end). Raise **`beforeAll` / `afterAll` hook timeouts** in Vitest if hooks approach default limits (`hookTimeout` in config or per-hook timeout argument).
- **`await`** every `agent.prompt`, `reporter.record*`, `reporter.finalize`, `connectToServer`, `disconnectAllServers`.
- **One reporter per file**; **`finalize()` in `afterAll`** with a generous timeout — and treat upload as **non-fatal** when agreed (§3, §5b).
- **`maxSteps: 8`** on `TestAgent` unless the Explore case implies a longer tool chain.
- Wrap LLM suites with **`(RUN_LLM_TESTS ? describe : describe.skip)`** and **nest lifecycle hooks inside that `describe`** (§5b) so skipped runs do not connect to the MCP.
- If the user has not yet listed required env vars, **stop and ask** for them (§5a) before producing runnable files; emit the **env contract** block (§5a.4) before codegen.

---

## 7. Explicit non-goal

Full **`@mcpjam/sdk`** encyclopedia, project greenfield setup, and long-form templates — use the **`create-mcp-eval`** skill for that.
