/**
 * The project path contract: `/p/<projectId>/<project-relative-path>`.
 *
 * The project is part of the canonical pathname for every project-owned
 * screen, so the address bar — not hidden local state — is what decides which
 * project a tab is looking at. Copy, refresh, Back/Forward, bookmarks, a
 * second tab, and an agent-returned link all keep the project they were
 * minted with.
 *
 * PURE on purpose: no React, no browser globals, no storage, no network. The
 * router, the navigation helpers, the legacy normalizers and the tests all
 * agree on one implementation of "what does this path mean", and that
 * implementation is testable as a table.
 *
 * The permalink SDK has its own runtime boundary and does NOT import this
 * module — but its contract tests must assert the same concrete examples.
 */

/** First segment of every project-scoped path. */
export const PROJECT_ROUTE_PREFIX = "/p";

/** Project home. The bare `/p/<id>` prefix is never a destination. */
export const PROJECT_HOME_RELATIVE_PATH = "/home";

/**
 * Convex ids are lowercase alphanumeric. One validator, exported, so the
 * router, the legacy `?project=` reader and the permalink checks cannot drift
 * into three slightly different notions of "looks like a project id".
 */
const PROJECT_ID_SHAPE = /^[a-z0-9]{16,64}$/;

/**
 * The local/no-Convex placeholder. It is a real value of `activeProjectId`,
 * and minting `/p/none/...` from it would put a non-project in the canonical
 * position of every URL, so it is rejected explicitly rather than left to the
 * shape regex.
 */
const NON_PROJECT_IDS: ReadonlySet<string> = new Set(["none", "local"]);

export interface ParsedProjectPath {
  projectId: string;
  /** Always starts with "/". `/p/<id>` alone parses to "/". */
  relativePath: string;
}

export function isProjectIdShape(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (NON_PROJECT_IDS.has(value)) return false;
  return PROJECT_ID_SHAPE.test(value);
}

/**
 * Split a target into its path and its `?search#hash` suffix.
 *
 * The suffix is carried byte-for-byte by every function here: a query string
 * is the caller's state (`?view=runs`, `?case=…`), not something to normalize
 * through `URLSearchParams` and hand back re-encoded.
 */
function splitTarget(target: string): { path: string; suffix: string } {
  const hashIndex = target.indexOf("#");
  const queryIndex = target.indexOf("?");
  let cut = -1;
  if (queryIndex >= 0 && (hashIndex < 0 || queryIndex < hashIndex)) {
    cut = queryIndex;
  } else if (hashIndex >= 0) {
    cut = hashIndex;
  }
  if (cut < 0) return { path: target, suffix: "" };
  return { path: target.slice(0, cut), suffix: target.slice(cut) };
}

/**
 * An absolute URL, a protocol-relative URL (`//evil.example`), or anything
 * else that could leave this origin. Rejected everywhere rather than
 * prefixed, because a "return here after sign-in" path that accepts these is
 * an open redirect.
 */
export function isAppRelativeTarget(target: string): boolean {
  if (typeof target !== "string") return false;
  const trimmed = target.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("//")) return false;
  // A scheme (`https:`, `javascript:`) or a backslash the browser normalizes
  // into a slash (`/\evil.example`).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  if (trimmed.includes("\\")) return false;
  return true;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Normalize a target to a single leading slash, without touching the rest. */
function withLeadingSlash(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path.replace(/^\/+/, "/") : `/${path}`;
}

/**
 * `/p/<id>/rest` → `{ projectId, relativePath: "/rest" }`; anything else →
 * null. A malformed, empty, or non-project id (`none`) is NOT a project path:
 * the router still matches `p/:projectId` and the boundary renders the
 * generic inaccessible state, but no navigation helper will ever treat it as
 * a project scope.
 */
export function parseProjectPath(pathname: string): ParsedProjectPath | null {
  if (typeof pathname !== "string" || !pathname) return null;
  const { path } = splitTarget(pathname);
  const normalized = withLeadingSlash(path);
  const match = /^\/p\/([^/]+)(\/.*)?$/.exec(normalized);
  if (!match) return null;
  const projectId = decodeSegment(match[1]);
  if (!isProjectIdShape(projectId)) return null;
  return { projectId, relativePath: match[2] || "/" };
}

/**
 * The project id segment of a `/p/<id>/...` path, VALID OR NOT.
 *
 * `parseProjectPath` answers "is this a usable project path"; this answers
 * "is this URL claiming a project at all". The route boundary needs the
 * second question: `/p/none/servers` and `/p/<typo>/servers` match the
 * `p/:projectId` route, and treating them as unscoped would render the
 * project screens below the boundary against whatever project was already
 * active — which is precisely the fallback this design forbids.
 */
export function readProjectPathSegment(pathname: string): string | null {
  if (typeof pathname !== "string" || !pathname) return null;
  const { path } = splitTarget(pathname);
  const match = /^\/p\/([^/]+)(\/.*)?$/.exec(withLeadingSlash(path));
  if (!match) return null;
  return decodeSegment(match[1]);
}

/** True for a path already scoped to a valid project. */
export function isProjectScopedPath(pathname: string): boolean {
  return parseProjectPath(pathname) !== null;
}

/**
 * Turn a logical, project-relative target (`/servers`,
 * `evals/suite/abc?view=runs#case`) into its concrete browser path under
 * `/p/<projectId>`.
 *
 * - an unusable project id returns the logical target unchanged, so a caller
 *   that has not resolved a project yet cannot mint `/p/none/...`;
 * - an off-origin target degrades to project home rather than becoming a
 *   redirect off this app;
 * - an already-scoped target is re-scoped, not double-prefixed, which is what
 *   makes this idempotent.
 *
 * The project id is encoded exactly once here. Everything after it is already
 * a URL path and is passed through verbatim.
 */
export function buildProjectPath(
  projectId: string,
  logicalTarget: string
): string {
  const target =
    typeof logicalTarget === "string" && logicalTarget.trim()
      ? logicalTarget.trim()
      : "/";
  if (!isProjectIdShape(projectId)) {
    return isAppRelativeTarget(target) ? withLeadingSlash(target) : "/";
  }
  const prefix = `${PROJECT_ROUTE_PREFIX}/${encodeURIComponent(projectId)}`;
  if (!isAppRelativeTarget(target)) {
    return `${prefix}${PROJECT_HOME_RELATIVE_PATH}`;
  }
  const alreadyScoped = parseProjectPath(target);
  if (alreadyScoped) {
    const { suffix } = splitTarget(target);
    const relative =
      alreadyScoped.relativePath === "/"
        ? PROJECT_HOME_RELATIVE_PATH
        : alreadyScoped.relativePath;
    return `${prefix}${relative}${suffix}`;
  }
  const { path, suffix } = splitTarget(target);
  const relative = withLeadingSlash(path);
  if (relative === "/") {
    return `${prefix}${PROJECT_HOME_RELATIVE_PATH}${suffix}`;
  }
  return `${prefix}${relative}${suffix}`;
}

/** Point an existing path (scoped or not) at another project. */
export function replaceProjectInPath(path: string, projectId: string): string {
  return buildProjectPath(projectId, path);
}

/**
 * `/p/<id>/servers?x#y` → `/servers?x#y`. Unscoped input is returned
 * unchanged, so this is safe to run over any path before matching it against
 * the logical route table.
 */
export function stripProjectFromPath(path: string): string {
  if (typeof path !== "string" || !path) return path;
  const parsed = parseProjectPath(path);
  if (!parsed) return path;
  const { suffix } = splitTarget(path);
  return `${parsed.relativePath}${suffix}`;
}

/** The `?project=<id>` field this migration accepts but never mints again. */
export const LEGACY_PROJECT_QUERY_PARAM = "project";

/**
 * Remove every `project` field from a raw query string, preserving the order
 * and the exact bytes of everything else.
 *
 * Deliberately not `URLSearchParams`: round-tripping through it re-encodes
 * fields the caller never asked to touch (`+` for space, percent-escapes
 * normalized), which is a visible change to somebody's `?case=` or `#`
 * selection state.
 */
export function stripLegacyProjectQuery(search: string): string {
  if (!search) return "";
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return "";
  const kept = raw
    .split("&")
    .filter((pair) => {
      if (!pair) return false;
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      return decodeSegment(key) !== LEGACY_PROJECT_QUERY_PARAM;
    })
    .join("&");
  return kept ? `?${kept}` : "";
}

/** Read a `?project=` id from a raw query string, or null if unusable. */
export function readLegacyProjectQuery(search: string): string | null {
  if (!search) return null;
  const raw = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (decodeSegment(key) !== LEGACY_PROJECT_QUERY_PARAM) continue;
    const value = eq === -1 ? "" : decodeSegment(pair.slice(eq + 1));
    if (isProjectIdShape(value)) return value;
  }
  return null;
}

/** True if the query carries a `project` field at all, valid or not. */
export function hasLegacyProjectQuery(search: string): boolean {
  if (!search) return false;
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return raw.split("&").some((pair) => {
    if (!pair) return false;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    return decodeSegment(key) === LEGACY_PROJECT_QUERY_PARAM;
  });
}

/**
 * A legacy entry point — an unscoped path, with or without `?project=` — to
 * its canonical form.
 *
 * `/evals/suite/X?project=A&view=runs#case` → `/p/A/evals/suite/X?view=runs#case`
 *
 * Only the `project` field is dropped; every other field, and the hash, comes
 * through untouched. Re-running this on its own output is a no-op.
 */
export function canonicalizeLegacyProjectTarget(args: {
  logicalTarget: string;
  projectId: string;
}): string {
  const { logicalTarget, projectId } = args;
  const target =
    typeof logicalTarget === "string" && logicalTarget ? logicalTarget : "/";
  if (!isAppRelativeTarget(target)) {
    return buildProjectPath(projectId, "/");
  }
  const hashIndex = target.indexOf("#");
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
  const beforeHash = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const queryIndex = beforeHash.indexOf("?");
  const path = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const search = queryIndex >= 0 ? beforeHash.slice(queryIndex) : "";
  const cleanedSearch = stripLegacyProjectQuery(search);
  const cleaned = `${path}${cleanedSearch}${hash}`;
  // An already-scoped path keeps ITS project. Re-scoping here would let a
  // second pass over a canonical URL rewrite it to the viewer's default —
  // the exact "the link said B, you got A" failure this migration removes —
  // and would turn any accidental re-entry into a redirect loop.
  if (parseProjectPath(cleaned)) return cleaned;
  return buildProjectPath(projectId, cleaned);
}
