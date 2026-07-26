import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { materializeSkillFiles } from "../materialize-skill-files";
import type { RuntimeSkillFile } from "../runtime-skills";
import { reserveUploadBytes } from "../../computers/control-plane-client.js";

// The quota client is a network call; stub it so metering is deterministic.
// Default: allow (reserved). Existing tests pass no `computerId`, so it's never
// called there and the default is irrelevant to them.
vi.mock("../../computers/control-plane-client.js", () => ({
  reserveUploadBytes: vi.fn(async () => ({
    ok: true as const,
    value: { total: 0, cap: 500 * 1024 * 1024 },
  })),
}));
const mockReserve = vi.mocked(reserveUploadBytes);

const SKILLS_BASE = "/home/user/.claude/skills";

function fakeSession(
  onBoxFiles: string[] = [],
  sizeByPath: Record<string, number> = {}
) {
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
          // The size-gathering sweep (getOnBoxFileSizes) uses `-printf` and
          // expects "<size>\t<path>" lines; the prune sweep lists bare paths.
          if (command.includes("-printf")) {
            const lines = Object.entries(sizeByPath).map(
              ([p, s]) => `${s}\t${p}`
            );
            return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
          }
          return { exitCode: 0, stdout: onBoxFiles.join("\n"), stderr: "" };
        }
        if (command.startsWith("rm")) {
          // The path is POSIX single-quoted; capture the whole quoted arg
          // (spaces included) and de-escape embedded quotes to match shellQuote.
          const m = command.match(/rm -f -- '(.*)'$/);
          if (m) removed.push(m[1].replace(/'\\''/g, "'"));
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
  mockReserve.mockReset();
  mockReserve.mockResolvedValue({
    ok: true,
    value: { total: 0, cap: 500 * 1024 * 1024 },
  });
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

  it("filters a PROJECT-WIDE file set down to the delivered skills (environment turns)", async () => {
    // A Project-Environment harness turn delivers only the environment's
    // resolved skills, but the supporting-file query stays project-wide. This
    // filtering is what makes that safe, so it is locked here rather than left
    // implied: a file belonging to an undelivered project skill must not be
    // written (its dir does not exist), and the prune sweep must not touch that
    // skill's dir either.
    const undeliveredDir = `${SKILLS_BASE}/other-project-skill`;
    const { session, writes, removed } = fakeSession([
      `${SKILLS_BASE}/env-skill/scripts/run.py`,
      `${undeliveredDir}/scripts/legacy.py`,
    ]);
    const res = await materializeSkillFiles({
      session,
      files: [
        // Delivered by the environment.
        file({ skillId: "sk_env", path: "scripts/run.py" }),
        // Project-wide extras the environment did NOT deliver.
        file({ skillId: "sk_other", path: "scripts/legacy.py" }),
        file({ skillId: "sk_other_2", path: "assets/logo.png" }),
      ],
      // Built from the DELIVERED skills alone.
      skillNamesById: new Map([["sk_env", "env-skill"]]),
    });

    expect(res.written).toBe(1);
    expect(res.skipped).toBe(2);
    expect(writes.map((w) => w.path)).toEqual([
      `${SKILLS_BASE}/env-skill/scripts/run.py`,
    ]);
    expect(writes.some((w) => w.path.includes("other-project-skill"))).toBe(
      false
    );
    // The undelivered skill's dir is not a prune candidate — its on-box files
    // survive untouched.
    expect(removed).toEqual([]);
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

  describe("cumulative upload quota (computerId present)", () => {
    const target = `${SKILLS_BASE}/pdf-tools/scripts/run.py`;

    it("does not meter at all when computerId is absent", async () => {
      const { session } = fakeSession();
      await materializeSkillFiles({
        session,
        files: [file({})],
        skillNamesById: new Map([["sk_1", "pdf-tools"]]),
      });
      expect(mockReserve).not.toHaveBeenCalled();
    });

    it("reserves the full size for a net-new file (not on box)", async () => {
      const { session, writes } = fakeSession();
      const res = await materializeSkillFiles({
        session,
        files: [file({})], // 5 bytes from the fetch stub
        skillNamesById: new Map([["sk_1", "pdf-tools"]]),
        computerId: "computers_1",
      });
      expect(mockReserve).toHaveBeenCalledWith({
        computerId: "computers_1",
        bytes: 5,
      });
      expect(res.written).toBe(1);
      expect(writes).toHaveLength(1);
    });

    it("reserves only the delta when a larger version replaces a smaller on-box file", async () => {
      // On box: 2 bytes at the target; new content is 5 → delta 3.
      const { session } = fakeSession([], { [target]: 2 });
      await materializeSkillFiles({
        session,
        files: [file({})],
        skillNamesById: new Map([["sk_1", "pdf-tools"]]),
        computerId: "computers_1",
      });
      expect(mockReserve).toHaveBeenCalledWith({
        computerId: "computers_1",
        bytes: 3,
      });
    });

    it("reserves nothing when re-materializing an unchanged file (same size)", async () => {
      // On box: already 5 bytes at the target; content is 5 → delta 0.
      const { session, writes } = fakeSession([], { [target]: 5 });
      const res = await materializeSkillFiles({
        session,
        files: [file({})],
        skillNamesById: new Map([["sk_1", "pdf-tools"]]),
        computerId: "computers_1",
      });
      expect(mockReserve).not.toHaveBeenCalled();
      // Still written (idempotent rewrite) — the quota just isn't charged again.
      expect(res.written).toBe(1);
      expect(writes).toHaveLength(1);
    });

    it("skips the file (no write) when the reserve is over quota (413)", async () => {
      mockReserve.mockResolvedValue({
        ok: false,
        status: 413,
        error: "over quota",
      });
      const { session, writes } = fakeSession();
      const res = await materializeSkillFiles({
        session,
        files: [file({})],
        skillNamesById: new Map([["sk_1", "pdf-tools"]]),
        computerId: "computers_1",
      });
      expect(res.written).toBe(0);
      expect(res.skipped).toBe(1);
      expect(writes).toHaveLength(0);
    });

    it("fails OPEN (still writes) when the reserve route is unavailable (non-413)", async () => {
      mockReserve.mockResolvedValue({
        ok: false,
        status: 404,
        error: "route not deployed",
      });
      const { session, writes } = fakeSession();
      const res = await materializeSkillFiles({
        session,
        files: [file({})],
        skillNamesById: new Map([["sk_1", "pdf-tools"]]),
        computerId: "computers_1",
      });
      expect(res.written).toBe(1);
      expect(writes).toHaveLength(1);
    });
  });
});
