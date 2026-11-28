/**
 * PR1 acceptance gate: with the REAL beta.4 client (no mocked
 * `ManagedMcpClient`), a task-augmented `tools/call` must deliver
 * `params.task` on the wire against a 2025-11-25 server, and non-task calls
 * must not carry the key at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import {
  LEGACY_TASK_ID,
  LEGACY_TASK_TOOL_NAME,
  serveLegacyTasksFixture,
  type ServedLegacyTasksFixture,
} from "./support/legacy-tasks-fixture.js";

describe("legacy 2025-11-25 tasks wire — real client integration", () => {
  let served: ServedLegacyTasksFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    served = await serveLegacyTasksFixture();
    manager = new MCPClientManager();
    await manager.connectToServer("legacy", {
      url: served.url,
      mcpProtocolVersion: "2025-11-25",
      timeout: 10_000,
    });
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("negotiates 2025-11-25 and resolves the legacy wire", () => {
    expect(manager.getNegotiatedProtocolVersion("legacy")).toBe("2025-11-25");
    expect(manager.supportsTasksForToolCalls("legacy")).toBe(true);
  });

  it("delivers params.task through the beta.4 client and creates the task", async () => {
    const result = await manager.executeTool(
      "legacy",
      LEGACY_TASK_TOOL_NAME,
      {},
      undefined,
      { ttl: 30_000 }
    );

    const call = served.received.find((r) => r.method === "tools/call");
    expect(call, "tools/call reached the server").toBeDefined();
    // The client did NOT strip the unknown request param.
    expect(call!.params?.task).toEqual({ ttl: 30_000 });
    expect((result as { task?: { taskId?: string } }).task?.taskId).toBe(
      LEGACY_TASK_ID
    );
  });

  it("omits params.task on ordinary calls", async () => {
    await manager.executeTool("legacy", LEGACY_TASK_TOOL_NAME, {});
    const call = served.received.find((r) => r.method === "tools/call");
    expect(call!.params && "task" in call!.params).toBe(false);
  });

  it("round-trips tasks/get and tasks/result against the same connection", async () => {
    await manager.executeTool(
      "legacy",
      LEGACY_TASK_TOOL_NAME,
      {},
      undefined,
      {}
    );
    const task = await manager.getTask("legacy", LEGACY_TASK_ID);
    expect(task.status).toBe("completed");
    const taskResult = await manager.getTaskResult("legacy", LEGACY_TASK_ID);
    expect(taskResult).toMatchObject({
      content: [{ type: "text", text: "task done" }],
    });
  });
});

describe("legacy 2025-11-25 tasks wire — server without tasks.requests.tools.call", () => {
  let served: ServedLegacyTasksFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    // `tasks.cancel` alone still resolves to the legacy wire, and the
    // fixture's tool says `taskSupport: "required"`.
    served = await serveLegacyTasksFixture({
      tasksCapability: { cancel: {} },
    });
    manager = new MCPClientManager();
    await manager.connectToServer("legacy", {
      url: served.url,
      mcpProtocolVersion: "2025-11-25",
      timeout: 10_000,
    });
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("refuses to call a tool as a task and sends nothing", async () => {
    expect(manager.supportsTasksForToolCalls("legacy")).toBe(false);
    await expect(
      manager.executeTool("legacy", LEGACY_TASK_TOOL_NAME, {}, undefined, {})
    ).rejects.toThrow(/tasks\.requests\.tools\.call/);
    expect(served.received.some((r) => r.method === "tools/call")).toBe(false);
  });
});

describe("legacy 2025-11-25 tasks wire — tool without taskSupport", () => {
  let served: ServedLegacyTasksFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    // The server accepts task tool calls, but its one tool declares no
    // `execution.taskSupport` (2025-11-25 tasks.mdx:115).
    served = await serveLegacyTasksFixture({ toolTaskSupport: null });
    manager = new MCPClientManager();
    await manager.connectToServer("legacy", {
      url: served.url,
      mcpProtocolVersion: "2025-11-25",
      timeout: 10_000,
    });
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("refuses to call the tool as a task and sends no tools/call", async () => {
    expect(manager.supportsTasksForToolCalls("legacy")).toBe(true);
    await expect(
      manager.executeTool("legacy", LEGACY_TASK_TOOL_NAME, {}, undefined, {})
    ).rejects.toThrow(/has no taskSupport/);
    expect(served.received.some((r) => r.method === "tools/call")).toBe(false);
  });
});
