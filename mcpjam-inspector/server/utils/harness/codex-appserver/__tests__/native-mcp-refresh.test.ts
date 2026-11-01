import { beforeEach, expect, it, vi } from "vitest";
import { prepareCodexHome, type CodexHomeInput } from "../bridge/codex-home.js";
import {
  createNativeMcpRefresher,
  type NativeMcpRefreshState,
} from "../bridge/native-mcp-refresh.js";

vi.mock("../bridge/codex-home.js", () => ({ prepareCodexHome: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const runtime = {
    request: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
  };
  const server = {
    type: "http" as const,
    url: "https://forward.example/server?native=1",
    timeout: 120000,
    headers: { Connection: "close", "X-MCPJam-Forwarding-Context": "old" },
  };
  let state: NativeMcpRefreshState | undefined = {
    runtime,
    home: {
      codexHome: "/unused",
      baseUrl: "https://model.example",
      apiKeyEnvVar: "FIXTURE_KEY",
      nativeMcpServers: { server },
    },
  };
  const commit = vi.fn((home: CodexHomeInput) => {
    if (state) state = { ...state, home };
  });
  const invalidate = vi.fn(async () => {
    state = undefined;
  });
  const controller = createNativeMcpRefresher({
    current: () => state,
    commit,
    invalidate,
  });
  const candidate = (value: string) => ({
    server: {
      ...server,
      headers: { Connection: "close", "X-MCPJam-Forwarding-Context": value },
    },
  });
  return {
    runtime,
    controller,
    candidate,
    commit,
    invalidate,
    state: () => state,
  };
}

it("reloads only the native MCP configuration on the same runtime", async () => {
  const f = fixture();
  await f.controller.refresh(f.candidate("fresh"));
  expect(f.runtime.request.mock.calls).toEqual([
    ["config/mcpServer/reload", {}],
  ]);
  expect(f.runtime.kill).not.toHaveBeenCalled();
  expect(f.state()?.runtime).toBe(f.runtime);
  expect(f.state()?.home.nativeMcpServers?.server).toMatchObject({
    timeout: 120000,
    headers: { "X-MCPJam-Forwarding-Context": "fresh" },
  });
  expect(prepareCodexHome).toHaveBeenCalledOnce();
});

it("waits for the preceding reload before writing another credential", async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  f.runtime.request.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = f.controller.refresh(f.candidate("first"));
  const second = f.controller.refresh(f.candidate("second"));
  await vi.waitFor(() => expect(f.runtime.request).toHaveBeenCalledOnce());
  expect(prepareCodexHome).toHaveBeenCalledOnce();
  if (!release) throw Error("Reload was not started");
  release();
  await Promise.all([first, second, f.controller.settled()]);
  expect(f.runtime.request).toHaveBeenCalledTimes(2);
  expect(
    f.state()?.home.nativeMcpServers?.server.headers?.[
      "X-MCPJam-Forwarding-Context"
    ],
  ).toBe("second");
});

it("rejects server substitution without touching the runtime and allows a later valid refresh", async () => {
  const f = fixture();
  await expect(
    f.controller.refresh({ other: f.candidate("changed").server }),
  ).rejects.toThrow("selection changed");
  expect(prepareCodexHome).not.toHaveBeenCalled();
  expect(f.runtime.request).not.toHaveBeenCalled();
  expect(f.runtime.kill).not.toHaveBeenCalled();
  await f.controller.refresh(f.candidate("valid"));
  expect(f.runtime.request).toHaveBeenCalledOnce();
});

it.each(["write", "reload"])(
  "retires the runtime after an uncertain %s failure",
  async (failure) => {
    const f = fixture();
    if (failure === "write")
      vi.mocked(prepareCodexHome).mockImplementationOnce(() => {
        throw Error("write failed");
      });
    else f.runtime.request.mockRejectedValueOnce(Error("reload failed"));
    await expect(f.controller.refresh(f.candidate("new"))).rejects.toThrow(
      `${failure} failed`,
    );
    expect(f.runtime.kill).toHaveBeenCalledOnce();
    expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.state()).toBeUndefined();
    await expect(f.controller.refresh(f.candidate("later"))).rejects.toThrow(
      "No native MCP runtime",
    );
  },
);
