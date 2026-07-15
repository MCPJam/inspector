import { describe, it, expect } from "vitest";
import {
  appendManagedSkills,
  reconcileSkillDirs,
  type ReconcileSession,
} from "../reconcile-skill-dirs";

const MANIFEST = "/home/user/.claude/skills/.mcpjam-skills.json";

/** In-memory session: tracks files + the `rm -rf` commands issued. */
function makeSession(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const removed: string[] = [];
  const session: ReconcileSession = {
    readTextFile: async ({ path }) => files.get(path) ?? null,
    writeTextFile: async ({ path, content }) => {
      files.set(path, content);
      return undefined;
    },
    run: async ({ command }) => {
      // The path is POSIX single-quoted (shared shellQuote); capture the whole
      // quoted arg and de-escape embedded quotes.
      const m = command.match(/rm -rf -- '(.*)'$/);
      if (m) removed.push(m[1].replace(/'\\''/g, "'"));
      return undefined;
    },
  };
  return { session, files, removed };
}

function manifest(skills: Record<string, string>, skillsHash = "h") {
  return JSON.stringify({
    schemaVersion: 1,
    skillsHash,
    skills: Object.fromEntries(
      Object.entries(skills).map(([skillId, name]) => [
        skillId,
        { skillId, name },
      ]),
    ),
  });
}

describe("reconcileSkillDirs (cleanup-only)", () => {
  it("removes a managed dir whose skill is gone from Convex (orphan)", async () => {
    const { session, removed } = makeSession({
      [MANIFEST]: manifest({ s1: "pdf", s2: "old" }),
    });
    const res = await reconcileSkillDirs({
      session,
      skills: [{ skillId: "s1", name: "pdf" }],
      skillsHash: "h2",
    });
    expect(removed).toEqual(["/home/user/.claude/skills/old"]);
    expect(res.removed).toBe(1);
  });

  it("removes the OLD dir on a rename", async () => {
    const { session, removed } = makeSession({
      [MANIFEST]: manifest({ s1: "pdf" }),
    });
    await reconcileSkillDirs({
      session,
      skills: [{ skillId: "s1", name: "pdf-tools" }],
      skillsHash: "h2",
    });
    expect(removed).toEqual(["/home/user/.claude/skills/pdf"]);
  });

  it("never touches a hand-placed (unmanaged) dir", async () => {
    const { session, removed } = makeSession({
      [MANIFEST]: manifest({ s1: "pdf" }),
    });
    // "handmade" is not in the manifest, so it must be preserved.
    await reconcileSkillDirs({
      session,
      skills: [{ skillId: "s1", name: "pdf" }],
      skillsHash: "h",
    });
    expect(removed).toEqual([]);
  });

  it("persists the current skillsHash in the manifest", async () => {
    const { session, files } = makeSession();
    await reconcileSkillDirs({
      session,
      skills: [{ skillId: "s1", name: "pdf" }],
      skillsHash: "newhash",
    });
    const written = JSON.parse(files.get(MANIFEST)!);
    expect(written.skillsHash).toBe("newhash");
    expect(written.skills.s1).toEqual({ skillId: "s1", name: "pdf" });
  });

  it("tolerates the legacy materializer manifest shape (with aggregateHash)", async () => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      skills: { s1: { skillId: "s1", name: "pdf", aggregateHash: "x" } },
    });
    const { session, removed } = makeSession({ [MANIFEST]: legacy });
    await reconcileSkillDirs({
      session,
      skills: [], // all gone now
      skillsHash: "",
    });
    expect(removed).toEqual(["/home/user/.claude/skills/pdf"]);
  });

  it("is fail-soft — a session error never throws", async () => {
    const session: ReconcileSession = {
      readTextFile: async () => {
        throw new Error("box unreachable");
      },
      writeTextFile: async () => {
        throw new Error("box unreachable");
      },
      run: async () => undefined,
    };
    await expect(
      reconcileSkillDirs({ session, skills: [], skillsHash: "" }),
    ).resolves.toBeDefined();
  });
});

describe("appendManagedSkills", () => {
  it("merges adopted entries into the manifest, preserving prior entries + hash", async () => {
    const { session, files } = makeSession({
      [MANIFEST]: manifest({ s1: "pdf" }, "existing-hash"),
    });
    const res = await appendManagedSkills({
      session,
      skills: [{ skillId: "s2", name: "adopted-one" }],
    });
    expect(res.appended).toBe(1);
    const written = JSON.parse(files.get(MANIFEST)!);
    expect(written.skills.s1).toEqual({ skillId: "s1", name: "pdf" });
    expect(written.skills.s2).toEqual({ skillId: "s2", name: "adopted-one" });
    // skillsHash is untouched (append is not a delivery).
    expect(written.skillsHash).toBe("existing-hash");
  });

  it("is a no-op for an empty list (no manifest write)", async () => {
    const { session, files } = makeSession();
    const res = await appendManagedSkills({ session, skills: [] });
    expect(res.appended).toBe(0);
    expect(files.get(MANIFEST)).toBeUndefined();
  });

  it("starts a fresh manifest when none exists", async () => {
    const { session, files } = makeSession();
    await appendManagedSkills({
      session,
      skills: [{ skillId: "s1", name: "from-box" }],
    });
    const written = JSON.parse(files.get(MANIFEST)!);
    expect(written.schemaVersion).toBe(1);
    expect(written.skills.s1).toEqual({ skillId: "s1", name: "from-box" });
  });
});
