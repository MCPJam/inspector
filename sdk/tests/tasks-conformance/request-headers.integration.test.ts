import { expect, it } from "vitest";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import { TaskRequestHeaders } from "../../src/tasks-conformance/request-headers.js";
import {
  serveExtensionTasksFixture,
  taskTool,
} from "../support/extension-tasks-fixture.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([false, true])(
  "isolates overlapping runs without changing global fetch (signal: %s)",
  async (cancellable) => {
    const original = globalThis.fetch;
    const fixture = await serveExtensionTasksFixture({
      taskIds: ["task-A", "task-B"],
      tools: {
        job: taskTool([
          { status: "completed", ttlMs: 60_000, result: { content: [] } },
        ]),
      },
    });
    const enteredA = gate();
    const enteredB = gate();
    const releaseA = gate();
    const releaseB = gate();
    const start = (
      entered: ReturnType<typeof gate>,
      released: ReturnType<typeof gate>
    ) =>
      new MCPTasksConformanceTest({
        url: fixture.url,
        mcpProtocolVersion: "2026-07-28",
        toolName: "job",
        checkIds: ["tasks-mcp-name-routing"],
        ...(cancellable ? { signal: new AbortController().signal } : {}),
        baseFetch: async (input, init) => {
          if (
            new Request(input, init).headers.get("mcp-method") === "tasks/get"
          ) {
            entered.release();
            await released.promise;
          }
          return original(input, init);
        },
      }).run();
    try {
      const a = start(enteredA, releaseA);
      await enteredA.promise;
      const b = start(enteredB, releaseB);
      await enteredB.promise;
      expect(globalThis.fetch).toBe(original);
      releaseA.release();
      const resultA = await a;
      expect(globalThis.fetch).toBe(original);
      releaseB.release();
      const resultB = await b;
      expect(resultA.checks[0]).toMatchObject({
        status: "passed",
        details: { mcpName: "task-A" },
      });
      expect(resultB.checks[0]).toMatchObject({
        status: "passed",
        details: { mcpName: "task-B" },
      });
      expect(globalThis.fetch).toBe(original);
    } finally {
      releaseA.release();
      releaseB.release();
      await fixture.close();
    }
  }
);

it("removes a capture listener after rejection and preserves the observed error", async () => {
  const headers = new TaskRequestHeaders();
  const reason = new Error("request failed");
  const result = await headers.capture(async () => {
    headers.observe("https://example.test/mcp", {
      headers: { "Mcp-Name": "task-A" },
    });
    throw reason;
  });
  headers.observe("https://example.test/mcp", {
    headers: { "Mcp-Name": "unrelated" },
  });
  expect(result).toEqual({ headers: { "mcp-name": "task-A" }, error: reason });
  expect(await headers.capture(async () => {})).toEqual({});
});

it("observes Request headers without consuming its body", async () => {
  const headers = new TaskRequestHeaders();
  const request = new Request("https://example.test/mcp", {
    method: "POST",
    body: "payload",
    headers: { "Mcp-Name": "task-A" },
  });
  const result = await headers.capture(async () => {
    headers.observe(request);
  });
  expect(result.headers?.["mcp-name"]).toBe("task-A");
  expect(request.bodyUsed).toBe(false);
  expect(await request.text()).toBe("payload");
});
