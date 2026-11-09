import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeProject } from "../auth.js";

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://test.convex.site");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("startup authorization facts", () => {
  it.each([
    { conversationId: "chat", writable: false, requireNativeToolDiscovery: true },
    { conversationId: "another", writable: true },
    { conversationId: "chat", writable: true, requireNativeToolDiscovery: "invalid" },
  ])("uses only a complete policy for the requested chat", async (conversationState) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, conversationState })));
    const result = await authorizeProject({}, "test-bearer", "project", "chat");
    expect(result.conversationState).toEqual(
      conversationState.writable === false ? conversationState : undefined,
    );
  });
  it.each([
    [{ conversationId: "chat", writable: true, executionBound: true }, true],
    [{ conversationId: "chat", writable: true, executionBound: "yes" }, false],
  ])("keeps the backend's bound answer only when it is well formed", async (conversationState, kept) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, conversationState })));
    const result = await authorizeProject({}, "test-bearer", "project", "chat");
    expect(result.conversationState).toEqual(kept ? conversationState : undefined);
  });
  it("includes preparation in the authorized HTTPS request and preserves its result", async () => {
    const preparedChatTurn = { kind: "resolved", environment: {}, harness: null };
    const request = { projectId: "project", hostId: "host", serverOverrideIds: [] };
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, preparedChatTurn })));
    const result = await authorizeProject({}, "test-bearer", "project", undefined, request, controller.signal);
    expect(result.preparedChatTurn).toEqual(preparedChatTurn);
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(options?.body))).toEqual({ projectId: "project", chatPreparation: request });
    expect(options?.redirect).toBe("error");
    controller.abort();
    expect(options?.signal?.aborted).toBe(true);
  });
  it("leaves legacy backends and HTTP deployments on the action fallback", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "http://localhost:3211");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, chatPreparationVersion: 1, preparedChatTurn: null })));
    const result = await authorizeProject({}, "test-bearer", "project", undefined, { projectId: "project" });
    expect(result.preparedChatTurn).toBeUndefined();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ projectId: "project" });
  });
  it.each(["admin", "editor"])(
    "returns the current %s grant with the preparation capability",
    async (projectRole) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            ok: true,
            chatEnvironmentVersion: 1,
            chatPreparationVersion: 1,
            organizationId: "signed-org",
            projectRole,
          }),
        ),
      );
      expect(await authorizeProject({}, "test-bearer", "project")).toEqual({
        chatEnvironments: true,
        chatPreparation: true,
        organizationId: "signed-org",
        projectAccess: { projectRole },
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([undefined, null, "owner", "viewer", 1, true, {}])(
    "leaves absent or invalid grant %s for the existing query fallback",
    async (projectRole) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ ok: true, chatEnvironmentVersion: 1, projectRole }),
        ),
      );
      expect(await authorizeProject({}, "test-bearer", "project")).toEqual({
        chatEnvironments: true,
        chatPreparation: false,
      });
    },
  );
  it("does not retain access from an earlier request", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            chatEnvironmentVersion: 1,
            projectRole: "admin",
          }),
        )
        .mockResolvedValueOnce(
          Response.json(
            { code: "FORBIDDEN", message: "Access removed" },
            { status: 403 },
          ),
        ),
    );
    await authorizeProject({}, "test-bearer", "project");
    await expect(
      authorizeProject({}, "test-bearer", "project"),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
