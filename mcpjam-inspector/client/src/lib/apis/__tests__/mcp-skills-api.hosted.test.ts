import { describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import { listSkills } from "../mcp-skills-api";

describe("mcp-skills-api hosted mode", () => {
  it("returns an empty skills list without calling the local skills endpoint", async () => {
    const result = await listSkills();

    expect(result).toEqual([]);
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
