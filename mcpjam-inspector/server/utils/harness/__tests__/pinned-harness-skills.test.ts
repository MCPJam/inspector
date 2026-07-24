import { describe, expect, it, vi } from "vitest";
import {
  materializePinnedSkillFiles,
  pinnedArtifactsToRuntimeSkills,
} from "../pinned-harness-skills.js";
import { skillsFingerprint } from "../runtime-skills.js";
import type { PinnedSkillArtifact } from "../../../../shared/skill-types.js";

const artifact = (over: Partial<PinnedSkillArtifact> = {}): PinnedSkillArtifact => ({
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
      pinnedArtifactsToRuntimeSkills([artifact({ skillId: "sk1" })]),
    );
    const b = skillsFingerprint(
      pinnedArtifactsToRuntimeSkills([
        artifact({ skillId: "sk1", contentHash: "hash-2" }),
      ]),
    );
    expect(a).not.toBe(b); // a different pinned artifact ⇒ a different hash
    expect(
      skillsFingerprint(pinnedArtifactsToRuntimeSkills([])),
    ).toBe(""); // empty pinned set ⇒ the stable empty sentinel
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
  const makeSession = () => {
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

  it("skips a path that escapes the skill dir", async () => {
    const { session, writes } = makeSession();
    await materializePinnedSkillFiles({
      session,
      artifacts: [
        artifact({
          files: [{ path: "../../evil.sh", content: "rm -rf /" }],
        }),
      ],
    });
    expect(writes).toEqual([]);
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
    const writes: Array<{ path: string; content: string }> = [];
    const commands: string[] = [];
    const base = "/home/user/.claude/skills/my-skill";
    const session = {
      writeTextFile: vi.fn(async (a: { path: string; content: string }) => {
        writes.push(a);
      }),
      run: vi.fn(async (a: { command: string }) => {
        commands.push(a.command);
        // The find sweep lists a stale file (b.md) and the kept file (a.md).
        if (a.command.startsWith("find ")) {
          return {
            exitCode: 0,
            stdout: `${base}/a.md\n${base}/b.md\n`,
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    };
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
