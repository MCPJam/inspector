/**
 * The caller's log level reaches the real server the way its connection takes
 * one, and never fails the call. Callers send a level on every turn; a
 * 2026-07-28 server refuses `logging/setLevel`, and that refusal must not fail
 * every call through a mock.
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
const call = (manager: ReturnType<typeof fakeManager>, extra: object = { logLevel: "debug" }) =>
  realServerOn(manager as never, "srv").callTool({ name: "get_me", arguments: {}, ...extra } as never);

beforeEach(() => warn.mockReset());

describe("a mock's real server and the caller's log level", () => {
  it("rides on each request for a 2026-07-28 connection", async () => {
    const manager = fakeManager("per-request-meta");
    expect(await call(manager)).toEqual(RESULT);
    expect(manager.setPerRequestLogLevel).toHaveBeenCalledWith("srv", "debug");
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
  });

  it("is set with logging/setLevel on an older connection", async () => {
    const manager = fakeManager("setLevel");
    await call(manager);
    expect(manager.setLoggingLevel).toHaveBeenCalledWith("srv", "debug");
    expect(manager.setPerRequestLogLevel).not.toHaveBeenCalled();
  });

  it("does not fail the call when the real server refuses the level", async () => {
    const refused = vi.fn(async () => {
      throw new Error("Method 'logging/setLevel' is not supported by the negotiated protocol version");
    });
    const manager = fakeManager("setLevel", refused);
    expect(await call(manager)).toEqual(RESULT);
    expect(manager.executeTool).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("asks a server that does not log for nothing", async () => {
    const manager = fakeManager("none");
    expect(await call(manager)).toEqual(RESULT);
    expect(manager.setLoggingLevel).not.toHaveBeenCalled();
    expect(manager.setPerRequestLogLevel).not.toHaveBeenCalled();
  });

  it("leaves the level alone when the caller sends none", async () => {
    const manager = fakeManager("setLevel");
    await call(manager, {});
    expect(manager.getLoggingMechanism).not.toHaveBeenCalled();
  });
});
