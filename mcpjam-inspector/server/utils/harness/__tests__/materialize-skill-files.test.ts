import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { materializeSkillFiles } from "../materialize-skill-files";
import type { RuntimeSkillFile } from "../runtime-skills";

const SKILLS_BASE = "/home/user/.claude/skills";

function fakeSession(onBoxFiles: string[] = []) {
  const writes: { path: string; bytes: number }[] = [];
  const removed: string[] = [];
  return {
    session: {
      writeBinaryFile: vi.fn(
        async ({ path, content }: { path: string; content: Uint8Array }) => {
          writes.push({ path, bytes: content.byteLength });
        }
      ),
      run: vi.fn(async ({ command }: { command: string }) => {
        if (command.startsWith("find")) {
          return { exitCode: 0, stdout: onBoxFiles.join("\n"), stderr: "" };
        }
        if (command.startsWith("rm")) {
          const m = command.match(/rm -f -- (\S+)/);
          // The path is POSIX single-quoted; strip the surrounding quotes.
          if (m) removed.push(m[1].replace(/^'|'$/g, ""));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    },
    writes,
    removed,
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
    }))
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

  it("enforces the budget against ACTUAL bytes when declared size understates", async () => {
    // First file is large-but-honest and consumes nearly the whole budget; the
    // second declares size 1 but actually returns 5 bytes — enough to overflow
    // the remaining budget, so the actual-byte guard (not the declared-size
    // pre-check) must reject it. Removing that guard would let the second write
    // through and fail this test.
    const almostBudget = 20 * 1024 * 1024 - 1;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return {
          ok: true,
          arrayBuffer: async () =>
            call === 1
              ? new Uint8Array(almostBudget).buffer
              : new Uint8Array([1, 2, 3, 4, 5]).buffer,
        };
      })
    );
    const { session, writes } = fakeSession();
    const res = await materializeSkillFiles({
      session,
      files: [
        file({ path: "large.bin", size: almostBudget }),
        file({ path: "understated.bin", size: 1 }),
      ],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(writes).toEqual([
      { path: `${SKILLS_BASE}/pdf-tools/large.bin`, bytes: almostBudget },
    ]);
    expect(res).toEqual({ written: 1, skipped: 1 });
  });

  it("prunes stale on-box supporting files not in the current set", async () => {
    const base = `${SKILLS_BASE}/pdf-tools`;
    const { session, removed } = fakeSession([
      `${base}/scripts/run.py`, // current — keep
      `${base}/scripts/old.py`, // stale — remove
      `${base}/SKILL.md`, // never touched
    ]);
    await materializeSkillFiles({
      session,
      files: [file({ path: "scripts/run.py" })],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(removed).toEqual([`${base}/scripts/old.py`]);
  });

  it("prunes a delivered skill whose file set became empty", async () => {
    // The skill is still delivered (in skillNamesById) but has NO files this
    // turn — its orphaned on-box file must still be removed, since reconcile
    // won't touch an existing skill's dir.
    const base = `${SKILLS_BASE}/pdf-tools`;
    const { session, removed } = fakeSession([
      `${base}/scripts/orphan.py`,
      `${base}/SKILL.md`,
    ]);
    const res = await materializeSkillFiles({
      session,
      files: [],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(removed).toEqual([`${base}/scripts/orphan.py`]);
    expect(res).toEqual({ written: 0, skipped: 0 });
  });

  it("never prunes an undelivered (foreign / hand-placed) skill dir", async () => {
    // A file under a dir NOT in skillNamesById must be left alone.
    const other = `${SKILLS_BASE}/hand-placed`;
    const { session, removed } = fakeSession([`${other}/scripts/keep.py`]);
    await materializeSkillFiles({
      session,
      files: [file({ path: "scripts/run.py" })],
      skillNamesById: new Map([["sk_1", "pdf-tools"]]),
    });
    expect(removed).toEqual([]);
  });
});
