/**
 * Skills in this machine's skills folders (`getSkillsDirs`), as the local
 * origin of an `EffectiveCapabilitySet`.
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseSkillFile, listFilesRecursive } from "./skill-parser";
import type { SkillFile } from "../../shared/skill-types";
import type {
  RuntimeLocalSkill,
  RuntimeSkillFile,
} from "../services/environments/effective-capabilities.js";
import { LOCAL_SKILL_REF_NAMESPACE } from "../../shared/server-skill-refs";
import { SKILL_FILE_MAX_READ_BYTES } from "./computers/cloud-skills.js";

/**
 * Get all skills directories
 */
function getSkillsDirs(): string[] {
  const homeDir = os.homedir();
  const cwd = process.cwd();

  return [
    // Global skills
    path.join(homeDir, ".claude", "skills"), // Claude Desktop global skills
    path.join(homeDir, ".mcpjam", "skills"),
    path.join(homeDir, ".agents", "skills"),
    // Project-local skills
    path.join(cwd, ".claude", "skills"), // Claude Desktop project skills
    path.join(cwd, ".mcpjam", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];
}

/**
 * Format skill path for display - use ~ for home directory paths
 */
function formatDisplayPath(fullPath: string): string {
  const homeDir = os.homedir();
  if (fullPath.startsWith(homeDir)) {
    return fullPath.replace(homeDir, "~");
  }
  return path.relative(process.cwd(), fullPath);
}

/**
 * Check if a directory exists
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Flatten nested file structure
 */
function flattenFiles(files: SkillFile[]): SkillFile[] {
  const result: SkillFile[] = [];
  for (const file of files) {
    result.push(file);
    if (file.type === "directory" && file.children) {
      result.push(...flattenFiles(file.children));
    }
  }
  return result;
}

/**
 * Containment that survives a symlink.
 *
 * `isPathWithinDirectory` compares resolved STRINGS, so it stops `../` and
 * nothing else. A skills directory is ordinary user-writable space that
 * `npx skills` installs third-party packs into, and a symlinked `SKILL.md`
 * pointing at `~/.ssh/id_rsa` reads as an ordinary skill: its body would go
 * into the model's context with nothing in the file to notice. Instructions in
 * a malicious pack are at least legible; a symlink is silent, which is the
 * difference worth code.
 *
 * The BASE is resolved too, and that is load-bearing rather than tidy: a home
 * or temp directory is often reached through a symlink itself, so comparing a
 * resolved target against an unresolved base would refuse every read on those
 * machines.
 *
 * This closes `SKILL.md`, which is the only symlink the surface ever follows:
 * `readdir(withFileTypes)` reports a symlink as neither a file nor a
 * directory, so a symlinked skill directory or supporting file is already
 * skipped by the scan and the file lister. The check below stays on the file
 * read anyway — the listing's rules are not the read's proof.
 *
 * Returns the real path to read, or `null` when it lands outside (or does not
 * exist, which `realpath` reports the same way).
 */
async function realPathWithin(
  baseDir: string,
  target: string
): Promise<string | null> {
  try {
    const [base, resolved] = await Promise.all([
      fs.realpath(baseDir),
      fs.realpath(target),
    ]);
    return resolved === base || resolved.startsWith(base + path.sep)
      ? resolved
      : null;
  } catch {
    return null;
  }
}

/**
 * The local filesystem as one origin of an `EffectiveCapabilitySet`.
 *
 * This is what lets a desktop turn offer local files and project skills through
 * ONE ref-addressed catalog, instead of the exclusive either/or the chat
 * orchestrator used to pick between.
 *
 * Bodies are read eagerly — local disk is cheap and a skill without its body is
 * not a skill — but supporting FILES stay lazy: enumerating every skill's tree
 * on every turn would walk directories the model never asks about. The `read`
 * thunk checks containment and size itself before it reads a file.
 */
export async function listLocalRuntimeSkills(): Promise<RuntimeLocalSkill[]> {
  const skills: RuntimeLocalSkill[] = [];
  const seenNames = new Set<string>();

  for (const skillsDir of getSkillsDirs()) {
    if (!(await directoryExists(skillsDir))) continue;

    let entries;
    try {
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(skillsDir, entry.name);
      try {
        const skillFile = await realPathWithin(
          skillDir,
          path.join(skillDir, "SKILL.md")
        );
        if (!skillFile) continue;
        const raw = await fs.readFile(skillFile, "utf-8");
        const parsed = parseSkillFile(raw, formatDisplayPath(skillDir));
        // First-wins across the search path, like the Skills tab's list —
        // two directories offering the same name is a shadowing question the
        // search order already answers, not a ref collision.
        if (!parsed || seenNames.has(parsed.name)) continue;
        seenNames.add(parsed.name);

        skills.push({
          skillId: `local:${skillDir}`,
          // Namespaced, so a local `code-review` and a project `code-review`
          // are separately addressable rather than one shadowing the other.
          // The bare name still resolves to the project skill — that IS its
          // ref, and `loadSkill` matches an exact ref before it considers
          // names — so namespacing costs the project skill nothing and buys
          // the local one an address it did not have.
          ref: `${LOCAL_SKILL_REF_NAMESPACE}/${parsed.name}`,
          name: parsed.name,
          description: parsed.description,
          content: parsed.content,
          aggregateHash: await localSkillAggregateHash(skillDir, parsed.content),
          directory: formatDisplayPath(skillDir),
          files: [],
          listFiles: () => listLocalRuntimeSkillFiles(skillDir),
        });
      } catch {
        // Not a readable skill directory; the Skills tab skips these too.
      }
    }
  }

  return skills;
}

/**
 * Supporting files of one local skill, flattened to skill-relative paths.
 *
 * `SKILL.md` is excluded: it is the body, already delivered by `loadSkill`, and
 * listing it invites the model to spend a second read on what it just read.
 */
async function listLocalRuntimeSkillFiles(
  skillDir: string
): Promise<RuntimeSkillFile[]> {
  const tree = await listFilesRecursive(skillDir);
  return flattenFiles(tree)
    .filter((file) => file.type === "file" && file.path !== "SKILL.md")
    .map((file) => ({
      path: file.path,
      size: file.size ?? 0,
      url: null,
      read: async () => {
        // Belt and braces: the lister already drops symlinks, and the paths
        // come from that lister rather than from the model. Checked anyway,
        // because "the listing would never produce that" is an argument about
        // the caller, and this is the function that touches the disk.
        const absolute = await realPathWithin(
          skillDir,
          path.join(skillDir, file.path)
        );
        if (!absolute) {
          throw new Error(
            `"${file.path}" is not readable within the skill directory.`
          );
        }
        // The size the CALLER checked came from the listing, which is taken
        // once per turn and then reused — so a file that grows between the
        // listing and the read would be buffered whole under a cap it no
        // longer satisfies. On disk the current size is one `stat` away, and
        // the only size that bounds this read is the one it has right now.
        const stat = await fs.stat(absolute);
        if (stat.size > SKILL_FILE_MAX_READ_BYTES) {
          throw new Error(
            `"${file.path}" is too large to read (${stat.size} bytes).`
          );
        }
        return new Uint8Array(await fs.readFile(absolute));
      },
    }));
}

/**
 * A content-plus-files hash, so the field means the same thing here as it does
 * for a cloud skill.
 *
 * Cloud skills fold their supporting files into `aggregateHash`; hashing only
 * the body under the same field name would make two origins disagree about what
 * the value covers, and any cross-origin comparison silently wrong. File
 * CONTENTS are deliberately not read — path and size are enough to notice a
 * file appearing, vanishing, or changing length, without a full directory read
 * per turn.
 */
async function localSkillAggregateHash(
  skillDir: string,
  content: string
): Promise<string> {
  let manifest = "";
  try {
    const tree = await listFilesRecursive(skillDir);
    manifest = flattenFiles(tree)
      .filter((file) => file.type === "file" && file.path !== "SKILL.md")
      .map((file) => `${file.path}:${file.size ?? 0}`)
      .sort()
      .join("\n");
  } catch {
    // An unreadable tree hashes as "no files" rather than failing the skill.
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${content}\n--\n${manifest}`)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
