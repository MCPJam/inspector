import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// Route-level tests for /api/web/skills/*. The cloud-skills SERVICE (E2B +
// control plane) is mocked; these tests cover request parsing, bearer-gating,
// the success envelopes, and CloudSkillsError → HTTP status mapping.

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
    listCloudSkills: vi.fn(),
    getCloudSkill: vi.fn(),
    uploadCloudSkill: vi.fn(),
    uploadCloudSkillFolder: vi.fn(),
    deleteCloudSkill: vi.fn(),
    listCloudSkillFiles: vi.fn(),
    readCloudSkillFile: vi.fn(),
  };
});

import skillsRouter from "../skills";
import {
  CloudSkillsError,
  listCloudSkills,
  getCloudSkill,
  deleteCloudSkill,
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
  it("returns the computer's skills", async () => {
    vi.mocked(listCloudSkills).mockResolvedValue([
      { name: "pdf", description: "PDFs", path: "~/.claude/skills/pdf" },
    ]);
    const res = await post("/api/web/skills/list", { projectId: "proj_1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skills: [{ name: "pdf", description: "PDFs", path: "~/.claude/skills/pdf" }],
    });
    expect(vi.mocked(listCloudSkills)).toHaveBeenCalledWith(
      expect.objectContaining({
        authHeader: "Bearer user-token",
        projectId: "proj_1",
      }),
    );
  });

  it("rejects requests without a bearer token", async () => {
    const res = await post("/api/web/skills/list", { projectId: "proj_1" }, {});
    expect(res.status).toBe(401);
    expect(vi.mocked(listCloudSkills)).not.toHaveBeenCalled();
  });

  it("rejects a missing projectId", async () => {
    const res = await post("/api/web/skills/list", {});
    expect(res.status).toBe(400);
  });

  it("maps a service 503 to FEATURE_NOT_SUPPORTED", async () => {
    vi.mocked(listCloudSkills).mockRejectedValue(
      new CloudSkillsError("Computers are not configured on this server.", 503),
    );
    const res = await post("/api/web/skills/list", { projectId: "proj_1" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "FEATURE_NOT_SUPPORTED" });
  });
});

describe("POST /api/web/skills/get", () => {
  it("404s when the skill is absent", async () => {
    vi.mocked(getCloudSkill).mockResolvedValue(null);
    const res = await post("/api/web/skills/get", {
      projectId: "proj_1",
      name: "nope",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/web/skills/delete", () => {
  it("404s when nothing was deleted", async () => {
    vi.mocked(deleteCloudSkill).mockResolvedValue(false);
    const res = await post("/api/web/skills/delete", {
      projectId: "proj_1",
      name: "nope",
    });
    expect(res.status).toBe(404);
  });

  it("returns success when deleted", async () => {
    vi.mocked(deleteCloudSkill).mockResolvedValue(true);
    const res = await post("/api/web/skills/delete", {
      projectId: "proj_1",
      name: "temp",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});
