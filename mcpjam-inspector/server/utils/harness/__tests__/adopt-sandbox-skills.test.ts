import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../computers/convex-skills-client", () => ({
  convexAdoptComputerSkills: vi.fn(),
}));

import { adoptSandboxSkills } from "../adopt-sandbox-skills";
import { convexAdoptComputerSkills } from "../../computers/convex-skills-client";

const SKILLS_BASE = "/home/user/.claude/skills";

function skillMd(name: string, description = "Do things", body = "Step 1.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/**
 * Fake live session: `run` answers `ls -1` from `dirs`; `readTextFile` answers
 * `<base>/<name>/SKILL.md` from `files` (undefined ⇒ missing → null).
 */
function fakeSession(dirs: string[], files: Record<string, string | undefined>) {
  return {
    run: vi.fn(async ({ command }: { command: string }) => {
      if (command.startsWith("ls -1")) {
        return { exitCode: 0, stdout: dirs.join("\n"), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      for (const [name, content] of Object.entries(files)) {
        if (path === `${SKILLS_BASE}/${name}/SKILL.md`) return content ?? null;
      }
      return null;
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("adoptSandboxSkills", () => {
  it("adopts a valid unmanaged dir and returns its skillId for the manifest", async () => {
    vi.mocked(convexAdoptComputerSkills).mockResolvedValue({
      results: [{ name: "pdf-tools", status: "adopted", skillId: "sk_1" }],
    });
    const session = fakeSession(["pdf-tools"], {
      "pdf-tools": skillMd("pdf-tools"),
    });
    const out = await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    expect(out.adopted).toEqual([{ skillId: "sk_1", name: "pdf-tools" }]);
    // The backend received exactly the parsed candidate.
    expect(convexAdoptComputerSkills).toHaveBeenCalledWith("Bearer x", "proj_1", [
      { name: "pdf-tools", description: "Do things", content: "Step 1." },
    ]);
  });

  it("skips a dir already delivered as a cloud skill (managedNames)", async () => {
    const session = fakeSession(["shared-skill"], {
      "shared-skill": skillMd("shared-skill"),
    });
    const out = await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(["shared-skill"]),
    });
    expect(convexAdoptComputerSkills).not.toHaveBeenCalled();
    expect(out.adopted).toEqual([]);
  });

  it("skips a dir whose name != frontmatter name", async () => {
    const session = fakeSession(["on-disk-name"], {
      "on-disk-name": skillMd("frontmatter-name"),
    });
    const out = await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    expect(convexAdoptComputerSkills).not.toHaveBeenCalled();
    expect(out.adopted).toEqual([]);
  });

  it("truncates an overlong description rather than rejecting (lenient)", async () => {
    vi.mocked(convexAdoptComputerSkills).mockResolvedValue({ results: [] });
    const longDesc = "a".repeat(2000);
    const session = fakeSession(["big-desc"], {
      "big-desc": skillMd("big-desc", longDesc),
    });
    await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    const candidates = vi.mocked(convexAdoptComputerSkills).mock.calls[0][2];
    expect(candidates[0].description.length).toBe(1024);
  });

  it("preserves allowed-tools (comma string → array) as extraFrontmatter", async () => {
    vi.mocked(convexAdoptComputerSkills).mockResolvedValue({ results: [] });
    const md = `---\nname: with-tools\ndescription: d\nallowed-tools: Bash, Read\nlicense: MIT\n---\n\nbody\n`;
    const session = fakeSession(["with-tools"], { "with-tools": md });
    await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    const candidates = vi.mocked(convexAdoptComputerSkills).mock.calls[0][2];
    expect(candidates[0].extraFrontmatter).toEqual({
      license: "MIT",
      allowedTools: ["Bash", "Read"],
    });
  });

  it("does NOT adopt a file-backed dir (SKILL.md-only adoption)", async () => {
    // `find` reports a supporting file → the dir is skipped (would otherwise lose
    // those files after a reset / on a later cloud delete).
    const session = {
      run: vi.fn(async ({ command }: { command: string }) => {
        if (command.startsWith("ls -1")) {
          return { exitCode: 0, stdout: "file-skill", stderr: "" };
        }
        if (command.startsWith("find")) {
          return {
            exitCode: 0,
            stdout: `${SKILLS_BASE}/file-skill/scripts/run.py`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      readTextFile: vi.fn(async ({ path }: { path: string }) =>
        path === `${SKILLS_BASE}/file-skill/SKILL.md`
          ? skillMd("file-skill")
          : null,
      ),
    };
    const out = await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    expect(convexAdoptComputerSkills).not.toHaveBeenCalled();
    expect(out.adopted).toEqual([]);
  });

  it("skips a dir whose supporting-file scan errored (non-zero find exit)", async () => {
    // `find` exits non-zero (permission denied / dir vanished mid-scan) → we
    // can't prove the dir is SKILL.md-only, so it's treated conservatively as
    // file-backed and skipped (adopting it stripped could later delete its
    // un-adopted files under managed reconciliation).
    const session = {
      run: vi.fn(async ({ command }: { command: string }) => {
        if (command.startsWith("ls -1")) {
          return { exitCode: 0, stdout: "maybe-file-skill", stderr: "" };
        }
        if (command.startsWith("find")) {
          return { exitCode: 1, stdout: "", stderr: "Permission denied" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      readTextFile: vi.fn(async ({ path }: { path: string }) =>
        path === `${SKILLS_BASE}/maybe-file-skill/SKILL.md`
          ? skillMd("maybe-file-skill")
          : null,
      ),
    };
    const out = await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    expect(convexAdoptComputerSkills).not.toHaveBeenCalled();
    expect(out.adopted).toEqual([]);
  });

  it("skips dirs with no SKILL.md and caps the batch at 5", async () => {
    vi.mocked(convexAdoptComputerSkills).mockResolvedValue({ results: [] });
    const dirs = ["a", "b", "c", "d", "e", "f", "g", "no-md"];
    const files: Record<string, string | undefined> = { "no-md": undefined };
    for (const d of ["a", "b", "c", "d", "e", "f", "g"]) files[d] = skillMd(d);
    const session = fakeSession(dirs, files);
    await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    const candidates = vi.mocked(convexAdoptComputerSkills).mock.calls[0][2];
    expect(candidates.length).toBe(5); // MAX_ADOPT_PER_TURN
  });

  it("is fail-soft when the skills base dir is absent (ls non-zero)", async () => {
    const session = {
      run: vi.fn(async () => ({ exitCode: 2, stdout: "", stderr: "No such file" })),
      readTextFile: vi.fn(),
    };
    const out = await adoptSandboxSkills({
      session,
      authHeader: "Bearer x",
      projectId: "proj_1",
      managedNames: new Set(),
    });
    expect(out.adopted).toEqual([]);
    expect(convexAdoptComputerSkills).not.toHaveBeenCalled();
  });
});
