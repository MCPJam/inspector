/**
 * What each harness runtime does with skills on its box. The box writer
 * (`box-skills-writer.ts`) and the turn plan read these and nothing else about
 * a runtime, so taking skills on a new runtime is an entry here plus its
 * `supportsSkills` switch.
 *
 * Folders are relative to the box's home: `/home/user` on an E2B box, the
 * session's own home on a local runtime. Runtimes also read skill folders in
 * their working directory and its parents, where MCPJam writes none.
 *
 * Claude Code and Codex are checked against their installed adapters
 * (`codex-skill-parity.test.ts`). OpenCode, Cursor and Copilot CLI come from
 * their pinned binaries and SDKs, read without a live run, which is why their
 * adapters keep `supportsSkills: false`.
 */
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { isValidSkillName } from "../../../shared/skill-types.js";

export interface HarnessSkillsDescriptor {
  /**
   * Where the adapter writes its `skills` param. The writer writes the same
   * payload there first, with the adapter's options, so the adapter's own
   * write changes nothing and keeps what the writer added around it.
   */
  writeFolder: string;
  /** The adapter's `writeSkills` option: whether SKILL.md ends in a newline. */
  trailingNewline: boolean;
  /**
   * Every home folder the runtime reads skills from. A box may run another
   * runtime next, so the writer leaves no MCPJam skill folder in any of them
   * but the ones the turn delivers.
   */
  readFolders: readonly string[];
  /** Whether the runtime takes a name. An adapter throws on one it rejects,
   *  failing the whole turn, so the writer leaves that skill off instead. */
  acceptsName(name: string): boolean;
  frontmatter: {
    descriptionMaxLength: number;
    /** The runtime skips a skill whose frontmatter isn't strict YAML. The
     *  writer's always is, and its tests hold these runtimes to that. */
    strictYaml: boolean;
    /** A `metadata.surfaces` list must name this, or the runtime drops the
     *  skill; a skill without the key loads everywhere. */
    surface?: string;
  };
  /** `bridge-opt-in`: MCPJam's bridge must switch skills on and point the
   *  runtime at the folder before its headless mode loads them. */
  headlessLoading: "native" | "bridge-opt-in";
  /**
   * `box-files`: a frozen run copies each captured MCP-server skill to the box
   * as a plain skill folder, and a live turn leaves them off.
   * `harness-tools`: MCPJam's skill tools serve them.
   */
  serverSkills: "box-files" | "harness-tools";
}

/** The Agent Skills limit; every runtime here loads descriptions this long. */
const DESCRIPTION_MAX_LENGTH = 1024;

const CURSOR_HOME =
  ".ai-sdk-harness/.harness-bootstrap/cursor/implementation/home";

export const HARNESS_SKILLS: Record<Harness, HarnessSkillsDescriptor> = {
  // Reads `~/.claude/skills` and `.claude/skills` up to the repository root,
  // stopping below the home. Acts on `allowed-tools`, which is never written.
  "claude-code": {
    writeFolder: ".claude/skills",
    trailingNewline: true,
    readFolders: [".claude/skills"],
    acceptsName: isValidSkillName,
    frontmatter: {
      descriptionMaxLength: DESCRIPTION_MAX_LENGTH,
      strictYaml: false,
    },
    headlessLoading: "native",
    serverSkills: "box-files",
  },
  // Also reads `.agents/skills` up to the repository root, `/etc/codex/skills`
  // and its bundled skills.
  codex: {
    writeFolder: ".agents/skills",
    trailingNewline: false,
    readFolders: [".agents/skills"],
    acceptsName: isValidSkillName,
    frontmatter: {
      descriptionMaxLength: DESCRIPTION_MAX_LENGTH,
      strictYaml: false,
    },
    headlessLoading: "native",
    serverSkills: "box-files",
  },
  // The adapter writes Codex's folder under the same adapter manifest, and
  // OpenCode also reads Claude Code's. OpenCode itself checks no name rule.
  opencode: {
    writeFolder: ".agents/skills",
    trailingNewline: false,
    readFolders: [
      ".agents/skills",
      ".claude/skills",
      ".config/opencode/skills",
      ".config/opencode/skill",
    ],
    acceptsName: isValidSkillName,
    frontmatter: {
      descriptionMaxLength: DESCRIPTION_MAX_LENGTH,
      strictYaml: false,
    },
    headlessLoading: "native",
    serverSkills: "box-files",
  },
  // A private home inside the installed recipe: Cursor reads only its folders
  // (and its working directory, with no walk-up). The folder name is the
  // skill's identity, and the ACP adapter throws on a non-kebab name.
  cursor: {
    writeFolder: `${CURSOR_HOME}/.agents/skills`,
    trailingNewline: false,
    readFolders: [
      ".agents/skills",
      ".cursor/skills",
      ".claude/skills",
      ".codex/skills",
      ".grok/skills",
      ".cursor/skills-cursor",
    ].map((folder) => `${CURSOR_HOME}/${folder}`),
    acceptsName: isValidSkillName,
    frontmatter: {
      descriptionMaxLength: DESCRIPTION_MAX_LENGTH,
      strictYaml: false,
      surface: "cli",
    },
    headlessLoading: "native",
    serverSkills: "box-files",
  },
  // A per-session home, and the SDK's empty mode keeps skills off until the
  // bridge sets `enableSkills` and passes this folder as a skill directory,
  // which no adapter writes. With config discovery on, Copilot would also read
  // the `.claude`, `.agents` and `.github` skill folders above its working
  // directory; the bridge turns discovery off.
  "copilot-cli": {
    writeFolder: ".copilot/skills",
    trailingNewline: false,
    readFolders: [".copilot/skills"],
    acceptsName: isValidSkillName,
    frontmatter: {
      descriptionMaxLength: DESCRIPTION_MAX_LENGTH,
      strictYaml: true,
    },
    headlessLoading: "bridge-opt-in",
    serverSkills: "box-files",
  },
};

/**
 * The folders besides its own that a runtime's turn clears: the ones it reads
 * that some adapter writes. MCPJam's skill folders can be nowhere else.
 */
export function foldersToClear(descriptor: HarnessSkillsDescriptor): string[] {
  const written = new Set(
    Object.values(HARNESS_SKILLS).map((entry) => entry.writeFolder),
  );
  return descriptor.readFolders.filter(
    (folder) => folder !== descriptor.writeFolder && written.has(folder),
  );
}
