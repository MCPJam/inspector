import { beforeEach, expect, it, vi } from "vitest";
import {
  loadEvalToolMetadata,
  readEvalToolMetadata,
  useEvalToolMetadata,
} from "../eval-tool-metadata";
import { retryEvalToolMetadata } from "../retry-eval-tool-metadata";

const target = {
  projectId: "project",
  environmentKey: "default",
  serverIds: ["server"],
};
const ready = {
  readyServerNames: ["excalidraw"],
  reauthServerNames: [],
  failedServerNames: [],
  missingServerNames: [],
};
beforeEach(async () => {
  useEvalToolMetadata.setState({ entries: {} });
  await loadEvalToolMetadata(target, async () => {
    throw new Error("OAuth authentication required");
  });
});

it("reauthorizes before reloading tools, using the project server name", async () => {
  const ensureServersReady = vi.fn().mockResolvedValue(ready);
  const load = vi.fn().mockImplementation(async () => {
    expect(ensureServersReady).toHaveBeenCalledWith(["excalidraw"], {
      allowInteractiveOAuthFlow: true,
      forceReconnect: true,
    });
    return { tools: [{ name: "draw" }] };
  });
  await retryEvalToolMetadata({
    target,
    ensureServersReady,
    load,
    resolveName: () => "excalidraw",
    serverId: "server",
  });
  expect(readEvalToolMetadata(target).tools).toEqual([
    { name: "draw", serverId: "server" },
  ]);
  expect(ensureServersReady).toHaveBeenCalledTimes(1);
});

it("does not reload unauthorized servers, but still refreshes other tools", async () => {
  const load = vi.fn().mockResolvedValue({ tools: [{ name: "read" }] });
  await expect(
    retryEvalToolMetadata({
      target: { ...target, serverIds: ["server", "healthy"] },
      ensureServersReady: vi
        .fn()
        .mockResolvedValue({
          ...ready,
          readyServerNames: [],
          reauthServerNames: ["excalidraw"],
        }),
      load,
      resolveName: () => "excalidraw",
    }),
  ).rejects.toThrow("Server authorization is required");
  expect(load).toHaveBeenCalledExactlyOnceWith("healthy");
  expect(readEvalToolMetadata(target).servers[0].action).toBe("reconnect");
});

it("does not pretend to reconnect when the readiness action is unavailable", async () => {
  const load = vi.fn();
  await expect(
    retryEvalToolMetadata({ target, load, resolveName: (id) => id }),
  ).rejects.toThrow("Open Servers");
  expect(load).not.toHaveBeenCalled();
});
