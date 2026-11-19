import { expect, it } from "vitest";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import {
  serveExtensionTasksFixture,
  taskTool,
} from "../support/extension-tasks-fixture.js";

it("observes task routing headers with cancellation enabled and the default fetch", async () => {
  const fixture = await serveExtensionTasksFixture({
    tools: {
      job: taskTool([
        { status: "completed", ttlMs: 60_000, result: { content: [] } },
      ]),
    },
  });
  try {
    const result = await new MCPTasksConformanceTest({
      url: fixture.url,
      mcpProtocolVersion: "2026-07-28",
      signal: new AbortController().signal,
      toolName: "job",
      checkIds: ["tasks-mcp-name-routing"],
    }).run();
    expect(result.checks[0]).toMatchObject({
      id: "tasks-mcp-name-routing",
      status: "passed",
      details: { mcpName: fixture.tasks()[0]?.taskId, mcpMethod: "tasks/get" },
    });
    expect(result.checks[0]?.details?.mcpName).toBeTruthy();
  } finally {
    await fixture.close();
  }
});

it.each(["server/discover", "tools/list", "tools/call"])(
  "aborts %s, drains active work, and starts no later group",
  async (blockedMethod) => {
    const fixture = await serveExtensionTasksFixture({
      tools: {
        job: taskTool([
          { status: "completed", ttlMs: 60_000, result: { content: [] } },
        ]),
      },
    });
    const controller = new AbortController();
    const reason = new Error("hosted deadline");
    let entered = () => {};
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let drained = false;
    const calls: string[] = [];
    const baseFetch: typeof fetch = async (input, init) => {
      const text =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : undefined;
      const body = text ? JSON.parse(text) : undefined;
      if (body?.method) calls.push(body.method);
      if ((body?.method ?? "connect") !== blockedMethod)
        return fetch(input, init);
      entered();
      return new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              drained = true;
              reject(init.signal?.reason);
            }, 10);
          },
          { once: true }
        );
      });
    };
    try {
      const run = new MCPTasksConformanceTest({
        url: fixture.url,
        mcpProtocolVersion: "2026-07-28",
        baseFetch,
        signal: controller.signal,
        toolName: "job",
        checkIds: ["tasks-inline-result", "tasks-cancel-ack-shape"],
      }).run();
      const rejected = expect(run).rejects.toBe(reason);
      await reached;
      controller.abort(reason);
      await rejected;
      expect(drained).toBe(true);
      expect(calls.filter((method) => method === "tools/call")).toHaveLength(
        blockedMethod === "tools/call" ? 1 : 0
      );
    } finally {
      await fixture.close();
    }
  }
);

it("interrupts a long polling sleep and makes no cancellation call for the next group", async () => {
  const fixture = await serveExtensionTasksFixture({
    tools: {
      job: taskTool([
        { status: "working", ttlMs: 60_000, pollIntervalMs: 60_000 },
      ]),
    },
  });
  const controller = new AbortController();
  const reason = new Error("polling deadline");
  let polled = () => {};
  const reached = new Promise<void>((resolve) => {
    polled = resolve;
  });
  try {
    const run = new MCPTasksConformanceTest({
      url: fixture.url,
      mcpProtocolVersion: "2026-07-28",
      signal: controller.signal,
      toolName: "job",
      pollTimeoutMs: 120_000,
      checkIds: ["tasks-inline-result", "tasks-cancel-ack-shape"],
      baseFetch: async (input, init) => {
        const response = await fetch(input, init);
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (body?.method === "tasks/get") polled();
        return response;
      },
    }).run();
    const rejected = expect(run).rejects.toBe(reason);
    await reached;
    controller.abort(reason);
    await rejected;
    expect(
      fixture.received.some((entry) => entry.method === "tasks/cancel")
    ).toBe(false);
  } finally {
    await fixture.close();
  }
});
