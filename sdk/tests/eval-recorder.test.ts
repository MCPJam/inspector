import { describe, it, expect, vi, afterEach } from "vitest";
import { createEvalRecorder } from "../src/eval-recorder.js";
import { MCPClientManager } from "../src/mcp-client-manager/MCPClientManager.js";
import { reportEvalResults } from "../src/report-eval-results.js";
function setup(operation: (...args: any[]) => Promise<any> = async () => ({ content: [], structuredContent: { count: 2 } })) {
  const manager = new MCPClientManager();
  vi.spyOn(manager as any, "executeToolUnrecorded").mockImplementation(operation);
  return { manager, recorder: createEvalRecorder({ mcpClientManager: manager }) };
}
const trace = (result: any) => result.trace as { messages: any[]; spans: any[] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("eval recorder", () => {
  it("snapshots full inputs/results, preserves return values, and detaches results", async () => {
    const response = { content: [{ type: "text", text: "coffee" }], structuredContent: { count: 2 }, isError: false, _meta: { custom: "value" } };
    const { manager, recorder } = setup(async () => response);
    const args = { query: "coffee" };
    expect(await recorder.runCase({ caseTitle: "coffee", caseId: "coffee" }, async () => {
      const result = await manager.executeTool("amazon", "search", args);
      args.query = "changed"; response.structuredContent.count = 99;
      return result;
    })).toBe(response);
    const [result] = recorder.getResults();
    expect(result).toMatchObject({ passed: true, caseId: "coffee", actualToolCalls: [{ toolName: "search", arguments: { query: "coffee" } }] });
    const t = trace(result);
    expect(t.messages[1].content[0].output.value).toMatchObject({ content: response.content, structuredContent: { count: 2 }, _meta: response._meta });
    expect(t.messages[0].content[0].toolCallId).toBe(t.messages[1].content[0].toolCallId);
    expect(t.spans[0]).toMatchObject({ serverId: "amazon", status: "ok" });
    result.actualToolCalls![0].arguments!.query = "mutated snapshot";
    expect(recorder.getResults()[0].actualToolCalls![0].arguments!.query).toBe("coffee");
  });
  it("isolates concurrent cases and excludes other managers/outside calls", async () => {
    const { manager, recorder } = setup();
    const other = setup().manager;
    await manager.executeTool("a", "outside");
    const gate = deferred<void>();
    await Promise.all([
      recorder.runCase({ caseTitle: "first" }, async () => { await gate.promise; await manager.executeTool("one", "same", { id: 1 }); await other.executeTool("other", "excluded"); }),
      recorder.runCase({ caseTitle: "second" }, async () => { await manager.executeTool("two", "same", { id: 2 }); gate.resolve(); }),
    ]);
    for (const [title, id] of [["first", 1], ["second", 2]] as const) expect(recorder.getResults().find(r => r.caseTitle === title)?.actualToolCalls).toEqual([{ toolName: "same", arguments: { id } }]);
  });
  it("preserves callback errors and records caught tool failures independently", async () => {
    const toolError = Object.assign(new Error("tool broke"), { code: -32000 });
    const { manager, recorder } = setup(async () => { throw toolError; });
    const assertion = new Error("expected 3, got 2");
    await expect(recorder.runCase({ caseTitle: "assertion" }, async () => { await expect(manager.executeTool("a", "broken")).rejects.toBe(toolError); throw assertion; })).rejects.toBe(assertion);
    await recorder.runCase({ caseTitle: "expected error" }, async () => { await expect(manager.executeTool("a", "broken")).rejects.toBe(toolError); });
    expect(recorder.getResults().map(r => r.passed)).toEqual([false, true]);
    expect(recorder.getResults()[0].error).toBe(assertion.message);
    expect(trace(recorder.getResults()[0]).messages[1].content[0].output).toEqual({ type: "error-json", value: { message: "tool broke", code: -32000 } });
  });
  it("retains isError without failing a callback and pairs repeated tools across servers", async () => {
    const { manager, recorder } = setup(async () => ({ content: [], isError: true }));
    await recorder.runCase({ caseTitle: "negative" }, async () => { await manager.executeTool("a", "same"); await manager.executeTool("b", "same"); });
    const [row] = recorder.getResults();
    expect(row.passed).toBe(true);
    expect(trace(row).spans.map(s => s.status)).toEqual(["error", "error"]);
    expect(new Set(trace(row).spans.map(s => s.id)).size).toBe(2);
  });
  it("records empty/repeated cases with unique IDs and rejects nested cases", async () => {
    const { recorder } = setup();
    await recorder.runCase({ caseTitle: "empty", caseId: "same" }, () => 42);
    await recorder.runCase({ caseTitle: "empty", caseId: "same" }, () => undefined);
    expect(new Set(recorder.getResults().map(r => r.externalIterationId)).size).toBe(2);
    expect(recorder.getResults()[0]).toMatchObject({ actualToolCalls: [], metadata: { captureCompleteness: "complete" } });
    await expect(recorder.runCase({ caseTitle: "outer" }, () => recorder.runCase({ caseTitle: "inner" }, () => undefined))).rejects.toThrow("Nested");
  });
  it("rejects active snapshots and freezes incomplete unawaited calls", async () => {
    const gate = deferred<any>();
    const { manager, recorder } = setup(() => gate.promise);
    let pending!: Promise<unknown>;
    const run = recorder.runCase({ caseTitle: "unawaited" }, async () => { pending = manager.executeTool("a", "late"); });
    expect(() => recorder.getResults()).toThrow("still running");
    await run;
    const before = recorder.getResults();
    expect(before[0].metadata?.captureCompleteness).toBe("incomplete");
    gate.resolve({ content: [] }); await pending;
    expect(recorder.getResults()).toEqual(before);
    expect(trace(before[0]).spans[0].evidenceStatus).toBe("incomplete");
  });
  it("bounds capture without changing execution and handles unserializable evidence", async () => {
    const response = { content: [{ type: "text", text: "x".repeat(1000) }] };
    const { manager } = setup(async () => response);
    const recorder = createEvalRecorder({ mcpClientManager: manager, maxCapturedBytes: 300 });
    await recorder.runCase({ caseTitle: "large" }, async () => { expect(await manager.executeTool("a", "big")).toBe(response); });
    expect(recorder.getResults()[0]).toMatchObject({ passed: true, metadata: { captureCompleteness: "unavailable" } });
    expect(recorder.getResults()[0].trace).toBeUndefined();
  });
  it("records task creation without inventing a completed task response", async () => {
    const response = { task: { taskId: "task", status: "working" } };
    const { manager, recorder } = setup(async () => response);
    await recorder.runCase({ caseTitle: "task" }, () => manager.executeTool("a", "task"));
    expect(trace(recorder.getResults()[0]).messages[1].content[0].output.value).toEqual(response);
  });
  it("uploads stable tool evidence and iteration IDs through retry", async () => {
    const { manager, recorder } = setup();
    await recorder.runCase({ caseTitle: "report" }, () => manager.executeTool("a", "search", { query: "coffee" }));
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) return new Response(JSON.stringify({ error: "retry" }), { status: 503, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true, suiteId: "suite", runId: "run", status: "completed", result: "passed", summary: { total: 1, passed: 1, failed: 0, passRate: 1 } }), { headers: { "content-type": "application/json" } });
    }));
    await reportEvalResults({ apiKey: "test", baseUrl: "http://localhost:9999", suiteName: "recorder", results: recorder.getResults(), retryDelayMs: 1 });
    expect(requests.length).toBe(2);
    expect(requests[0].results).toEqual(requests[1].results);
    expect(requests[0].results[0].trace.messages[1].content[0].output.value.structuredContent.count).toBe(2);
  });
});
