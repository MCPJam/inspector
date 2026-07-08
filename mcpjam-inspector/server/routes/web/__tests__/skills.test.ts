import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// Route-level tests for /api/web/skills/* (Convex-sourced). The cloud-skills
// SERVICE and the Convex-bearer exchange are mocked; these cover request
// parsing, success envelopes, and CloudSkillsError → HTTP status mapping.

vi.mock("../../../utils/v1-convex-token", () => ({
  getConvexBearerForRequest: vi.fn(async () => "convex-jwt"),
}));

vi.mock("../../../utils/computers/cloud-skills", () => {
  class CloudSkillsError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  return {
    CloudSkillsError,
    MAX_SKILL_CONTENT_BYTES: 128 * 1024,
    listCloudSkills: vi.fn(),
    getCloudSkill: vi.fn(),
    createCloudSkill: vi.fn(),
    updateCloudSkill: vi.fn(),
    deleteCloudSkill: vi.fn(),
    promoteCloudSkill: vi.fn(),
  };
});

import skillsRouter from "../skills";
import {
  CloudSkillsError,
  listCloudSkills,
  createCloudSkill,
  deleteCloudSkill,
  promoteCloudSkill,
} from "../../../utils/computers/cloud-skills";

function createApp() {
  const app = new Hono();
  app.route("/api/web/skills", skillsRouter);
  return app;
}

function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { authorization: "Bearer user-token" },
) {
  return createApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/web/skills/list", () => {
  it("returns the project's skills", async () => {
    vi.mocked(listCloudSkills).mockResolvedValue([
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
    const res = await post("/api/web/skills/list", { projectId: "proj_1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills[0].name).toBe("pdf");
    expect(vi.mocked(listCloudSkills)).toHaveBeenCalledWith(
      expect.objectContaining({ authHeader: "convex-jwt", projectId: "proj_1" }),
    );
  });

  it("rejects a missing projectId", async () => {
    const res = await post("/api/web/skills/list", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/web/skills/create", () => {
  it("creates and returns the skill", async () => {
    vi.mocked(createCloudSkill).mockResolvedValue({
      skillId: "s2",
      projectId: "proj_1",
      name: "greeter",
      description: "hi",
      sharing: "user",
      isOwner: true,
      content: "wave",
      aggregateHash: "h",
      createdAt: 1,
      updatedAt: 1,
    });
    const res = await post("/api/web/skills/create", {
      projectId: "proj_1",
      name: "greeter",
      description: "hi",
      content: "wave",
      sharing: "user",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).skill.skillId).toBe("s2");
  });

  it("maps an admin-gate (403) from the service", async () => {
    vi.mocked(createCloudSkill).mockRejectedValue(
      new CloudSkillsError("requires project admin", 403),
    );
    const res = await post("/api/web/skills/create", {
      projectId: "proj_1",
      name: "team",
      description: "d",
      content: "c",
      sharing: "project",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("FORBIDDEN");
  });
});

describe("POST /api/web/skills/delete + /promote", () => {
  it("delete maps a 404 from the service", async () => {
    vi.mocked(deleteCloudSkill).mockRejectedValue(
      new CloudSkillsError("Skill not found", 404),
    );
    const res = await post("/api/web/skills/delete", {
      projectId: "proj_1",
      skillId: "missing",
    });
    expect(res.status).toBe(404);
  });

  it("promote returns the shared skill", async () => {
    vi.mocked(promoteCloudSkill).mockResolvedValue({
      skillId: "s1",
      projectId: "proj_1",
      name: "pdf",
      description: "d",
      sharing: "project",
      isOwner: false,
      content: "c",
      aggregateHash: "h",
      createdAt: 1,
      updatedAt: 1,
    });
    const res = await post("/api/web/skills/promote", {
      projectId: "proj_1",
      skillId: "s1",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).skill.sharing).toBe("project");
  });
});
