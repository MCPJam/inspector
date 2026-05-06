/**
 * One-time migration shim from legacy localStorage state to Convex.
 *
 * Reads, in priority order: `mcp-inspector-projects`, the older
 * `mcp-inspector-workspaces`, and the still-older `mcp-inspector-state`
 * (pre-projects format whose servers live at the top level). For each, pushes
 * the resulting project(s) + servers to Convex via `projects:createProject`
 * (which materializes the flat `servers` rows via `syncProjectServers`), then
 * clears the legacy keys.
 *
 * **OAuth tokens are NOT migrated.** Hosted Convex stores tokens via the
 * vault-backed `hostedOAuthCredentials` table and there is no bulk-import
 * endpoint; the legacy `mcp-tokens-${name}` etc. localStorage tokens are
 * cleared during migration and users re-authenticate OAuth-enabled servers
 * on first connect post-migration. One-time UX cost vs. the cost of a new
 * import endpoint + vault encryption path.
 *
 * Runs once per install. Gated by `mcp-inspector-migrated-to-convex` flag.
 */
import { serializeServersForSharing } from "@/lib/project-serialization";
import {
  createLocalDefaultProject,
  type Project,
  type ServerWithName,
} from "@/state/app-types";
import { isProjectClientConfig } from "@/lib/client-config";

export const MIGRATION_FLAG_KEY = "mcp-inspector-migrated-to-convex";

// Tracks IDs of projects that have already been pushed to Convex within the
// current migration attempt. Used so a partial failure can be retried without
// re-creating the projects that already succeeded (which would duplicate them
// in Convex on the next boot).
export const MIGRATION_PROGRESS_KEY = "mcp-inspector-migration-progress";

const LEGACY_PROJECTS_KEY = "mcp-inspector-projects";
const LEGACY_WORKSPACES_KEY = "mcp-inspector-workspaces";
const LEGACY_STATE_KEY = "mcp-inspector-state";

// Per-server OAuth keys are name-scoped. Migration scans the full localStorage
// for these prefixes rather than enumerating known names — handles partial
// migrations from older inspector versions that may have used different keys.
// Keep `mcp-oauth-flow-state-` and `mcp-discovery-` in sync with the live keys
// in `client/src/lib/oauth/mcp-oauth.ts`; the legacy `mcp-oauth-discovery-`
// prefix is retained for installs that ran an older inspector build.
const LEGACY_OAUTH_PREFIXES = [
  "mcp-tokens-",
  "mcp-client-",
  "mcp-verifier-",
  "mcp-serverUrl-",
  "mcp-oauth-config-",
  "mcp-oauth-discovery-",
  "mcp-discovery-",
  "mcp-oauth-flow-state-",
  "mcp-env-",
];

const LEGACY_OAUTH_SINGLETONS = ["mcp-oauth-pending", "mcp-oauth-return-hash"];

export function hasMigrationCompleted(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return !!localStorage.getItem(MIGRATION_FLAG_KEY);
  } catch {
    // Treat localStorage-blocked environments as already-migrated; nothing
    // we can do for them anyway and we shouldn't keep retrying.
    return true;
  }
}

interface LegacyMigrationPayload {
  projects: Project[];
  envByName: Record<string, Record<string, string>>;
}

function reviveServer(name: string, raw: any): ServerWithName | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg: any = raw.config;
  let nextCfg = cfg;
  if (cfg && typeof cfg.url === "string") {
    try {
      nextCfg = { ...cfg, url: new URL(cfg.url) };
    } catch {
      // ignore invalid URL — keep original string
    }
  }
  return {
    ...raw,
    name: raw.name ?? name,
    config: nextCfg,
    connectionStatus: raw.connectionStatus || "disconnected",
    retryCount: raw.retryCount || 0,
    lastConnectionTime: raw.lastConnectionTime
      ? new Date(raw.lastConnectionTime)
      : new Date(),
    enabled: raw.enabled !== false,
  } as ServerWithName;
}

function readProjectsFromLegacyStorage(): Project[] {
  let raw: string | null;
  try {
    raw =
      localStorage.getItem(LEGACY_PROJECTS_KEY) ??
      localStorage.getItem(LEGACY_WORKSPACES_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rawProjects = parsed?.projects ?? parsed?.workspaces;
  if (!rawProjects || typeof rawProjects !== "object") return [];

  const projects: Project[] = [];
  for (const [id, projectRaw] of Object.entries(rawProjects)) {
    const p: any = projectRaw;
    if (!p || typeof p !== "object") continue;
    const servers: Record<string, ServerWithName> = {};
    if (p.servers && typeof p.servers === "object") {
      for (const [name, serverRaw] of Object.entries(p.servers)) {
        const revived = reviveServer(name, serverRaw);
        if (revived) servers[name] = revived;
      }
    }
    projects.push({
      id,
      name: typeof p.name === "string" && p.name.trim() ? p.name : "Untitled",
      description: typeof p.description === "string" ? p.description : undefined,
      icon: typeof p.icon === "string" ? p.icon : undefined,
      clientConfig: isProjectClientConfig(p.clientConfig)
        ? p.clientConfig
        : undefined,
      servers,
      createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
      updatedAt: p.updatedAt ? new Date(p.updatedAt) : new Date(),
      isDefault: p.isDefault === true,
      sharedProjectId:
        typeof p.sharedProjectId === "string" ? p.sharedProjectId : undefined,
      organizationId:
        typeof p.organizationId === "string" ? p.organizationId : undefined,
      visibility: p.visibility,
    });
  }
  return projects;
}

// Pre-projects format: `mcp-inspector-state` stored servers at the top level.
// Mirrors the in-process lift in `state/storage.ts` so users on this format
// don't end up with the migration-complete flag set + nothing in Convex.
function readProjectFromLegacyStateOnly(): Project | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_STATE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const rawServers = parsed?.servers;
  if (!rawServers || typeof rawServers !== "object") return null;

  const servers: Record<string, ServerWithName> = {};
  for (const [name, serverRaw] of Object.entries(rawServers)) {
    const revived = reviveServer(name, serverRaw);
    if (revived) servers[name] = revived;
  }
  if (Object.keys(servers).length === 0) return null;

  return createLocalDefaultProject({ servers });
}

export function readLegacyMigrationPayload(): LegacyMigrationPayload | null {
  if (typeof window === "undefined") return null;

  let projects = readProjectsFromLegacyStorage();
  if (projects.length === 0) {
    const stateProject = readProjectFromLegacyStateOnly();
    if (stateProject) {
      projects = [stateProject];
    }
  }

  // Pull mcp-env-${name} into a side map so the migration can merge env into
  // STDIO server config before serialization.
  const envByName: Record<string, Record<string, string>> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("mcp-env-")) continue;
      const name = key.slice("mcp-env-".length);
      try {
        const value = localStorage.getItem(key);
        if (!value) continue;
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          envByName[name] = parsed;
        }
      } catch {
        // ignore malformed env entries
      }
    }
  } catch {
    // localStorage blocked
  }

  if (projects.length === 0) return null;
  return { projects, envByName };
}

export function clearLegacyKeys(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(LEGACY_PROJECTS_KEY);
    localStorage.removeItem(LEGACY_WORKSPACES_KEY);
    localStorage.removeItem(LEGACY_STATE_KEY);
    for (const key of LEGACY_OAUTH_SINGLETONS) {
      localStorage.removeItem(key);
    }
    // Iterate by snapshotting keys first — removeItem mid-iteration shifts
    // indices on some implementations.
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (LEGACY_OAUTH_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // best-effort
  }
}

export function markMigrationComplete(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MIGRATION_FLAG_KEY, String(Date.now()));
  } catch {
    // best-effort
  }
}

function readMigratedProjectIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(MIGRATION_PROGRESS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
    }
  } catch {
    // ignore — treat as empty set; worst case we re-attempt a project
  }
  return new Set();
}

function recordMigratedProjectId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = readMigratedProjectIds();
    current.add(id);
    localStorage.setItem(
      MIGRATION_PROGRESS_KEY,
      JSON.stringify(Array.from(current)),
    );
  } catch {
    // best-effort
  }
}

function clearMigrationProgress(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(MIGRATION_PROGRESS_KEY);
  } catch {
    // best-effort
  }
}

export interface MigrationDeps {
  createProject: (args: {
    name: string;
    description?: string;
    icon?: string;
    clientConfig?: unknown;
    servers: Record<string, unknown>;
    organizationId?: string;
    visibility?: "public" | "private";
  }) => Promise<unknown>;
  /**
   * Org id to migrate into. Pass `undefined` to let Convex pick the actor's
   * default org (works for both guests and signed-in users without an
   * explicit selection).
   */
  organizationId?: string;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export interface MigrationResult {
  ok: boolean;
  projectsMigrated: number;
  errors: Array<{ projectName: string; error: string }>;
}

/**
 * Execute the migration. Caller is responsible for gating on
 * `hasMigrationCompleted()` and Convex auth readiness.
 *
 * Behavior:
 *  - If no legacy data: marks migration complete (no-op success).
 *  - For each project, calls `createProject` with `servers` containing the
 *    serialized form (incl. STDIO env merged from `mcp-env-${name}`).
 *  - On any per-project failure, the others still proceed; result.ok is
 *    `false` if any project failed.
 *  - On overall success, clears legacy keys and sets the flag.
 *  - On partial success (some projects failed), leaves legacy keys in place
 *    so a subsequent boot can retry — a partial migration shouldn't drop
 *    user data. Successful projects are recorded under
 *    `MIGRATION_PROGRESS_KEY` so the retry skips them and we don't duplicate
 *    them in Convex.
 */
export async function runLocalStateMigration(
  deps: MigrationDeps
): Promise<MigrationResult> {
  const payload = readLegacyMigrationPayload();
  if (!payload) {
    clearMigrationProgress();
    markMigrationComplete();
    return { ok: true, projectsMigrated: 0, errors: [] };
  }

  const errors: MigrationResult["errors"] = [];
  let projectsMigrated = 0;
  const alreadyMigrated = readMigratedProjectIds();

  for (const project of payload.projects) {
    if (alreadyMigrated.has(project.id)) {
      deps.logger?.info("Skipping already-migrated project", {
        name: project.name,
        id: project.id,
      });
      continue;
    }
    // Merge mcp-env-${name} into per-server config so syncProjectServers picks
    // it up. STDIO servers may have env in either place; the merge is
    // last-write-wins favoring the localStorage env entry (which is what the
    // user actually configured most recently).
    const projectServers: Record<string, ServerWithName> = {};
    for (const [name, server] of Object.entries(project.servers)) {
      const env = payload.envByName[name];
      if (env && env !== undefined && (server.config as any)?.command) {
        projectServers[name] = {
          ...server,
          config: {
            ...(server.config as any),
            env: { ...((server.config as any).env ?? {}), ...env },
          } as any,
        };
      } else {
        projectServers[name] = server;
      }
    }

    const serializedServers = serializeServersForSharing(projectServers);
    try {
      await deps.createProject({
        name: project.name,
        description: project.description,
        icon: project.icon,
        clientConfig: project.clientConfig,
        servers: serializedServers,
        organizationId: deps.organizationId,
      });
      recordMigratedProjectId(project.id);
      projectsMigrated++;
      deps.logger?.info("Migrated local project to Convex", {
        name: project.name,
        serverCount: Object.keys(projectServers).length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ projectName: project.name, error: message });
      deps.logger?.error("Failed to migrate local project", {
        name: project.name,
        error: message,
      });
    }
  }

  if (errors.length === 0) {
    clearLegacyKeys();
    clearMigrationProgress();
    markMigrationComplete();
    return { ok: true, projectsMigrated, errors };
  }

  // Partial success — keep legacy keys so we can retry. The
  // MIGRATION_PROGRESS_KEY records which projects already succeeded so the
  // next boot doesn't recreate them in Convex.
  return { ok: false, projectsMigrated, errors };
}
