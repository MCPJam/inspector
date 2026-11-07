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
