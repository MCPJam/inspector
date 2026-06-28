/**
 * Cloud Skills — Project-Computer-backed equivalent of the local
 * filesystem skills (`server/utils/skill-parser.ts` + `routes/mcp/skills.ts`).
 *
 * Local skills read `~/.mcpjam/skills` etc. on the machine running the
 * inspector. In hosted / horizontally-scaled mode there is no durable local
 * FS, but a project's **Computer** (an E2B sandbox) is a persistent
 * workstation whose files survive between sessions — exactly what skills need.
 *
 * This module performs the same operations (list / get / upload / delete /
 * files / read-file) against the computer's filesystem, reusing:
 *   - the parser + validators in `../skill-parser.ts` (one source of truth for
 *     SKILL.md frontmatter, name rules, mime/text detection, path-traversal);
 *   - the control-plane resolution + wake pipeline in `./control-plane-client`
 *     (`ensureComputerReady` → `getComputerSandboxInfo`), identical to
 *     `run-command.ts` / `resolve-sandbox.ts`;
 *   - the E2B Filesystem API (`sandbox.files.*`), the same surface the harness
 *     sandbox provider uses (`harness/e2b-sandbox-provider.ts`).
 *
 * Skills are stored under `~/.claude/skills` (PRIMARY) so that Claude Code
 * running *inside* the computer (the harness) discovers the very same skills
 * via its native filesystem discovery — one source of truth for both the
 * non-harness chat tools here and the in-sandbox harness.
 */
import { Sandbox, FileNotFoundError } from "e2b";
import path from "path";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
} from "./control-plane-client.js";
import {
  parseSkillFile,
  skillToListItem,
  generateSkillFileContent,
  getMimeType,
  isTextMimeType,
  isPathWithinDirectory,
  isValidSkillName,
} from "../skill-parser.js";
import { logger } from "../logger.js";
import type {
  Skill,
  SkillListItem,
  SkillFile,
  SkillFileContent,
} from "../../../shared/skill-types.js";

/** E2B computer-template home (matches `harness/e2b-sandbox-provider.ts`). */
const SANDBOX_HOME = "/home/user";

/**
 * Directories scanned for skills inside the computer. PRIMARY (uploads) first.
 * `~/.claude/skills` is primary so the in-sandbox Claude Code harness discovers
 * the same skills natively.
 */
const SKILLS_DIRS = [
  path.posix.join(SANDBOX_HOME, ".claude", "skills"),
  path.posix.join(SANDBOX_HOME, ".mcpjam", "skills"),
  path.posix.join(SANDBOX_HOME, ".agents", "skills"),
];
const PRIMARY_SKILLS_DIR = SKILLS_DIRS[0];

export interface CloudSkillsContext {
  /** Bearer authorization forwarded to Convex (authz + wake). */
  authHeader: string;
  /** Project whose (project, user) computer the skills live on. */
  projectId: string;
  signal?: AbortSignal;
}

/** Carries an HTTP-ish status so the web route can map it faithfully. */
export class CloudSkillsError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "CloudSkillsError";
    this.status = status;
  }
}

/** `~/...` display path for a skill dir, mirroring the local route. */
function displayPath(skillsDir: string, skillName: string): string {
  const full = path.posix.join(skillsDir, skillName);
  return full.startsWith(SANDBOX_HOME)
    ? full.replace(SANDBOX_HOME, "~")
    : full;
}

/**
 * Resolve + wake the caller's computer, connect to the E2B sandbox, and run
 * `fn` against it. One connection per top-level operation (skills counts are
 * small, so N+1 `files.read` within an operation is acceptable). Throws
 * `CloudSkillsError` with a status the route can surface.
 */
async function withSandbox<T>(
  ctx: CloudSkillsContext,
  fn: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  if (!isComputersDataPlaneConfigured()) {
    throw new CloudSkillsError(
      "Computers are not configured on this server.",
      503,
    );
  }

  const ready = await ensureComputerReady({
    bearer: ctx.authHeader,
    projectId: ctx.projectId,
    signal: ctx.signal,
  });
  if (!ready.ok) {
    throw new CloudSkillsError(
      `Computer unavailable: ${ready.error}`,
      ready.status || 502,
    );
  }

  const info = await getComputerSandboxInfo({
    computerId: ready.value.computerId,
    signal: ctx.signal,
  });
  if (!info.ok) {
    throw new CloudSkillsError(
      `Computer unavailable: ${info.error}`,
      info.status || 502,
    );
  }
  if (!info.value.providerComputerId) {
    throw new CloudSkillsError(
      "Computer is still provisioning — try again in a moment.",
      503,
    );
  }

  const sandbox = await Sandbox.connect(info.value.providerComputerId);
  return fn(sandbox);
}

/** List a directory; a missing directory yields `[]` (not an error). */
async function safeList(sandbox: Sandbox, dir: string) {
  try {
    return await sandbox.files.list(dir);
  } catch {
    return [];
  }
}

/** Read a file; a genuinely missing file yields `null`, real errors throw. */
async function readTextOrNull(
  sandbox: Sandbox,
  filePath: string,
): Promise<string | null> {
  try {
    return await sandbox.files.read(filePath);
  } catch (err) {
    if (err instanceof FileNotFoundError) return null;
    throw err;
  }
}

/** Find the absolute computer path of a skill directory by skill name. */
async function findSkillDir(
  sandbox: Sandbox,
  name: string,
): Promise<string | null> {
  for (const dir of SKILLS_DIRS) {
    const entries = await safeList(sandbox, dir);
    for (const entry of entries) {
      if (entry.type !== "dir") continue;
      const skillDir = path.posix.join(dir, entry.name);
      const content = await readTextOrNull(
        sandbox,
        path.posix.join(skillDir, "SKILL.md"),
      );
      if (!content) continue;
      const skill = parseSkillFile(content, entry.name);
      if (skill && skill.name === name) return skillDir;
    }
  }
  return null;
}

/** True if a skill with `name` already exists in any scanned directory. */
async function skillExists(sandbox: Sandbox, name: string): Promise<boolean> {
  return (await findSkillDir(sandbox, name)) !== null;
}

/** Recursive file tree of one skill dir, mirroring `listFilesRecursive`. */
async function listFilesRecursiveE2B(
  sandbox: Sandbox,
  dirPath: string,
  relativeTo: string = dirPath,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const entries = await safeList(sandbox, dirPath);

  for (const entry of entries) {
    const fullPath = path.posix.join(dirPath, entry.name);
    const relativePath = path.posix.relative(relativeTo, fullPath);
    const ext = path.posix.extname(entry.name).toLowerCase();

    if (entry.type === "dir") {
      const children = await listFilesRecursiveE2B(
        sandbox,
        fullPath,
        relativeTo,
      );
      files.push({
        path: relativePath,
        name: entry.name,
        type: "directory",
        children,
      });
    } else {
      files.push({
        path: relativePath,
        name: entry.name,
        type: "file",
        size: entry.size,
        mimeType: getMimeType(entry.name),
        extension: ext || undefined,
      });
    }
  }

  // SKILL.md first, then dirs, then files; alphabetical within each group —
  // identical ordering to the local `listFilesRecursive`.
  return files.sort((a, b) => {
    if (a.name === "SKILL.md") return -1;
    if (b.name === "SKILL.md") return 1;
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

// ── public service operations ────────────────────────────────────────────

export async function listCloudSkills(
  ctx: CloudSkillsContext,
): Promise<SkillListItem[]> {
  return withSandbox(ctx, async (sandbox) => {
    const out: SkillListItem[] = [];
    const seen = new Set<string>();
    for (const dir of SKILLS_DIRS) {
      const entries = await safeList(sandbox, dir);
      for (const entry of entries) {
        if (entry.type !== "dir") continue;
        const content = await readTextOrNull(
          sandbox,
          path.posix.join(dir, entry.name, "SKILL.md"),
        );
        if (!content) continue;
        const skill = parseSkillFile(content, displayPath(dir, entry.name));
        if (skill && !seen.has(skill.name)) {
          seen.add(skill.name);
          out.push(skillToListItem(skill));
        }
      }
    }
    return out;
  });
}

export async function getCloudSkill(
  ctx: CloudSkillsContext,
  name: string,
): Promise<Skill | null> {
  return withSandbox(ctx, async (sandbox) => {
    for (const dir of SKILLS_DIRS) {
      const entries = await safeList(sandbox, dir);
      for (const entry of entries) {
        if (entry.type !== "dir") continue;
        const content = await readTextOrNull(
          sandbox,
          path.posix.join(dir, entry.name, "SKILL.md"),
        );
        if (!content) continue;
        const skill = parseSkillFile(content, displayPath(dir, entry.name));
        if (skill && skill.name === name) return skill;
      }
    }
    return null;
  });
}

export async function uploadCloudSkill(
  ctx: CloudSkillsContext,
  data: { name: string; description: string; content: string },
): Promise<Skill> {
  if (!isValidSkillName(data.name)) {
    throw new CloudSkillsError(
      "name must contain only lowercase letters, numbers, and hyphens",
      400,
    );
  }
  return withSandbox(ctx, async (sandbox) => {
    if (await skillExists(sandbox, data.name)) {
      throw new CloudSkillsError(`Skill '${data.name}' already exists`, 409);
    }
    const skillDir = path.posix.join(PRIMARY_SKILLS_DIR, data.name);
    await sandbox.files.makeDir(skillDir);
    const fileContent = generateSkillFileContent(
      data.name,
      data.description,
      data.content,
    );
    await sandbox.files.write(path.posix.join(skillDir, "SKILL.md"), fileContent);
    return {
      name: data.name,
      description: data.description,
      content: data.content,
      path: displayPath(PRIMARY_SKILLS_DIR, data.name),
    };
  });
}

export interface CloudSkillUploadFile {
  /** Path of the file relative to the skill root (e.g. "scripts/run.py"). */
  path: string;
  bytes: Uint8Array;
}

export async function uploadCloudSkillFolder(
  ctx: CloudSkillsContext,
  skillName: string,
  files: CloudSkillUploadFile[],
): Promise<Skill> {
  if (!isValidSkillName(skillName)) {
    throw new CloudSkillsError(
      "Skill name must contain only lowercase letters, numbers, and hyphens",
      400,
    );
  }
  const skillMd = files.find(
    (f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"),
  );
  if (!skillMd) {
    throw new CloudSkillsError(
      "No SKILL.md file found in uploaded files",
      400,
    );
  }
  const parsed = parseSkillFile(
    new TextDecoder().decode(skillMd.bytes),
    skillName,
  );
  if (!parsed) {
    throw new CloudSkillsError(
      "Invalid SKILL.md format. Must contain valid frontmatter with 'name' and 'description' fields.",
      400,
    );
  }
  if (parsed.name !== skillName) {
    throw new CloudSkillsError(
      `Skill name mismatch: provided "${skillName}" but SKILL.md contains "${parsed.name}"`,
      400,
    );
  }

  return withSandbox(ctx, async (sandbox) => {
    if (await skillExists(sandbox, skillName)) {
      throw new CloudSkillsError(`Skill '${skillName}' already exists`, 409);
    }
    const skillDir = path.posix.join(PRIMARY_SKILLS_DIR, skillName);
    await sandbox.files.makeDir(skillDir);

    for (const file of files) {
      // Security: never let an uploaded path escape the skill directory.
      if (!isPathWithinDirectory(skillDir, file.path)) {
        logger.warn(`Skipping skill file with invalid path: ${file.path}`);
        continue;
      }
      const fullPath = path.posix.join(skillDir, file.path);
      const parentDir = path.posix.dirname(fullPath);
      if (parentDir !== skillDir) {
        await sandbox.files.makeDir(parentDir);
      }
      // Copy into an exactly-sized ArrayBuffer (Buffer.slice would expose the
      // pool) — same care as `harness/e2b-sandbox-provider.ts`.
      const buf = new ArrayBuffer(file.bytes.byteLength);
      new Uint8Array(buf).set(file.bytes);
      await sandbox.files.write(fullPath, buf);
    }

    return {
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      path: displayPath(PRIMARY_SKILLS_DIR, skillName),
    };
  });
}

export async function deleteCloudSkill(
  ctx: CloudSkillsContext,
  name: string,
): Promise<boolean> {
  return withSandbox(ctx, async (sandbox) => {
    const skillDir = await findSkillDir(sandbox, name);
    if (!skillDir) return false;
    await sandbox.files.remove(skillDir);
    return true;
  });
}

export async function listCloudSkillFiles(
  ctx: CloudSkillsContext,
  name: string,
): Promise<SkillFile[]> {
  return withSandbox(ctx, async (sandbox) => {
    const skillDir = await findSkillDir(sandbox, name);
    if (!skillDir) {
      throw new CloudSkillsError(`Skill '${name}' not found`, 404);
    }
    return listFilesRecursiveE2B(sandbox, skillDir);
  });
}

export async function readCloudSkillFile(
  ctx: CloudSkillsContext,
  name: string,
  filePath: string,
): Promise<SkillFileContent> {
  return withSandbox(ctx, async (sandbox) => {
    const skillDir = await findSkillDir(sandbox, name);
    if (!skillDir) {
      throw new CloudSkillsError(`Skill '${name}' not found`, 404);
    }
    if (!isPathWithinDirectory(skillDir, filePath)) {
      throw new CloudSkillsError("Invalid file path", 400);
    }
    const fullPath = path.posix.join(skillDir, filePath);

    let info;
    try {
      info = await sandbox.files.getInfo(fullPath);
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        throw new CloudSkillsError("File not found", 404);
      }
      throw err;
    }
    if (info.type !== "file") {
      throw new CloudSkillsError("Path is not a file", 400);
    }

    const mimeType = getMimeType(filePath);
    const isText = isTextMimeType(mimeType);
    const maxSize = isText ? 1024 * 1024 : 5 * 1024 * 1024;
    if (info.size > maxSize) {
      throw new CloudSkillsError(
        `File too large (${(info.size / 1024 / 1024).toFixed(2)}MB). Maximum is ${maxSize / 1024 / 1024}MB`,
        400,
      );
    }

    const content: SkillFileContent = {
      path: filePath,
      name: path.posix.basename(filePath),
      mimeType,
      size: info.size,
      isText,
    };
    if (isText) {
      content.content = await sandbox.files.read(fullPath);
    } else {
      const bytes = await sandbox.files.read(fullPath, { format: "bytes" });
      content.base64 = Buffer.from(bytes).toString("base64");
    }
    return content;
  });
}
