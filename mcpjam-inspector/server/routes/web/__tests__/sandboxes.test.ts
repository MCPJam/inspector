import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("web routes — sandboxes bootstrap", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("surfaces a deployment mismatch when the upstream sandbox route is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("No matching routes found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
      ),
    );

    const response = await postJson(
      app,
      "/api/web/sandboxes/bootstrap",
      { token: "sandbox-link-token" },
      token,
    );
    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);

    expect(status).toBe(404);
    expect(data.code).toBe("NOT_FOUND");
    expect(data.message).toContain("does not expose /sandbox/bootstrap");
  });
});
