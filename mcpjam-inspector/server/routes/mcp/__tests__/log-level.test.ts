import { describe, it, expect, vi } from "vitest";
import {
  createMockMcpClientManager,
  createTestApp,
  postJson,
  expectJson,
} from "./helpers/index.js";

/**
 * log-level.test.ts — route wiring for POST /api/mcp/log-level.
 *
 * The route is era-aware: it defers to `MCPClientManager.getLoggingMechanism`
 * (the same helper the client UI reads to pick which control to render) and
 * dispatches to either the modern per-request opt-in
 * (`setPerRequestLogLevel`) or the legacy `setLoggingLevel` RPC. Verified
 * here with a mocked manager; the underlying dual-era delivery itself is
 * covered by the SDK's `logging-dual-era.integration.test.ts`.
 */
describe("POST /api/mcp/log-level", () => {
  it("dispatches to setPerRequestLogLevel on the modern mechanism", async () => {
    const manager = createMockMcpClientManager({
      getLoggingMechanism: vi.fn().mockReturnValue("per-request-meta"),
    });
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", {
      serverId: "srv",
      level: "warning",
    });
    const { status, data } = await expectJson<{
      success: boolean;
      mechanism: string;
    }>(res);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mechanism).toBe("per-request-meta");
    expect(manager.setPerRequestLogLevel).toHaveBeenCalledWith(
      "srv",
      "warning",
    );
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
  });

  it("opt-out (level: null) clears the per-request level on the modern mechanism", async () => {
    const manager = createMockMcpClientManager({
      getLoggingMechanism: vi.fn().mockReturnValue("per-request-meta"),
    });
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", {
      serverId: "srv",
      level: null,
    });
    const { status, data } = await expectJson<{ success: boolean }>(res);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(manager.setPerRequestLogLevel).toHaveBeenCalledWith(
      "srv",
      undefined,
    );
  });

  it("dispatches to setLoggingLevel on the legacy mechanism", async () => {
    const manager = createMockMcpClientManager({
      getLoggingMechanism: vi.fn().mockReturnValue("setLevel"),
    });
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", {
      serverId: "srv",
      level: "debug",
    });
    const { status, data } = await expectJson<{
      success: boolean;
      mechanism: string;
    }>(res);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.mechanism).toBe("setLevel");
    expect(manager.setLoggingLevel).toHaveBeenCalledWith("srv", "debug");
    expect(manager.setPerRequestLogLevel).not.toHaveBeenCalled();
  });

  it("rejects opt-out (level: null) on the legacy mechanism", async () => {
    const manager = createMockMcpClientManager({
      getLoggingMechanism: vi.fn().mockReturnValue("setLevel"),
    });
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", {
      serverId: "srv",
      level: null,
    });
    const { status, data } = await expectJson<{ success: boolean }>(res);

    expect(status).toBe(400);
    expect(data.success).toBe(false);
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
  });

  it("rejects when the server does not support logging", async () => {
    const manager = createMockMcpClientManager({
      getLoggingMechanism: vi.fn().mockReturnValue("none"),
    });
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", {
      serverId: "srv",
      level: "debug",
    });
    const { status, data } = await expectJson<{ success: boolean }>(res);

    expect(status).toBe(400);
    expect(data.success).toBe(false);
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
    expect(manager.setPerRequestLogLevel).not.toHaveBeenCalled();
  });

  it("rejects an unregistered server", async () => {
    const manager = createMockMcpClientManager({
      hasServer: vi.fn().mockReturnValue(false),
    });
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", {
      serverId: "missing",
      level: "debug",
    });
    const { status, data } = await expectJson<{ success: boolean }>(res);

    expect(status).toBe(404);
    expect(data.success).toBe(false);
  });

  it("rejects a request missing serverId or level", async () => {
    const manager = createMockMcpClientManager();
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", { serverId: "srv" });
    const { status, data } = await expectJson<{ success: boolean }>(res);

    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("rejects an invalid level string", async () => {
    const manager = createMockMcpClientManager({
      getLoggingMechanism: vi.fn().mockReturnValue("setLevel"),
    });
    const app = createTestApp(manager, "log-level");

    const res = await postJson(app, "/api/mcp/log-level", {
      serverId: "srv",
      level: "not-a-level",
    });
    const { status, data } = await expectJson<{ success: boolean }>(res);

    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });
});
