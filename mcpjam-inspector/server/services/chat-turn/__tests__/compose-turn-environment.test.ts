import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { composeTurnEnvironment } from "../compose-turn-environment.js";
import { fetchHostRuntimeConfig } from "../../../utils/host-runtime-config.js";
import { shouldUseLocalHarness } from "../../../utils/harness/local/run-resources.js";
import { resolvePlaygroundCredentialEnvironment } from "../../../utils/harness/playground-box.js";

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: vi.fn(),
}));
vi.mock("../../../utils/harness/local/run-resources.js", () => ({
  shouldUseLocalHarness: vi.fn(),
}));
vi.mock("../../../utils/harness/playground-box.js", () => ({
  resolvePlaygroundCredentialEnvironment: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(shouldUseLocalHarness).mockResolvedValue(false);
  vi.mocked(fetchHostRuntimeConfig).mockResolvedValue({ ok: true, config: {} });
  vi.mocked(resolvePlaygroundCredentialEnvironment).mockResolvedValue({
    ok: true,
    environmentId: "credential-env",
  });
});

describe("chat composition", () => {
  function client() {
    const client = new ConvexHttpClient("https://test.convex.cloud");
    const mutation = vi.spyOn(client, "mutation").mockResolvedValue({
      hostId: "mcpjam",
      environment: { environmentId: "chat-env" },
    });
    return { client, mutation };
  }
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
  it("keeps a local Cursor turn independent of project credentials", async () => {
    const { client: convex, mutation } = client();
    vi.mocked(fetchHostRuntimeConfig).mockResolvedValue({
      ok: true,
      config: { harness: "cursor" },
    });
    vi.mocked(shouldUseLocalHarness).mockResolvedValue(true);
    vi.mocked(resolvePlaygroundCredentialEnvironment).mockClear();
    const result = await composeTurnEnvironment({
      client: convex,
      projectId: "project",
      hostId: "cursor",
      bearer: "token",
    });
    expect(result.environmentId).toBe("chat-env");
    expect(mutation).toHaveBeenCalledOnce();
    expect(resolvePlaygroundCredentialEnvironment).not.toHaveBeenCalled();
  });
  it.each([
    [409, "CONFLICT"],
    [502, "SERVER_UNREACHABLE"],
  ] as const)(
    "classifies credential failures with status %s",
    async (status, code) => {
      const { client: convex } = client();
      vi.mocked(fetchHostRuntimeConfig).mockResolvedValue({
        ok: true,
        config: { harness: "cursor" },
      });
      vi.mocked(resolvePlaygroundCredentialEnvironment).mockResolvedValue({
        ok: false,
        status,
        message: "Credentials unavailable",
      });
      await expect(
        composeTurnEnvironment({
          client: convex,
          projectId: "project",
          hostId: "cursor",
          bearer: "token",
        }),
      ).rejects.toMatchObject({ status, code });
    },
  );
});
