/**
 * Bundle path safety — pure, browser-safe.
 *
 * Every archive entry and every manifest-referenced path flows through these
 * helpers BEFORE any component (manifest/skill/MCP/app) normalization runs.
 * The reject list mirrors the OpenAI plugin import plan: absolute paths, `..`
 * traversal, NUL bytes, duplicate normalized paths, case-fold collisions,
 * symlink/hardlink entries, over-long or over-deep paths, and referenced files
 * escaping the bundle root.
 */

import type { PluginIssueCode, PluginIssueCollector } from "./validation.js";
import type { PluginBundleLimits, PluginFileEntry } from "./types.js";

export interface NormalizedBundleEntry {
  /** Path exactly as reported by the source adapter — use this for reads. */
  sourcePath: string;
  /** Normalized bundle-relative path — the canonical identity everywhere else. */
  path: string;
  /** Declared uncompressed size in bytes. */
  size: number;
}

export type PathNormalizationResult =
  | { ok: true; path: string }
  | { ok: false; code: PluginIssueCode; message: string };

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * Normalize a raw entry path to its canonical bundle-relative form:
 * `\` separators become `/`, `.` segments and empty segments collapse, a
 * leading `./` is dropped, and the result is NFC-normalized so macOS (NFD)
 * folder adapters and ZIP central directories (usually NFC) produce the SAME
 * canonical path — and therefore the same bundleHash — for identical
 * content. Rejects (never repairs) NUL bytes, control characters, absolute
 * paths, `..` traversal, colons (bare drives / NTFS alternate data streams),
 * and segments that Windows would collapse to empty/dot names.
 */
export function normalizeBundlePath(raw: string): PathNormalizationResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "PATH_EMPTY", message: "path is empty" };
  }
  if (raw.includes("\u0000")) {
    return {
      ok: false,
      code: "PATH_NUL_BYTE",
      message: "path contains a NUL byte",
    };
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    return {
      ok: false,
      code: "PATH_INVALID_CHARACTER",
      message: "path contains control characters",
    };
  }
  if (raw.startsWith("/") || raw.startsWith("\\") || WINDOWS_DRIVE.test(raw)) {
    return {
      ok: false,
      code: "PATH_ABSOLUTE",
      message: `absolute paths are not allowed: "${raw}"`,
    };
  }
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") {
      return {
        ok: false,
        code: "PATH_TRAVERSAL",
        message: `path traversal ("..") is not allowed: "${raw}"`,
      };
    }
    if (segment.includes(":")) {
      return {
        ok: false,
        code: "PATH_INVALID_CHARACTER",
        message: `path segments must not contain ":" (drive prefix / alternate data stream): "${raw}"`,
      };
    }
    // Windows strips trailing dots and spaces from names: a segment that
    // collapses to nothing (or a dot name) extracts to a different path
    // than the one we validated.
    const windowsName = segment.replace(/[. ]+$/, "");
    if (windowsName === "" || windowsName === "." || windowsName === "..") {
      return {
        ok: false,
        code: "PATH_INVALID_CHARACTER",
        message: `path segment "${segment}" is not portable (empty or dot name after trailing dot/space stripping)`,
      };
    }
  }
  if (segments.length === 0) {
    return { ok: false, code: "PATH_EMPTY", message: "path is empty" };
  }
  // NFC is the canonical unicode form for bundle paths: it is what gets
  // stored, hashed, and used for duplicate detection.
  return { ok: true, path: segments.join("/").normalize("NFC") };
}

/**
 * Case-fold + unicode-normalization key used to detect paths that collide on
 * case-insensitive (macOS/Windows) extraction targets.
 */
export function caseFoldPath(path: string): string {
  return path.normalize("NFKC").toLowerCase();
}

/** `true` when `path` is `parentDir` itself or nested under it. */
export function isPathInside(parentDir: string, path: string): boolean {
  return path === parentDir || path.startsWith(`${parentDir}/`);
}

/**
 * Resolve a manifest/component-referenced relative path against a directory
 * inside the bundle. Absolute or traversing references escape the bundle root
 * and are rejected with `PATH_ESCAPES_ROOT`.
 */
export function resolveContainedPath(
  baseDir: string,
  ref: string
): PathNormalizationResult {
  const normalized = normalizeBundlePath(ref);
  if (!normalized.ok) {
    if (
      normalized.code === "PATH_ABSOLUTE" ||
      normalized.code === "PATH_TRAVERSAL"
    ) {
      return {
        ok: false,
        code: "PATH_ESCAPES_ROOT",
        message: `referenced path escapes the bundle root: "${ref}"`,
      };
    }
    return normalized;
  }
  return {
    ok: true,
    path: baseDir === "" ? normalized.path : `${baseDir}/${normalized.path}`,
  };
}

/**
 * Validate every listed entry against the path reject-list and archive limits,
 * returning the surviving files sorted by canonical path. All violations are
 * collected as error-severity issues; the caller throws before reading any
 * file content or normalizing any component.
 */
export function validateBundleEntries(
  entries: PluginFileEntry[],
  limits: PluginBundleLimits,
  issues: PluginIssueCollector
): NormalizedBundleEntry[] {
  if (entries.length > limits.maxEntries) {
    issues.error(
      "BUNDLE_TOO_MANY_ENTRIES",
      `bundle has ${entries.length} entries; the limit is ${limits.maxEntries}`
    );
  }

  const seen = new Set<string>();
  const folded = new Map<string, string>();
  const files: NormalizedBundleEntry[] = [];
  let totalBytes = 0;
  let totalReported = false;

  for (const entry of entries) {
    if (entry.kind === "symlink" || entry.kind === "hardlink") {
      issues.error("PATH_LINK_ENTRY", `${entry.kind} entries are not allowed`, {
        path: entry.path,
      });
      continue;
    }

    const normalized = normalizeBundlePath(entry.path);
    if (!normalized.ok) {
      issues.error(normalized.code, normalized.message, { path: entry.path });
      continue;
    }
    const path = normalized.path;

    if (utf8ByteLength(path) > limits.maxPathBytes) {
      issues.error(
        "PATH_TOO_LONG",
        `path exceeds ${limits.maxPathBytes} bytes`,
        { path }
      );
      continue;
    }
    if (path.split("/").length > limits.maxPathDepth) {
      issues.error(
        "PATH_TOO_DEEP",
        `path exceeds nesting depth ${limits.maxPathDepth}`,
        { path }
      );
      continue;
    }

    if (seen.has(path)) {
      issues.error("PATH_DUPLICATE", `duplicate normalized path: "${path}"`, {
        path: entry.path,
      });
      continue;
    }
    seen.add(path);

    const fold = caseFoldPath(path);
    const collidesWith = folded.get(fold);
    if (collidesWith !== undefined) {
      issues.error(
        "PATH_CASE_COLLISION",
        `"${path}" collides with "${collidesWith}" on case-insensitive filesystems`,
        { path }
      );
      continue;
    }
    folded.set(fold, path);

    if (entry.kind === "directory") {
      continue;
    }

    if (!Number.isFinite(entry.size) || entry.size < 0) {
      issues.error("FILE_SIZE_MISMATCH", "entry declares an invalid size", {
        path,
      });
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      issues.error(
        "FILE_TOO_LARGE",
        `file exceeds the per-file limit of ${limits.maxFileBytes} bytes`,
        { path }
      );
      continue;
    }
    totalBytes += entry.size;
    if (!totalReported && totalBytes > limits.maxTotalBytes) {
      totalReported = true;
      issues.error(
        "BUNDLE_TOO_LARGE",
        `total uncompressed content exceeds ${limits.maxTotalBytes} bytes`
      );
    }

    files.push({ sourcePath: entry.path, path, size: entry.size });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
