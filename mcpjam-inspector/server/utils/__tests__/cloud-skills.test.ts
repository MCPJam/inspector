import { describe, it, expect, beforeEach, vi } from "vitest";

// cloud-skills is now a thin Convex-sourced adapter. We mock the Convex client
// and verify it forwards bearer/projectId and maps Convex errors → status.

vi.mock("../computers/convex-skills-client", () => ({
  convexListSkills: vi.fn(),
  convexGetSkill: vi.fn(),
  convexGetSkillByName: vi.fn(),
  convexListSkillsForMaterialize: vi.fn(),
  convexCreateSkill: vi.fn(),
  convexUpdateSkill: vi.fn(),
  convexDeleteSkill: vi.fn(),
  convexPromoteSkill: vi.fn(),
}));

import {
  CloudSkillsError,
  listCloudSkills,
  createCloudSkill,
  deleteCloudSkill,
  type CloudSkillsContext,
} from "../computers/cloud-skills";
import {
  convexListSkills,
  convexCreateSkill,
  convexDeleteSkill,
} from "../computers/convex-skills-client";

const ctx: CloudSkillsContext = {
  authHeader: "Bearer user-jwt",
  projectId: "proj_1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cloud-skills (Convex-sourced)", () => {
  it("forwards bearer + projectId to the Convex client", async () => {
    vi.mocked(convexListSkills).mockResolvedValue([]);
    await listCloudSkills(ctx);
    expect(vi.mocked(convexListSkills)).toHaveBeenCalledWith(
      "Bearer user-jwt",
      "proj_1",
    );
  });

  it("returns the Convex list verbatim", async () => {
    vi.mocked(convexListSkills).mockResolvedValue([
      {
        skillId: "s1",
        projectId: "proj_1",
        name: "pdf",
        description: "d",
        sharing: "project",
        isOwner: false,
        aggregateHash: "h",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const out = await listCloudSkills(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].sharing).toBe("project");
  });

  it("maps an admin-gate error to 403", async () => {
    vi.mocked(convexCreateSkill).mockRejectedValue(
      new Error("Publishing a project skill requires project admin"),
    );
    await expect(
      createCloudSkill(ctx, {
        name: "x",
        description: "d",
        content: "c",
        sharing: "project",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("maps a name-collision error to 409", async () => {
    vi.mocked(convexCreateSkill).mockRejectedValue(
      new Error('A project skill named "x" already exists.'),
    );
    await expect(
      createCloudSkill(ctx, { name: "x", description: "d", content: "c" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("maps a not-found error to 404", async () => {
    vi.mocked(convexDeleteSkill).mockRejectedValue(new Error("Skill not found"));
    await expect(deleteCloudSkill(ctx, "missing")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("maps a validation error to 400", async () => {
    vi.mocked(convexCreateSkill).mockRejectedValue(
      new Error("Skill name must be 1-64 characters of lowercase letters..."),
    );
    await expect(
      createCloudSkill(ctx, { name: "BAD", description: "d", content: "c" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("maps a ConvexError code → status (survives prod redaction)", async () => {
    // ConvexError surfaces as an error with structured `.data` (not redacted).
    const convexErr = Object.assign(new Error("[CONVEX] redacted"), {
      data: { code: "FORBIDDEN", message: "requires project admin" },
    });
    vi.mocked(convexCreateSkill).mockRejectedValue(convexErr);
    await expect(
      createCloudSkill(ctx, {
        name: "x",
        description: "d",
        content: "c",
        sharing: "project",
      }),
    ).rejects.toMatchObject({ status: 403, message: "requires project admin" });
  });

  it("maps a VALIDATION ConvexError code → 400", async () => {
    const convexErr = Object.assign(new Error("[CONVEX] redacted"), {
      data: { code: "VALIDATION", message: "bad name" },
    });
    vi.mocked(convexCreateSkill).mockRejectedValue(convexErr);
    await expect(
      createCloudSkill(ctx, { name: "x", description: "d", content: "c" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("wraps unknown errors as CloudSkillsError 500", async () => {
    vi.mocked(convexCreateSkill).mockRejectedValue(new Error("kaboom"));
    await expect(
      createCloudSkill(ctx, { name: "x", description: "d", content: "c" }),
    ).rejects.toBeInstanceOf(CloudSkillsError);
  });
});
