import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../computers/convex-skills-client", () => ({
  convexListSkillsForMaterialize: vi.fn(),
}));

import { materializeSkills } from "../computers/materialize-skills";
import { convexListSkillsForMaterialize } from "../computers/convex-skills-client";

const BASE = "/home/user/.claude/skills";
const MANIFEST = `${BASE}/.mcpjam-skills.json`;

// In-memory sandbox session: file map + an `rm -rf -- <dir>` aware `run`.
class FakeSession {
  files = new Map<string, string>();
  async readTextFile({ path }: { path: string }) {
    return this.files.has(path) ? this.files.get(path)! : null;
  }
  async writeTextFile({ path, content }: { path: string; content: string }) {
    this.files.set(path, content);
  }
  async run({ command }: { command: string }) {
    const m = command.match(/^rm -rf -- (.+)$/);
    if (m) {
      const dir = m[1];
      for (const k of [...this.files.keys()]) {
        if (k === dir || k.startsWith(dir + "/")) this.files.delete(k);
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

function seedManifest(
  session: FakeSession,
  skills: { skillId: string; name: string; aggregateHash: string }[],
) {
  const map: Record<string, unknown> = {};
  for (const s of skills) map[s.skillId] = s;
  session.files.set(
    MANIFEST,
    JSON.stringify({ schemaVersion: 1, skills: map }),
  );
}

function materialView(
  skillId: string,
  name: string,
  aggregateHash: string,
  skillMd = `# ${name}`,
) {
  return { skillId, name, aggregateHash, skillMd };
}

const ARGS = (session: FakeSession) => ({
  session,
  projectId: "proj_1",
  bearer: "Bearer jwt",
});

beforeEach(() => vi.clearAllMocks());

describe("materializeSkills", () => {
  it("writes every skill on a fresh box + records the manifest", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockResolvedValue([
      materialView("s1", "pdf", "h1", "PDF instructions"),
    ]);
    const s = new FakeSession();
    const res = await materializeSkills(ARGS(s));
    expect(res.written).toBe(1);
    expect(s.files.get(`${BASE}/pdf/SKILL.md`)).toBe("PDF instructions");
    expect(JSON.parse(s.files.get(MANIFEST)!).skills.s1.aggregateHash).toBe("h1");
  });

  it("skips a skill whose hash already matches", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockResolvedValue([
      materialView("s1", "pdf", "h1"),
    ]);
    const s = new FakeSession();
    seedManifest(s, [{ skillId: "s1", name: "pdf", aggregateHash: "h1" }]);
    s.files.set(`${BASE}/pdf/SKILL.md`, "# pdf");
    const res = await materializeSkills(ARGS(s));
    expect(res.skipped).toBe(1);
    expect(res.written).toBe(0);
  });

  it("rewrites a changed skill", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockResolvedValue([
      materialView("s1", "pdf", "h2", "NEW"),
    ]);
    const s = new FakeSession();
    seedManifest(s, [{ skillId: "s1", name: "pdf", aggregateHash: "h1" }]);
    s.files.set(`${BASE}/pdf/SKILL.md`, "OLD");
    const res = await materializeSkills(ARGS(s));
    expect(res.written).toBe(1);
    expect(s.files.get(`${BASE}/pdf/SKILL.md`)).toBe("NEW");
  });

  it("removes a managed skill that's gone from Convex", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockResolvedValue([
      materialView("s1", "keep", "h1"),
    ]);
    const s = new FakeSession();
    seedManifest(s, [
      { skillId: "s1", name: "keep", aggregateHash: "h1" },
      { skillId: "s2", name: "gone", aggregateHash: "h9" },
    ]);
    s.files.set(`${BASE}/keep/SKILL.md`, "# keep");
    s.files.set(`${BASE}/gone/SKILL.md`, "# gone");
    const res = await materializeSkills(ARGS(s));
    expect(res.removed).toBe(1);
    expect(s.files.has(`${BASE}/gone/SKILL.md`)).toBe(false);
    expect(s.files.has(`${BASE}/keep/SKILL.md`)).toBe(true);
  });

  it("handles a rename: removes the old dir, writes the new", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockResolvedValue([
      materialView("s1", "newname", "h1"),
    ]);
    const s = new FakeSession();
    seedManifest(s, [{ skillId: "s1", name: "oldname", aggregateHash: "h1" }]);
    s.files.set(`${BASE}/oldname/SKILL.md`, "# old");
    const res = await materializeSkills(ARGS(s));
    expect(s.files.has(`${BASE}/oldname/SKILL.md`)).toBe(false);
    expect(s.files.has(`${BASE}/newname/SKILL.md`)).toBe(true);
    expect(res.written).toBe(1);
  });

  it("never touches an unmanaged (hand-placed) skill dir", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockResolvedValue([]);
    const s = new FakeSession();
    s.files.set(`${BASE}/handmade/SKILL.md`, "# mine");
    await materializeSkills(ARGS(s));
    expect(s.files.has(`${BASE}/handmade/SKILL.md`)).toBe(true);
  });

  it("defensively skips an invalid skill name", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockResolvedValue([
      materialView("s1", "Bad Name", "h1"),
    ]);
    const s = new FakeSession();
    const res = await materializeSkills(ARGS(s));
    expect(res.written).toBe(0);
    expect([...s.files.keys()].some((k) => k.includes("Bad"))).toBe(false);
  });

  it("never throws when Convex is unreachable", async () => {
    vi.mocked(convexListSkillsForMaterialize).mockRejectedValue(
      new Error("network down"),
    );
    const s = new FakeSession();
    const res = await materializeSkills(ARGS(s));
    expect(res).toEqual({ written: 0, removed: 0, skipped: 0 });
  });
});
