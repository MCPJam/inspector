import { describe, expect, it } from "vitest";
import { createWebTestApp, postJson } from "./helpers/test-app.js";

describe("POST /api/web/checks/run-predicates", () => {
  it("is not routed (MJ-022)", async () => {
    // Removed rather than fixed: it called internal-only Convex mutations, so
    // every request failed, and nothing in the client called it.
    const { app, token } = createWebTestApp();

    const res = await postJson(
      app,
      "/api/web/checks/run-predicates",
      {
        chatSessionId: "cs_1",
        predicates: [{ type: "noToolErrors" }],
        setKind: "ad_hoc",
      },
      token,
    );

    expect(res.status).toBe(404);
  });
});
