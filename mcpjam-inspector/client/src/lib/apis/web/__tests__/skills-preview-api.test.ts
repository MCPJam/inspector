/**
 * The skills-preview read the Compare pane and the Evaluate page's skill
 * hints share: a parsed preview on success, and on failure an error whose
 * message a person can read, with the HTTP status kept in `cause`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchResponse } from "@/test/factories";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch }));

import { fetchSkillsPreview } from "../skills-preview-api";

const request = {
  projectId: "project",
  target: { kind: "environment" as const, environmentId: "env" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchSkillsPreview", () => {
  it("posts the request and returns the parsed preview", async () => {
    const preview = { deliveredCount: 0, skills: [] };
    authFetch.mockResolvedValue(createFetchResponse(preview));
    await expect(fetchSkillsPreview(request)).resolves.toEqual(preview);
    expect(authFetch).toHaveBeenCalledWith(
      "/api/web/environments/skills-preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
  });

  it("keeps the status out of the message and in cause", async () => {
    authFetch.mockResolvedValue(createFetchResponse({}, 503));
    const error = await fetchSkillsPreview(request).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Couldn’t load the skills preview. Try again.",
    );
    expect((error as Error).cause).toEqual({ status: 503 });
  });
});
