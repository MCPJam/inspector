import type { HarnessV1, HarnessV1StartOptions } from "@ai-sdk/harness";
import { describe, expect, it, vi } from "vitest";
import { withCursorLoginAuthentication } from "../cursor-login-auth.js";

function setup() {
  const spawn = vi.fn(
    async (_args: { env?: Record<string, string>; command: string }) =>
      ({}) as never,
  );
  const sandbox = {
    spawn,
    marker: "original",
    readTextFile() {
      return this.marker;
    },
    restricted() {
      return { spawn, readTextFile: async () => "restricted" };
    },
  };
  const start = vi.fn(async (_options: HarnessV1StartOptions) => ({}) as never);
  const harness: HarnessV1 = {
    specificationVersion: "harness-v1",
    harnessId: "cursor",
    builtinTools: {},
    doStart: start,
  };
  return {
    spawn,
    sandbox,
    start,
    wrapped: withCursorLoginAuthentication(harness),
  };
}

describe("Cursor file-login authentication", () => {
  it("requests the advertised login method before ACP starts and keeps other configuration", async () => {
    const f = setup();
    await f.wrapped.doStart({
      sandboxSession: f.sandbox as never,
      sessionId: "one",
      sessionWorkDir: "/workspace",
    });
    const fullSession = f.start.mock.calls[0]![0].sandboxSession;
    const session =
      "restricted" in fullSession ? fullSession.restricted() : fullSession;
    await session.spawn({
      command: "bridge",
      env: {
        AI_SDK_ACP_BRIDGE_CONFIGURATION: JSON.stringify({
          clientCapabilities: { sample: true },
        }),
        OTHER: "kept",
      },
    });
    expect(f.spawn).toHaveBeenCalledWith({
      command: "bridge",
      env: {
        AI_SDK_ACP_BRIDGE_CONFIGURATION: JSON.stringify({
          clientCapabilities: { sample: true },
          authentication: { methodId: "cursor_login" },
        }),
        OTHER: "kept",
      },
    });
    expect(await session.readTextFile({ path: "/unused" })).toBe("restricted");
  });

  it("leaves unrelated processes alone and rejects malformed bridge configuration", async () => {
    const f = setup();
    await f.wrapped.doStart({
      sandboxSession: f.sandbox as never,
      sessionId: "one",
      sessionWorkDir: "/workspace",
    });
    const session = f.start.mock.calls[0]![0].sandboxSession;
    await session.spawn({ command: "unrelated" });
    expect(f.spawn).toHaveBeenCalledWith({ command: "unrelated" });
    expect(() =>
      session.spawn({
        command: "bridge",
        env: { AI_SDK_ACP_BRIDGE_CONFIGURATION: "[]" },
      }),
    ).toThrow("invalid");
  });
});
