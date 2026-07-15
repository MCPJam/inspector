import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRuntimeServerSecrets } from "../server-secrets.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("fetchRuntimeServerSecrets", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    vi.unstubAllGlobals();
  });

  it("preserves Convex error codes on failed reveals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ code: "FORBIDDEN", message: "No access" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      fetchRuntimeServerSecrets({
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "No access",
    });
  });
});
