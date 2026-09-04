/**
 * What the cloud wire becomes on the client.
 *
 * `path` is synthetic for a project skill — there is no filesystem path to
 * report — so it carries a human label for the STORE. It used to repeat the
 * sharing tier ("Shared"/"Personal"), which the UI already renders as its own
 * badge, so a skill header said the same word twice. These pin the label and
 * the fields that travel beside it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const webPostMock = vi.fn();

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/lib/apis/web/base", () => ({
  webPost: (...args: unknown[]) => webPostMock(...args),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));

import { listSkills, getSkill } from "../mcp-skills-api";

const SOURCE = { kind: "cloud" as const, projectId: "proj-1" };

const wire = (over: Record<string, unknown> = {}) => ({
  skillId: "skill-1",
  name: "refunds",
  description: "Handle refunds",
  sharing: "project",
  isOwner: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cloud skill mapping — the synthetic `path`", () => {
  it("labels a project skill with its store, not its tier", async () => {
    webPostMock.mockResolvedValue({ skills: [wire({ sharing: "project" })] });

    const [row] = await listSkills(SOURCE);

    expect(row.path).toBe("Library");
    expect(row.sharing).toBe("project");
  });

  it("labels a personal skill with the same store", async () => {
    // Both live in the project's library; `sharing` is a separate question and
    // the badge's job. Repeating it here is what produced the doubled word.
    webPostMock.mockResolvedValue({ skills: [wire({ sharing: "user" })] });

    const [row] = await listSkills(SOURCE);

    expect(row.path).toBe("Library");
    expect(row.sharing).toBe("user");
  });

  it("labels the detail view the same way, with empty content tolerated", async () => {
    webPostMock.mockResolvedValue({ skill: wire({ content: undefined }) });

    const skill = await getSkill("refunds", SOURCE);

    expect(skill.path).toBe("Library");
    expect(skill.content).toBe("");
  });

  it("omits optional fields rather than inventing them", async () => {
    // A row predating versioning has no `currentVersionId`; consumers render
    // nothing rather than guessing "v1".
    webPostMock.mockResolvedValue({ skills: [wire()] });

    const [row] = await listSkills(SOURCE);

    expect(row).not.toHaveProperty("currentVersionId");
    expect(row).not.toHaveProperty("currentVersionNumber");
    expect(row).not.toHaveProperty("pinnability");
    expect(row.provenance).toBe("authored");
  });

  it("carries pinnability through verbatim when the backend sends it", async () => {
    webPostMock.mockResolvedValue({
      skills: [wire({ pinnability: { ok: false, reason: "not_shared" } })],
    });

    const [row] = await listSkills(SOURCE);

    expect(row.pinnability).toEqual({ ok: false, reason: "not_shared" });
  });

  it("yields an empty list when the response carries no skills", async () => {
    webPostMock.mockResolvedValue(null);

    expect(await listSkills(SOURCE)).toEqual([]);
  });

  it("lets a failed request throw rather than reporting an empty library", async () => {
    webPostMock.mockRejectedValue(new Error("forbidden"));

    await expect(listSkills(SOURCE)).rejects.toThrow("forbidden");
  });
});
