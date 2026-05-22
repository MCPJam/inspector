/**
 * Project-shared skills sync service.
 *
 * Materializes the project-shared skill rows stored in Convex into a managed
 * cache directory under `~/.mcpjam/projects/<projectId>/skills/<name>/`. The
 * existing filesystem-backed skill loader, file tree, and `readSkillFile`
 * flows then operate on that cache directory unchanged.
 *
 * The cache is disposable: each sync re-materializes from Convex and removes
 * cache entries whose Convex row was archived or deleted. Direct edits made
 * inside the cache are NOT pushed back — the canonical copy lives in Convex
 * and the inspector treats the cache as read-only mirror state.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConvexHttpClient } from "convex/browser";
import { logger } from "../utils/logger";
import { isPathWithinDirectory } from "../utils/skill-parser";

export type SharedProjectSkillFile = {
  path: string;
  contentBase64: string;
  mimeType: string;
  size: number;
  isText: boolean;
};

export type SharedProjectSkillSummary = {
  skillId: string;
  projectId: string;
  creatorUserId: string;
  creatorName: string | null;
  creatorEmail: string | null;
  creatorImageUrl: string | null;
  name: string;
  description: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
};

export type SharedProjectSkillDetail = SharedProjectSkillSummary & {
  skillMd: string;
  files: SharedProjectSkillFile[];
};

/**
 * Root cache directory for all projects' shared skills. We never write
 * anywhere except inside this tree, so disk-traversal protections in the
 * skill parser keep applying.
 */
export function getSharedProjectSkillsCacheRoot(): string {
  return path.join(os.homedir(), ".mcpjam", "projects");
}

/**
 * Cache directory for a specific project's shared skills. The directory
 * shape mirrors `~/.mcpjam/skills/`, so the existing `getSkillsDirs()`
 * scanner can list it without any new code paths once we add it to the
 * precedence list.
 */
export function getSharedProjectSkillsCacheDir(projectId: string): string {
  const safeProjectId = sanitizeProjectIdSegment(projectId);
  return path.join(
    getSharedProjectSkillsCacheRoot(),
    safeProjectId,
    "skills",
  );
}

function sanitizeProjectIdSegment(projectId: string): string {
  // Convex IDs are URL-safe by construction, but defend against the unlikely
  // case of a caller passing a path-shaped value (e.g., '../../etc/passwd').
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error(`Invalid projectId for cache dir: ${projectId}`);
  }
  return projectId;
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validate a relative bundled-file path so a malicious or buggy publisher
 * can't write outside the per-skill cache directory.
 */
function isSafeBundledPath(skillDir: string, relPath: string): boolean {
  if (!relPath || relPath === "SKILL.md") return false;
  if (relPath.startsWith("/") || relPath.includes("\\")) return false;
  if (relPath.split("/").some((segment) => segment === "..")) return false;
  return isPathWithinDirectory(skillDir, relPath);
}

async function writeSharedSkill(
  cacheDir: string,
  skill: SharedProjectSkillDetail,
): Promise<void> {
  // The skill name comes from the Convex row, which validated it against the
  // same rules as local uploads. Still re-check before mkdir, as defense in
  // depth.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/.test(skill.name)) {
    throw new Error(`Refusing to materialize skill with invalid name: ${skill.name}`);
  }
  const skillDir = path.join(cacheDir, skill.name);

  // Start clean: remove any leftover files so we never leak stale assets
  // from a previous version of the published skill.
  await fs.rm(skillDir, { recursive: true, force: true });
  await fs.mkdir(skillDir, { recursive: true });

  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    skill.skillMd,
    "utf-8",
  );

  for (const file of skill.files) {
    if (!isSafeBundledPath(skillDir, file.path)) {
      logger.warn(
        `[project-skills-sync] skipping unsafe bundled path: ${file.path}`,
      );
      continue;
    }
    const fullPath = path.join(skillDir, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const buffer = Buffer.from(file.contentBase64, "base64");
    await fs.writeFile(fullPath, buffer);
  }
}

/**
 * Remove cache entries for skills that are no longer present in `keepNames`.
 */
async function pruneStaleSkills(
  cacheDir: string,
  keepNames: Set<string>,
): Promise<void> {
  if (!(await directoryExists(cacheDir))) return;
  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (keepNames.has(entry.name)) continue;
    await fs.rm(path.join(cacheDir, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

export type SyncResult = {
  projectId: string;
  cacheDir: string;
  materialized: string[];
  pruned: number;
};

/**
 * Materialize all active shared skills for `projectId` into the local cache
 * directory. Caller supplies the Convex auth token that the local inspector
 * already plumbs through for other authenticated endpoints.
 */
export async function syncSharedProjectSkills(
  projectId: string,
  convexAuthToken: string,
  convexUrl?: string,
): Promise<SyncResult> {
  const url = convexUrl ?? process.env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL is not set; cannot sync project skills");
  }

  const cacheDir = getSharedProjectSkillsCacheDir(projectId);
  await fs.mkdir(cacheDir, { recursive: true });

  const client = new ConvexHttpClient(url);
  client.setAuth(convexAuthToken);

  const summaries = (await client.query(
    "projectSkills:listProjectSkills" as any,
    { projectId },
  )) as SharedProjectSkillSummary[];

  const materialized: string[] = [];
  const seenNames = new Set<string>();

  for (const summary of summaries) {
    if (summary.status !== "active") continue;
    if (seenNames.has(summary.name)) {
      // Active uniqueness on (projectId, name) is enforced server-side; this
      // is defensive in case two rows somehow share a name.
      logger.warn(
        `[project-skills-sync] duplicate active skill name in project ${projectId}: ${summary.name}`,
      );
      continue;
    }

    const detail = (await client.query(
      "projectSkills:getProjectSkill" as any,
      { skillId: summary.skillId },
    )) as SharedProjectSkillDetail;

    await writeSharedSkill(cacheDir, detail);
    seenNames.add(detail.name);
    materialized.push(detail.name);
  }

  // Count pre-existing dirs we'll prune so the caller can surface the diff.
  let prunedCount = 0;
  if (await directoryExists(cacheDir)) {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    prunedCount = entries.filter(
      (e) => e.isDirectory() && !seenNames.has(e.name),
    ).length;
  }
  await pruneStaleSkills(cacheDir, seenNames);

  return {
    projectId,
    cacheDir,
    materialized,
    pruned: prunedCount,
  };
}

/**
 * Read all bundled files from a local skill directory into the wire shape
 * the Convex publish/update mutations expect.
 *
 * Skips SKILL.md (handled separately) and applies the same path-traversal
 * guards as the materialization step.
 */
export async function readLocalSkillBundle(
  skillDir: string,
): Promise<{
  skillMd: string;
  files: SharedProjectSkillFile[];
}> {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const skillMd = await fs.readFile(skillMdPath, "utf-8");

  const files: SharedProjectSkillFile[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      const rel = path.relative(skillDir, full);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (rel === "SKILL.md") continue;
      if (!isSafeBundledPath(skillDir, rel)) {
        logger.warn(
          `[project-skills-sync] skipping unsafe local path during bundle: ${rel}`,
        );
        continue;
      }
      const stat = await fs.stat(full);
      const buffer = await fs.readFile(full);
      const mimeType = guessMimeType(entry.name);
      const isText = isTextMimeType(mimeType);
      files.push({
        path: rel,
        contentBase64: buffer.toString("base64"),
        mimeType,
        size: stat.size,
        isText,
      });
    }
  }

  await walk(skillDir);
  return { skillMd, files };
}

function guessMimeType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/x-yaml";
    case ".js":
    case ".mjs":
    case ".jsx":
      return "text/javascript";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".py":
      return "text/x-python";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/x-yaml" ||
    mimeType === "image/svg+xml"
  );
}
