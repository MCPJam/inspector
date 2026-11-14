import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { composeTurnEnvironment } from "../compose-turn-environment.js";
import { fetchHostRuntimeConfig } from "../../../utils/host-runtime-config.js";

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(fetchHostRuntimeConfig).mockReset();
  vi.mocked(fetchHostRuntimeConfig).mockResolvedValue({ ok: true, config: {} });
});

function client() {
  const client = new ConvexHttpClient("https://test.convex.cloud");
  const mutation = vi.spyOn(client, "mutation").mockResolvedValue({
    hostId: "mcpjam",
    environment: { environmentId: "chat-env" },
  });
  return { client, mutation };
}

describe("chat composition", () => {
  it("requests the MCPJam default rather than the first visible client", async () => {
    const { client: convex, mutation } = client();
    await composeTurnEnvironment({
      client: convex,
      projectId: "project",
      bearer: "token",
    });
    expect(mutation.mock.calls[0]?.[1]).toEqual({
      projectId: "project",
      themeMode: "light",
      purpose: "chat",
    });
    expect(vi.mocked(fetchHostRuntimeConfig).mock.lastCall?.[0].hostId).toBe(
      "mcpjam",
    );
  });

  it("composes a Cursor client like any other: its key is the organization's", async () => {
    const { client: convex, mutation } = client();
    vi.mocked(fetchHostRuntimeConfig).mockResolvedValue({
      ok: true,
      config: { harness: "cursor" },
    });
    const result = await composeTurnEnvironment({
      client: convex,
      projectId: "project",
      hostId: "cursor",
      bearer: "token",
    });
    expect(result).toEqual({ environmentId: "chat-env", harness: "cursor" });
    expect(mutation).toHaveBeenCalledOnce();
    expect(mutation.mock.calls[0]?.[1]).toEqual({
      projectId: "project",
      hostId: "cursor",
      serverSelection: { mode: "none" },
      purpose: "chat",
    });
  });
});

it("uses the prepared external account config without fetching it again", async () => {
  const { client: convex, mutation } = client();
  const result = await composeTurnEnvironment({
    client: convex,
    projectId: "project",
    hostId: "cursor",
    bearer: "token",
    preparedHost: {
      hostId: "cursor",
      config: {
        hostId: "cursor",
        modelId: "cursor-auto",
        systemPrompt: "",
        temperature: 0,
        requireToolApproval: true,
        hostStyle: "cursor",
        harness: "cursor",
      },
    },
  });
  expect(result).toEqual({ environmentId: "chat-env", harness: "cursor" });
  expect(fetchHostRuntimeConfig).not.toHaveBeenCalled();
  expect(mutation).toHaveBeenCalledOnce();
});
