/**
 * The caller's log level reaches the real server the way its connection takes
 * one, and never fails the call. Callers send a level on every turn since the
 * Playground and evals show a tool call's logs; a 2026-07-28 server refuses
 * `logging/setLevel`, and that refusal used to fail every call through a mock
 * (product gate run 4: every steering case of a climb's baseline failed with
 * "Method 'logging/setLevel' is not supported by the negotiated protocol
 * version").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("../../../utils/logger.js", () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

import { realServerOn } from "../real-server.js";

const RESULT = { content: [{ type: "text", text: "you are owner" }] };

function fakeManager(mechanism: "setLevel" | "per-request-meta" | "none", setLevel = vi.fn(async () => {})) {
  return {
    getLoggingMechanism: vi.fn(() => mechanism),
    setPerRequestLogLevel: vi.fn(),
    setLoggingLevel: setLevel,
    executeTool: vi.fn(async () => RESULT),
    addNotificationHandler: vi.fn(),
    removeNotificationHandler: vi.fn(),
  };
}

beforeEach(() => warn.mockReset());

describe("a mock's real server and the caller's log level", () => {
  it("rides on each request for a 2026-07-28 connection", async () => {
    const manager = fakeManager("per-request-meta");
    const result = await realServerOn(manager as never, "srv").callTool({ name: "get_me", arguments: {}, logLevel: "debug" } as never);
    expect(result).toEqual(RESULT);
    expect(manager.setPerRequestLogLevel).toHaveBeenCalledWith("srv", "debug");
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
  });

  it("is set once with logging/setLevel on an older connection", async () => {
    const manager = fakeManager("setLevel");
    await realServerOn(manager as never, "srv").callTool({ name: "get_me", arguments: {}, logLevel: "debug" } as never);
    expect(manager.setLoggingLevel).toHaveBeenCalledWith("srv", "debug");
    expect(manager.setPerRequestLogLevel).not.toHaveBeenCalled();
  });

  it("does not fail the call when the real server refuses the level", async () => {
    const refused = vi.fn(async () => {
      throw new Error("Method 'logging/setLevel' is not supported by the negotiated protocol version (wire era 2026-07-28)");
    });
    const manager = fakeManager("setLevel", refused);
    const result = await realServerOn(manager as never, "srv").callTool({ name: "get_me", arguments: {}, logLevel: "debug" } as never);
    expect(result).toEqual(RESULT);
    expect(manager.executeTool).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("asks a server that does not log for nothing", async () => {
    const manager = fakeManager("none");
    const result = await realServerOn(manager as never, "srv").callTool({ name: "get_me", arguments: {}, logLevel: "debug" } as never);
    expect(result).toEqual(RESULT);
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
    expect(manager.setPerRequestLogLevel).not.toHaveBeenCalled();
  });

  it("leaves the level alone when the caller sends none", async () => {
    const manager = fakeManager("setLevel");
    await realServerOn(manager as never, "srv").callTool({ name: "get_me", arguments: {} } as never);
    expect(manager.getLoggingMechanism).not.toHaveBeenCalled();
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
  });
});
