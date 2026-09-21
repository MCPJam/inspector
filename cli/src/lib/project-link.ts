/**
 * `.mcpjam/project.json` — a committed, secret-free pin from a working
 * directory to an MCPJam Cloud project.
 *
 * Lookup walks from `cwd` toward the nearest Git worktree root (inclusive).
 * Outside Git, only `cwd` is inspected so `$HOME/.mcpjam/project.json` cannot
 * become ambient context for an unrelated directory.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { operationalError, usageError } from "./output.js";

export const PROJECT_LINK_VERSION = 1;
export const PROJECT_LINK_RELATIVE_PATH = path.join(".mcpjam", "project.json");

export type ProjectLink = {
  version: 1;
  project: { id: string; name: string };
  organizationId?: string;
  apiUrl: string;
};

export type ProjectLinkIo = {
  cwd?: string;
  existsSync?: (target: string) => boolean;
  readFileSync?: (target: string, encoding: "utf8") => string;
};

export type ProjectLinkInspection =
  | { status: "missing" }
  | { status: "valid"; path: string; link: ProjectLink }
  | { status: "invalid"; path: string; error: string };

function exists(target: string, io: ProjectLinkIo = {}): boolean {
  return (io.existsSync ?? existsSync)(target);
}

function readText(target: string, io: ProjectLinkIo = {}): string {
  return (io.readFileSync ?? readFileSync)(target, "utf8");
}

function cwdOf(io: ProjectLinkIo = {}): string {
  return path.resolve(io.cwd ?? process.cwd());
}

/**
 * Nearest Git worktree root, walking up from `startDir`. `.git` may be a
 * directory (normal repo) or a file (linked worktree).
 */
export function findGitWorktreeRoot(
  startDir: string,
  io: ProjectLinkIo = {}
): string | null {
  let current = path.resolve(startDir);
  const { root } = path.parse(current);
  while (true) {
    if (exists(path.join(current, ".git"), io)) {
      return current;
    }
    if (current === root) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Directory `cloud link` writes to: `--here` → cwd; else Git root or cwd. */
export function projectLinkWriteDir(
  io: ProjectLinkIo & { here?: boolean } = {}
): string {
  const cwd = cwdOf(io);
  if (io.here) {
    return cwd;
  }
  return findGitWorktreeRoot(cwd, io) ?? cwd;
}

export function projectLinkPathForDir(directory: string): string {
  return path.join(path.resolve(directory), PROJECT_LINK_RELATIVE_PATH);
}

/**
 * Path of the nearest `.mcpjam/project.json`, or `undefined` if none exists.
 * Existence is not validity — callers must parse.
 */
export function findNearestProjectLinkPath(
  io: ProjectLinkIo = {}
): string | undefined {
  const start = cwdOf(io);
  const gitRoot = findGitWorktreeRoot(start, io);
  if (!gitRoot) {
    const candidate = projectLinkPathForDir(start);
    return exists(candidate, io) ? candidate : undefined;
  }

  let current = start;
  while (true) {
    const candidate = projectLinkPathForDir(current);
    if (exists(candidate, io)) {
      return candidate;
    }
    if (path.resolve(current) === path.resolve(gitRoot)) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function apiUrlsMatch(left: string, right: string): boolean {
  return normalizeApiUrl(left) === normalizeApiUrl(right);
}

function canonicalHttpUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (!parsed.hostname) {
    return null;
  }
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseProjectLink(
  raw: unknown,
  filePath: string
): { ok: true; link: ProjectLink } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: `${filePath} must be a JSON object.`,
    };
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== PROJECT_LINK_VERSION) {
    return {
      ok: false,
      error: `${filePath} has unsupported version ${JSON.stringify(
        record.version
      )}. Expected ${PROJECT_LINK_VERSION}. Re-run \`mcpjam cloud link\`.`,
    };
  }
  const project = record.project;
  if (project === null || typeof project !== "object" || Array.isArray(project)) {
    return {
      ok: false,
      error: `${filePath} is missing project { id, name }.`,
    };
  }
  const projectRecord = project as Record<string, unknown>;
  const id = nonEmptyString(projectRecord.id);
  const name = nonEmptyString(projectRecord.name);
  if (!id || !name) {
    return {
      ok: false,
      error: `${filePath} must have non-empty project.id and project.name.`,
    };
  }
  if (typeof record.apiUrl !== "string" || !canonicalHttpUrl(record.apiUrl)) {
    return {
      ok: false,
      error: `${filePath} must have a canonical http(s) apiUrl.`,
    };
  }
  if (
    record.organizationId !== undefined &&
    !nonEmptyString(record.organizationId)
  ) {
    return {
      ok: false,
      error: `${filePath} organizationId must be a non-empty string when present.`,
    };
  }

  const organizationId = nonEmptyString(record.organizationId);
  return {
    ok: true,
    link: {
      version: PROJECT_LINK_VERSION,
      project: { id, name },
      ...(organizationId !== undefined ? { organizationId } : {}),
      apiUrl: record.apiUrl,
    },
  };
}

export function inspectProjectLink(io: ProjectLinkIo = {}): ProjectLinkInspection {
  const filePath = findNearestProjectLinkPath(io);
  if (!filePath) {
    return { status: "missing" };
  }

  let text: string;
  try {
    text = readText(filePath, io);
  } catch (error) {
    return {
      status: "invalid",
      path: filePath,
      error: `Could not read ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      status: "invalid",
      path: filePath,
      error: `${filePath} is not valid JSON.`,
    };
  }

  const result = parseProjectLink(parsed, filePath);
  if (!result.ok) {
    return { status: "invalid", path: filePath, error: result.error };
  }
  return { status: "valid", path: filePath, link: result.link };
}

/**
 * Valid nearest link, or a hard error. Missing is `null`. Callers that would
 * fall through to automatic selection must use this rather than ignoring an
 * unreadable file.
 */
export function readRequiredProjectLink(
  io: ProjectLinkIo = {}
): { path: string; link: ProjectLink } | null {
  const inspection = inspectProjectLink(io);
  if (inspection.status === "missing") {
    return null;
  }
  if (inspection.status === "invalid") {
    throw operationalError(inspection.error);
  }
  return { path: inspection.path, link: inspection.link };
}

export async function writeProjectLink(args: {
  directory: string;
  link: ProjectLink;
}): Promise<string> {
  const filePath = projectLinkPathForDir(args.directory);
  const body = `${JSON.stringify(args.link, null, 2)}\n`;
  return writeFileAtomic(filePath, body, { createParents: true });
}

export function removeProjectLinkFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      throw usageError(`No project link at ${filePath}.`);
    }
    throw operationalError(
      `Could not remove ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
