import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebRouteError, ErrorCode } from "../../web/errors.js";
import { ConvexHttpClient } from "convex/browser";
import { resolveChatSessionEnvironment } from "../chat-session-environment.js";
import { resolveChatTurn } from "../../../services/chat-turn/resolve-chat-turn.js";

vi.mock("../../../services/chat-turn/resolve-chat-turn.js", () => ({
  resolveChatTurn: vi.fn(),
}));
vi.mock("../../../services/environments/plugin-attribution.js", () => ({
  fetchPluginRuntimeAttribution: vi.fn(async () => null),
}));

describe("API environment negotiation", () => {
  const client = new ConvexHttpClient("https://test.convex.cloud");
  const query = vi.spyOn(client, "query");
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ chatEnvironmentVersion: 1 });
    vi.mocked(resolveChatTurn).mockResolvedValue({
      kind: "project",
      mode: "interactive",
      composed: true,
      access: { kind: "project", projectId: "project" },
      selection: { kind: "explicit", serverIds: [] },
      environment: {
        environmentRef: { environmentId: "hidden", name: "", revision: 1 },
        host: { hostId: "mcpjam", runtimeConfig: { modelId: "openai/gpt-5" } },
        servers: { effectiveServerIds: [] },
      },
    });
  });
  const resolve = (input = { serverIds: [] as string[] }) =>
    resolveChatSessionEnvironment(
      client,
      "project",
      input,
      { authHeader: "Bearer token" },
    );
  it("requires shared setup support on every API turn", async () => {
    query.mockResolvedValue({});
    await expect(resolve({ serverIds: ["selected"] })).rejects.toMatchObject({
      status: 422, code: "FEATURE_NOT_SUPPORTED",
    });
    expect(resolveChatTurn).not.toHaveBeenCalled();
  });
  it.each([undefined, "host"])(
    "refuses explicit empty selection on old backends, host=%s",
    async (hostId) => {
      query.mockResolvedValue({});
      await expect(
        resolveChatSessionEnvironment(
          client,
          "project",
          { serverIds: [], ...(hostId ? { hostId } : {}) },
          { authHeader: "Bearer token" },
            ),
      ).rejects.toMatchObject({ status: 422, code: "FEATURE_NOT_SUPPORTED" });
        expect(resolveChatTurn).not.toHaveBeenCalled();
    },
  );
  it("does not downgrade a denied project or a failed capability query", async () => {
    query.mockResolvedValueOnce(null);
    await expect(resolve()).rejects.toMatchObject({ status: 404 });
    query.mockRejectedValueOnce(new Error("backend unavailable"));
    await expect(resolve()).rejects.toThrow("backend unavailable");
  });
  it("keeps bare server lists on the emulated rail while retaining setup evidence", async () => {
    const target = await resolve();
    expect(target.host).toBeUndefined();
    expect(target.resolvedEnvironment?.host.hostId).toBe("mcpjam");
    expect(target.serverIds).toEqual([]);
    expect(resolveChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "adhoc", projectId: "project" },
        selection: { kind: "explicit", serverIds: [] },
      }),
    );
  });
  it.each([{ ids: ["gone"] }, { ids: ["live", "gone"] }])(
    "keeps deleted pins for skip reporting: %j",
    async ({ ids }) => {
      vi.mocked(resolveChatTurn).mockRejectedValueOnce(
        new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "Server gone is not an available server in this project.",
        ),
      );
      query
        .mockResolvedValueOnce({ chatEnvironmentVersion: 1 })
        .mockResolvedValueOnce([{ _id: "live" }]);
      const target = await resolve({ serverIds: ids });
      expect(target.serverIds).toEqual(ids);
      expect(target.unavailableServerIds).toEqual(["gone"]);
      expect(resolveChatTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selection: {
            kind: "explicit",
            serverIds: ids.filter((id) => id !== "gone"),
          },
        }),
      );
    },
  );
  it("does not retry unrelated validation or revoked plugin errors", async () => {
    vi.mocked(resolveChatTurn).mockRejectedValueOnce(
      new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Plugin-provided servers cannot be added by an override.",
      ),
    );
    await expect(resolve({ serverIds: ["plugin"] })).rejects.toThrow(
      "Plugin-provided",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("preserves the omitted-empty refusal for host defaults", async () => {
    await expect(
      resolveChatSessionEnvironment(
        client,
        "project",
        { hostId: "mcpjam" },
        { authHeader: "Bearer token" },
        ),
    ).rejects.toMatchObject({
      status: 422,
      message: "That client selects no connectable MCP servers.",
    });
    expect(resolveChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { kind: "client-default" } }),
    );
  });
});
