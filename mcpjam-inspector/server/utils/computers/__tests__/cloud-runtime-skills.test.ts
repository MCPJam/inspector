/**
 * The project pool as a live capability family.
 *
 * The catalog fetch and its failure modes used to sit inside `prepareChatV2`,
 * which is why an orchestration test had to know about Convex timeouts. They
 * live here now: a route asks for the family, and what it does with a failure
 * (log it, proceed without skills, keep the turn) is the route's call.
 *
 * What this pins is that the family stays LAZY. A project with 200 skills must
 * cost one catalog query to build a listing, not 200 body fetches for content
 * the model will mostly never ask for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cloud-skills.js", () => ({
  listCloudSkills: vi.fn(),
  getCloudSkillByName: vi.fn(),
  listCloudSkillFiles: vi.fn(),
  readCloudSkillFile: vi.fn(),
  CloudSkillsError: class CloudSkillsError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  MAX_SKILL_CONTENT_BYTES: 128 * 1024,
}));

import { listCloudRuntimeSkills } from "../cloud-skill-tools.js";
import {
  getCloudSkillByName,
  listCloudSkillFiles,
  listCloudSkills,
  readCloudSkillFile,
} from "../cloud-skills.js";

const ctx = { authHeader: "Bearer t", projectId: "proj-1" };

const CATALOG_ROW = {
  skillId: "sk_1",
  projectId: "proj-1",
  name: "pdf-tools",
  description: "Process PDFs",
  sharing: "user" as const,
  isOwner: true,
  aggregateHash: "h",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listCloudRuntimeSkills", () => {
  it("builds the family from the catalog alone, fetching no bodies", async () => {
    vi.mocked(listCloudSkills).mockResolvedValue([CATALOG_ROW] as never);

    const skills = await listCloudRuntimeSkills(ctx);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.ref).toBe("pdf-tools");
    expect(skills[0]!.description).toBe("Process PDFs");
    expect(getCloudSkillByName).not.toHaveBeenCalled();
    expect(listCloudSkillFiles).not.toHaveBeenCalled();
  });

  it("fetches one body, for the one skill asked for", async () => {
    vi.mocked(listCloudSkills).mockResolvedValue([CATALOG_ROW] as never);
    vi.mocked(getCloudSkillByName).mockResolvedValue({
      ...CATALOG_ROW,
      content: "# PDF tools",
    } as never);

    const skills = await listCloudRuntimeSkills(ctx);
    const content = skills[0]!.content;
    expect(typeof content).toBe("function");
    await expect((content as () => Promise<string>)()).resolves.toContain(
      "# PDF tools"
    );
    expect(getCloudSkillByName).toHaveBeenCalledTimes(1);
  });

  it("says so when a skill vanished between catalog and load", async () => {
    vi.mocked(listCloudSkills).mockResolvedValue([CATALOG_ROW] as never);
    vi.mocked(getCloudSkillByName).mockResolvedValue(null as never);

    const skills = await listCloudRuntimeSkills(ctx);

    await expect(
      (skills[0]!.content as () => Promise<string>)()
    ).rejects.toThrow(/no longer in this project/);
  });

  it("lists supporting files only when asked, and reads one at a time", async () => {
    vi.mocked(listCloudSkills).mockResolvedValue([CATALOG_ROW] as never);
    vi.mocked(listCloudSkillFiles).mockResolvedValue([
      { path: "scripts/run.py", size: 12, contentHash: "c", updatedAt: 1 },
    ] as never);
    vi.mocked(readCloudSkillFile).mockResolvedValue({
      path: "scripts/run.py",
      name: "run.py",
      content: "print('hi')",
      mimeType: "text/x-python",
      size: 12,
      isText: true,
    } as never);

    const skills = await listCloudRuntimeSkills(ctx);
    expect(listCloudSkillFiles).not.toHaveBeenCalled();

    const files = await skills[0]!.listFiles!();
    expect(files.map((file) => file.path)).toEqual(["scripts/run.py"]);
    // No URL is minted up front: `readCloudSkillFile` resolves a fresh signed
    // one at read time, so a file the model never opens costs nothing and a URL
    // never outlives the read it was for.
    expect(files[0]!.url).toBeNull();

    const bytes = await files[0]!.read!();
    expect(new TextDecoder().decode(bytes)).toContain("print('hi')");
  });

  it("throws on a catalog failure, so a caller can tell it from an empty project", async () => {
    // The distinction the route needs: "this user has no skills" and "we lost
    // this user's skills this turn" must not look identical.
    vi.mocked(listCloudSkills).mockRejectedValue(new Error("CONVEX_URL unset"));

    await expect(listCloudRuntimeSkills(ctx)).rejects.toThrow("CONVEX_URL unset");
  });
});
