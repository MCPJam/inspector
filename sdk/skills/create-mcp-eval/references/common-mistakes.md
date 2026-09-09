## 7. Common Mistakes

### Forgetting `reporter.finalize()`
The reporter buffers results and uploads them in batch. If you don't call `finalize()` in `afterAll`, no results are sent. Always include:
```typescript
afterAll(async () => {
  if (!reporter || reporter.getAddedCount() === 0) return;
  await reporter.finalize();
}, 90_000);
```

### Expecting immediate UI visibility
`recordFromPrompt()` and the other `record*()` helpers buffer results, but
they do not guarantee an immediate save to MCPJam. A long-running file may not appear in
the UI until `flush()` or `finalize()` runs.

If you need the run to show up before the file completes, flush periodically:
```typescript
await reporter.recordFromPrompt(result, { caseTitle: "step-1", passed: true });
await reporter.flush();
```

### Not awaiting async methods
Every SDK method that talks to an LLM, MCP server, or reporting API is async. Missing `await` causes silent failures:
```typescript
// WRONG:
reporter.recordFromPrompt(result, { ... });

// CORRECT:
await reporter.recordFromPrompt(result, { ... });
```

### Low `maxSteps` on HostRunner
If the runner needs multiple tool calls to answer a prompt, a low `maxSteps` causes incomplete responses. Default to `8` for most servers, increase to `12-15` for complex workflows.

### Mixing save modes
Don't use both `reportEvalResults()` and a shared `EvalRunReporter` in the same file. Pick one approach:
- Use `createEvalRunReporter` for multi-test files (recommended)
- Use `reportEvalResults` for single one-off saves

### Missing test timeouts
LLM calls can take 10-30 seconds. Always set explicit timeouts on `it()` blocks:
```typescript
it("test name", async () => { ... }, 90_000);  // 90 seconds
```

### Creating multiple reporters
One reporter per test file. Creating multiple reporters results in multiple incomplete runs instead of one consolidated run saved to MCPJam.

### Incorrect `expectedIterations`
`expectedIterations` is not a rough estimate. It should exactly equal the total
number of eval results reported for the file.

Count:
- One result per `recordFromPrompt()`
- One result per iteration inside `recordFromRun()`
- One result per iteration inside `recordFromSuiteRun()`

If the count is wrong, the UI can show misleading progress for a run.

### Using `strict: false` without checking results
With `strict: false`, save failures are silently swallowed — a `console.warn` is emitted and `finalize()` returns a local fallback with an empty `runId`. Always check `output.runId` after finalize to confirm results were saved:
```typescript
const output = await reporter.finalize();
if (!output.runId) {
  console.error("Results were NOT saved to MCPJam — check baseUrl and apiKey");
}
```

---
