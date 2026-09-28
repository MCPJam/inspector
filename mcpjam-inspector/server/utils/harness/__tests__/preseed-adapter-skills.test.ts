import { describe, it, expect } from "vitest";
import { writeSkills } from "@ai-sdk/harness/utils";
import {
  handOffLegacySkillDirs,
  preseedAdapterSkills,
  type PreseedSession,
} from "../preseed-adapter-skills";

const ROOT = "/home/user/.claude/skills";
const ADAPTER_MANIFEST = `${ROOT}/.ai-sdk-harness-skills.json`;
const MCPJAM_MANIFEST = `${ROOT}/.mcpjam-skills.json`;

/**
 * In-memory sandbox session interpreting exactly the shell the library's
 * `writeSkills` issues (`mkdir -p`, `mv -f`, `rm -rf --`, `test ! -e`) plus
 * this module's own `rm -rf --`. Paths arrive single-quoted.
 */
function makeSession(initial: {
  files?: Record<string, string>;
  dirs?: string[];
}) {
  const files = new Map<string, string>(Object.entries(initial.files ?? {}));
  const dirs = new Set<string>(initial.dirs ?? []);
  const commands: string[] = [];

  const tokens = (command: string): string[] => {
    const out: string[] = [];
    for (const m of command.matchAll(/'([^']*)'|(\S+)/g)) {
      out.push(m[1] ?? m[2]);
    }
    return out;
  };
  const exists = (path: string): boolean => {
    if (dirs.has(path) || files.has(path)) return true;
    for (const p of files.keys()) if (p.startsWith(`${path}/`)) return true;
    for (const d of dirs) if (d.startsWith(`${path}/`)) return true;
    return false;
  };
  const removeTree = (path: string): void => {
    dirs.delete(path);
    for (const d of [...dirs]) if (d.startsWith(`${path}/`)) dirs.delete(d);
    for (const p of [...files.keys()])
      if (p === path || p.startsWith(`${path}/`)) files.delete(p);
  };

  const session: PreseedSession = {
    readTextFile: async ({ path }) => files.get(path) ?? null,
    writeTextFile: async ({ path, content }) => {
      files.set(path, content);
    },
    run: async ({ command }) => {
      commands.push(command);
      const argv = tokens(command);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (argv[0] === "mkdir" && argv[1] === "-p") {
        dirs.add(argv[2]);
        return ok;
      }
      if (argv[0] === "mv" && argv[1] === "-f") {
        const content = files.get(argv[2]);
        if (content === undefined)
          return { exitCode: 1, stdout: "", stderr: "mv: missing source" };
        files.set(argv[3], content);
        files.delete(argv[2]);
        return ok;
      }
      if (argv[0] === "rm" && argv[1] === "-rf" && argv[2] === "--") {
        for (const path of argv.slice(3)) removeTree(path);
        return ok;
      }
      if (argv[0] === "test" && argv[1] === "!" && argv[2] === "-e") {
        return exists(argv[3])
          ? { exitCode: 1, stdout: "", stderr: "" }
          : ok;
      }
      throw new Error(`fake session: unrecognized command: ${command}`);
    },
  };
  return { session, files, dirs, commands };
}

const PAYLOAD = [
  { name: "find-skills", description: '"Find skills"', content: "body A" },
  { name: "frontend-design", description: '"Design"', content: "body B" },
];

/** The library sandbox type is nominally distinct; cast like the module does. */
const asLibSandbox = (session: PreseedSession) =>
  session as unknown as Parameters<typeof writeSkills>[0]["sandbox"];

describe("preseedAdapterSkills", () => {
  it("writes each SKILL.md and a complete adapter manifest", async () => {
    const { session, files } = makeSession({});
    await preseedAdapterSkills({
      session,
      skillsBase: ROOT,
      payload: PAYLOAD,
      trailingNewline: true,
    });
    expect(files.get(`${ROOT}/find-skills/SKILL.md`)).toContain("body A");
    expect(files.get(`${ROOT}/frontend-design/SKILL.md`)).toContain("body B");
    const manifest = JSON.parse(files.get(ADAPTER_MANIFEST)!) as {
      state: string;
      skills: Array<{ name: string; hash: string }>;
    };
    expect(manifest.state).toBe("complete");
    expect(manifest.skills.map((s) => s.name).sort()).toEqual([
      "find-skills",
      "frontend-design",
    ]);
    for (const skill of manifest.skills) {
      expect(skill.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("makes the Claude adapter's own turn-time write a hash-unchanged no-op", async () => {
    const { session, commands } = makeSession({});
    await preseedAdapterSkills({
      session,
      skillsBase: ROOT,
      payload: PAYLOAD,
      trailingNewline: true,
    });
    const before = commands.length;
    // Exactly how `writeClaudeCodeSkills` invokes the library (messages don't
    // affect the projected hash; `trailingNewline: true` does).
    const result = await writeSkills({
      sandbox: asLibSandbox(session),
      rootDir: ROOT,
      skills: PAYLOAD,
      invalidSkillNameMessage: ({ name }) =>
        `Invalid Claude Code skill name: ${name}`,
      invalidSkillFilePathMessage: ({ skillName, filePath }) =>
        `Invalid Claude Code skill file path for ${skillName}: ${filePath}`,
      trailingNewline: true,
    });
    expect(result.changed).toBe(false);
    expect(result.unchanged.sort()).toEqual(["find-skills", "frontend-design"]);
    const after = commands.slice(before);
    expect(after.filter((c) => c.startsWith("rm "))).toEqual([]);
  });

  it("makes the Codex adapter's own turn-time write a no-op (default options)", async () => {
    const { session } = makeSession({});
    const codexRoot = "/home/user/.agents/skills";
    await preseedAdapterSkills({
      session,
      skillsBase: codexRoot,
      payload: PAYLOAD,
      trailingNewline: false,
    });
    // Exactly how `writeCodexSkills` invokes the library.
    const result = await writeSkills({
      sandbox: asLibSandbox(session),
      rootDir: codexRoot,
      skills: PAYLOAD,
      invalidSkillNameMessage: ({ name }) => `Invalid Codex skill name: ${name}`,
      invalidSkillFilePathMessage: ({ skillName, filePath }) =>
        `Invalid Codex skill file path for ${skillName}: ${filePath}`,
    });
    expect(result.changed).toBe(false);
  });

  it("refuses a foreign colliding dir with the adapter's own error", async () => {
    const { session } = makeSession({
      files: { [`${ROOT}/frontend-design/SKILL.md`]: "hand-placed" },
    });
    await expect(
      preseedAdapterSkills({
        session,
        skillsBase: ROOT,
        payload: PAYLOAD,
        trailingNewline: true,
      }),
    ).rejects.toThrow(/not owned by the AI SDK harness/);
  });
});

describe("handOffLegacySkillDirs", () => {
  const mcpjamManifest = (names: string[]) =>
    JSON.stringify({
      schemaVersion: 1,
      skillsHash: "f70b9b65",
      skills: Object.fromEntries(
        names.map((name, i) => [`id${i}`, { skillId: `id${i}`, name }]),
      ),
    });

  it("removes only delivered, MCPJam-managed dirs the adapter does not own", async () => {
    const { session, files } = makeSession({
      files: {
        [MCPJAM_MANIFEST]: mcpjamManifest(["find-skills", "frontend-design"]),
        [`${ROOT}/find-skills/SKILL.md`]: "legacy",
        [`${ROOT}/frontend-design/SKILL.md`]: "legacy",
        [`${ROOT}/hand-placed/SKILL.md`]: "user data",
      },
    });
    const { removed } = await handOffLegacySkillDirs({
      session,
      skillsBase: ROOT,
      deliveredNames: ["find-skills", "frontend-design", "hand-placed"],
    });
    expect(removed.sort()).toEqual(["find-skills", "frontend-design"]);
    expect(files.has(`${ROOT}/find-skills/SKILL.md`)).toBe(false);
    // Not in MCPJam's manifest ⇒ user data, never removed.
    expect(files.get(`${ROOT}/hand-placed/SKILL.md`)).toBe("user data");
  });

  it("leaves dirs the adapter manifest already owns", async () => {
    const { session, files } = makeSession({
      files: {
        [MCPJAM_MANIFEST]: mcpjamManifest(["find-skills"]),
        [ADAPTER_MANIFEST]: JSON.stringify({
          version: 1,
          state: "complete",
          skills: [{ name: "find-skills", hash: "a".repeat(64) }],
        }),
        [`${ROOT}/find-skills/SKILL.md`]: "adapter-owned",
      },
    });
    const { removed } = await handOffLegacySkillDirs({
      session,
      skillsBase: ROOT,
      deliveredNames: ["find-skills"],
    });
    expect(removed).toEqual([]);
    expect(files.get(`${ROOT}/find-skills/SKILL.md`)).toBe("adapter-owned");
  });

  it("does nothing without an MCPJam manifest", async () => {
    const { session, commands } = makeSession({
      files: { [`${ROOT}/find-skills/SKILL.md`]: "x" },
    });
    const { removed } = await handOffLegacySkillDirs({
      session,
      skillsBase: ROOT,
      deliveredNames: ["find-skills"],
    });
    expect(removed).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("legacy box end-to-end: hand-off then pre-seed then adapter no-op", async () => {
    const { session, files } = makeSession({
      files: {
        [MCPJAM_MANIFEST]: mcpjamManifest(["find-skills", "frontend-design"]),
        [`${ROOT}/find-skills/SKILL.md`]: "legacy",
        [`${ROOT}/frontend-design/SKILL.md`]: "legacy",
      },
    });
    await handOffLegacySkillDirs({
      session,
      skillsBase: ROOT,
      deliveredNames: PAYLOAD.map((s) => s.name),
    });
    await preseedAdapterSkills({
      session,
      skillsBase: ROOT,
      payload: PAYLOAD,
      trailingNewline: true,
    });
    expect(files.get(`${ROOT}/find-skills/SKILL.md`)).toContain("body A");
    const result = await writeSkills({
      sandbox: asLibSandbox(session),
      rootDir: ROOT,
      skills: PAYLOAD,
      trailingNewline: true,
    });
    expect(result.changed).toBe(false);
  });
});
