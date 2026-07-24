import { describe, expect, it, vi } from "vitest";
import {
  materializePinnedSkillFiles,
  pinnedArtifactsToRuntimeSkills,
} from "../pinned-harness-skills.js";
import { skillsFingerprint } from "../runtime-skills.js";
import type { PinnedSkillArtifact } from "../../../../shared/skill-types.js";

const artifact = (
  over: Partial<PinnedSkillArtifact> = {}
): PinnedSkillArtifact => ({
  name: "my-skill",
  description: "does things",
  content: "# body",
  contentHash: "hash-1",
  ...over,
});

describe("pinnedArtifactsToRuntimeSkills", () => {
  it("maps artifacts onto the runtime-skill shape with aggregateHash = the pinned contentHash", () => {
    const skills = pinnedArtifactsToRuntimeSkills([
      artifact({ skillId: "sk1" }),
    ]);
    expect(skills).toEqual([
      {
        skillId: "sk1",
        name: "my-skill",
        description: "does things",
        content: "# body",
        aggregateHash: "hash-1",
      },
    ]);
  });

  it("synthesizes a content-derived skillId when the pin lost its source pointer", () => {
    const [s] = pinnedArtifactsToRuntimeSkills([artifact()]);
    expect(s!.skillId).toBe("pinned:hash-1");
  });

  it("skillsFingerprint over the mapped set derives from the pinned artifact fingerprints", () => {
    const a = skillsFingerprint(
      pinnedArtifactsToRuntimeSkills([artifact({ skillId: "sk1" })])
    );
    const b = skillsFingerprint(
      pinnedArtifactsToRuntimeSkills([
        artifact({ skillId: "sk1", contentHash: "hash-2" }),
      ])
    );
    expect(a).not.toBe(b); // a different pinned artifact ⇒ a different hash
    expect(skillsFingerprint(pinnedArtifactsToRuntimeSkills([]))).toBe(""); // empty pinned set ⇒ the stable empty sentinel
  });

  it("projects preserved frontmatter onto the known Agent-Skills envelope only", () => {
    const [s] = pinnedArtifactsToRuntimeSkills([
      artifact({
        frontmatter: {
          license: "MIT",
          "allowed-tools": ["Bash", "Read"],
          metadata: { origin: "plugin" },
          bogus: { nested: true },
        },
      }),
    ]);
    expect(s!.extraFrontmatter).toEqual({
      license: "MIT",
      allowedTools: ["Bash", "Read"],
      metadata: { origin: "plugin" },
    });
  });
});

describe("materializePinnedSkillFiles", () => {
  // `findStdout` seeds what the prune sweep's `find` reports as already on box
  // (default: nothing). Every test shares this one session builder so the mock
  // shape can't drift between them.
  const makeSession = (findStdout = "") => {
    const writes: Array<{ path: string; content: string }> = [];
    const commands: string[] = [];
    return {
      writes,
      commands,
      session: {
        writeTextFile: vi.fn(async (a: { path: string; content: string }) => {
          writes.push(a);
        }),
        run: vi.fn(async (a: { command: string }) => {
          commands.push(a.command);
          if (a.command.startsWith("find ")) {
            return { exitCode: 0, stdout: findStdout, stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      },
    };
  };

  it("writes inline text files under the skill's own dir", async () => {
    const { session, writes, commands } = makeSession();
    await materializePinnedSkillFiles({
      session,
      artifacts: [
        artifact({
          files: [{ path: "scripts/run.py", content: "print(1)" }],
        }),
      ],
    });
    expect(writes).toEqual([
      {
        path: "/home/user/.claude/skills/my-skill/scripts/run.py",
        content: "print(1)",
      },
    ]);
    expect(commands.some((c) => c.startsWith("mkdir -p "))).toBe(true);
  });

  it("skips a path that escapes the skill dir without any write/exec for it", async () => {
    const { session, writes, commands } = makeSession();
    await materializePinnedSkillFiles({
      session,
      artifacts: [
        artifact({
          files: [{ path: "../../evil.sh", content: "rm -rf /" }],
        }),
      ],
    });
    expect(writes).toEqual([]);
    // The rejected path must never reach mkdir, a binary write, or any other
    // command — not just be absent from writeTextFile.
    expect(commands.some((c) => c.includes("evil.sh"))).toBe(false);
    expect(commands.some((c) => c.startsWith("mkdir "))).toBe(false);
  });

  it("writes nothing for artifacts without files, but still runs the prune sweep", async () => {
    const { session, commands } = makeSession();
    await materializePinnedSkillFiles({ session, artifacts: [artifact()] });
    expect(session.writeTextFile).not.toHaveBeenCalled();
    // Prune runs even with no files so a skill whose set became empty gets its
    // orphans removed; the sweep is a single find (empty stdout ⇒ no rm).
    expect(commands.some((c) => c.startsWith("find "))).toBe(true);
    expect(commands.some((c) => c.startsWith("rm "))).toBe(false);
  });

  it("prunes on-box supporting files not present in the pinned artifact", async () => {
    const base = "/home/user/.claude/skills/my-skill";
    // The find sweep lists a stale file (b.md) and the kept file (a.md).
    const { session, writes, commands } = makeSession(
      `${base}/a.md\n${base}/b.md\n`
    );
    await materializePinnedSkillFiles({
      session,
      artifacts: [artifact({ files: [{ path: "a.md", content: "keep" }] })],
    });
    // b.md is not in the artifact ⇒ removed; a.md is kept (not rm'd) and rewritten.
    expect(commands).toContain(`rm -f -- '${base}/b.md'`);
    expect(commands).not.toContain(`rm -f -- '${base}/a.md'`);
    expect(writes).toContainEqual({ path: `${base}/a.md`, content: "keep" });
  });
});
