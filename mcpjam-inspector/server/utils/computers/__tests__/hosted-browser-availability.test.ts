import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isHostedBrowserAvailableFor } from "../hosted-browser-availability";

const ANSWER = {
  inspector: { available: true, reason: null },
  tools: { available: false, reason: "catalog_disabled" },
};

function client(answer: unknown | (() => Promise<unknown>)) {
  return {
    query: vi.fn(async () =>
      typeof answer === "function"
        ? (answer as () => Promise<unknown>)()
        : answer,
    ),
  };
}

describe("isHostedBrowserAvailableFor", () => {
  it("answers per surface, asking by project", async () => {
    const convex = client(ANSWER);
    await expect(
      isHostedBrowserAvailableFor({
        bearer: "Bearer member-jwt",
        projectId: "proj_1",
        surface: "inspector",
        client: convex,
      }),
    ).resolves.toBe(true);
    await expect(
      isHostedBrowserAvailableFor({
        bearer: "member-jwt",
        projectId: "proj_1",
        surface: "tools",
        client: convex,
      }),
    ).resolves.toBe(false);
    expect(convex.query).toHaveBeenCalledWith(expect.anything(), {
      projectId: "proj_1",
    });
  });

  it("refuses without asking when there is no member or no project", async () => {
    const convex = client(ANSWER);
    for (const args of [
      { bearer: undefined, projectId: "proj_1" },
      { bearer: "Bearer   ", projectId: "proj_1" },
      { bearer: "member-jwt", projectId: null },
    ]) {
      await expect(
        isHostedBrowserAvailableFor({
          ...args,
          surface: "inspector",
          client: convex,
        }),
      ).resolves.toBe(false);
    }
    expect(convex.query).not.toHaveBeenCalled();
  });

  it("reads a failure or a malformed answer as unavailable, never throwing", async () => {
    for (const answer of [
      () => Promise.reject(new Error("Could not find public function")),
      null,
      { inspector: { available: "yes" } },
      {},
    ]) {
      await expect(
        isHostedBrowserAvailableFor({
          bearer: "member-jwt",
          projectId: "proj_1",
          surface: "inspector",
          client: client(answer),
        }),
      ).resolves.toBe(false);
    }
  });
});
