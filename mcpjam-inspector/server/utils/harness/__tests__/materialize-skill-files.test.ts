import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { materializeSkillFiles } from "../materialize-skill-files";
import type { RuntimeSkillFile } from "../runtime-skills";

const SKILLS_BASE = "/home/user/.claude/skills";

function fakeSession() {
  const writes: { path: string; bytes: number }[] = [];
  return {
    session: {
      writeBinaryFile: vi.fn(
        async ({ path, content }: { path: string; content: Uint8Array }) => {
          writes.push({ path, bytes: content.byteLength });
        },
      ),
    },
    writes,
  };
}

const file = (over: Partial<RuntimeSkillFile>): RuntimeSkillFile => ({
  skillId: "sk_1",
  path: "scripts/run.py",
  size: 5,
  url: "https://blob/1",
  ...over,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("materializeSkillFiles", () => {
  it("has a zero-cost fast path when there are no files", async () => {
    const { session } = fakeSession();
    const res = await materializeSkillFiles({
      session,
      files: [],
      skillNamesById: new Map(),
    });
    expect(res).toEqual({ written: 0, skipped: 0 });
    expect(session.writeBinaryFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes a file under its skill dir", async () => {
    const { session, writes } = fakeSession();
    const res = await materializeSkillFiles({
      session,
      files: [file({})],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(res.written).toBe(1);
    expect(writes[0].path).toBe(`${SKILLS_BASE}/pdf-tools/scripts/run.py`);
  });

  it("skips a file whose skill wasn't delivered this turn", async () => {
    const { session } = fakeSession();
    const res = await materializeSkillFiles({
      session,
      files: [file({ skillId: "unknown" })],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(1);
    expect(session.writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a path that escapes the skill dir (defense-in-depth)", async () => {
    const { session } = fakeSession();
    const res = await materializeSkillFiles({
      session,
      files: [file({ path: "../../etc/evil" })],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(res.skipped).toBe(1);
    expect(session.writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a file with no URL", async () => {
    const { session } = fakeSession();
    const res = await materializeSkillFiles({
      session,
      files: [file({ url: null })],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(res.skipped).toBe(1);
  });

  it("skips a file that exceeds the per-turn budget", async () => {
    const { session } = fakeSession();
    const res = await materializeSkillFiles({
      session,
      files: [file({ size: 21 * 1024 * 1024 })],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(1);
  });
});
