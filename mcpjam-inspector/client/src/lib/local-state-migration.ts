/**
 * One-time migration shim from legacy localStorage state to Convex.
 *
 * Reads, in priority order: `mcp-inspector-projects`, the older
 * `mcp-inspector-workspaces`, and the still-older `mcp-inspector-state`
 * (pre-projects format whose servers live at the top level). For each, pushes
 * the resulting project(s) + servers to Convex via `projects:createProject`
 * (which materializes the flat `servers` rows via `syncProjectServers`).
 *
 * **OAuth tokens are imported.** After each `createProject`, the migration
 * resolves the new server IDs by name (`projects:getProjectServers`) and
 * POSTs legacy `mcp-tokens-${name}` + `mcp-client-${name}` +
 * `mcp-oauth-config-${name}` to `/api/web/oauth/import-tokens` so users do
 * NOT need to re-authenticate previously-authorized servers. On import
 * failure, legacy OAuth keys are preserved and the per-server progress map
 * allows a clean retry on the next boot. The backend write
 * (`rotateStoredCredential`) is idempotent, so retries are safe.
 *
 * Runs once per install. Gated by `mcp-inspector-migrated-to-convex` flag.
 */
import { serializeServersForPersistence } from "@/lib/project-serialization";
import {
  normalizeImportHostedOAuthTokens,
  type ImportHostedOAuthTokensRequest,
} from "@/lib/apis/hosted-oauth-import-tokens-api";
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

/**
 * Distinguishes "no legacy data to migrate" from "legacy data exists but we
 * couldn't parse it." The migration runner needs to mark itself complete in
 * the first case (so we don't keep re-reading on every boot) but must NOT
 * mark complete in the second case (so a fix to the parsing path or a manual
 * recovery can still pick the data up later).
 */
export type LegacyReadResult =
  | { kind: "empty" }
  | { kind: "unreadable"; reason: string }
  | { kind: "payload"; payload: LegacyMigrationPayload };


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

/**
 * Returns the parsed projects, or `null` when the legacy keys exist but
 * couldn't be parsed (so the caller can surface "unreadable" instead of
 * silently treating it as empty), or `[]` when neither key is present at all.
 */
function readProjectsFromLegacyStorage(): Project[] | null {
  let raw: string | null;
  try {
    raw =
      localStorage.getItem(LEGACY_PROJECTS_KEY) ??
      localStorage.getItem(LEGACY_WORKSPACES_KEY);
  } catch {
    return null;
  }
  if (!raw) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const rawProjects = parsed?.projects ?? parsed?.workspaces;
  if (!rawProjects || typeof rawProjects !== "object") return null;

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
//
// Returns:
//  - `Project` when STATE was readable and contained at least one server.
//  - `null` when the STATE key wasn't present at all OR contained no servers.
//  - the literal string "unreadable" when the key was present but unparseable.
function readProjectFromLegacyStateOnly():
  | Project
  | null
  | "unreadable" {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_STATE_KEY);
  } catch {
    return "unreadable";
  }
  if (!raw) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
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

/**
 * Tri-state: distinguishes "no legacy data to migrate" (callers should mark
 * complete so we stop retrying) from "legacy data exists but we can't read
 * it" (callers must NOT mark complete — a parser fix or recovery should
 * still be able to pick the data up later).
 */
export function readLegacyMigrationPayloadResult(): LegacyReadResult {
  if (typeof window === "undefined") return { kind: "empty" };

  const projectsRead = readProjectsFromLegacyStorage();

  // If the newer projects/workspaces store is present but unparseable, stop
  // here. Falling back to `mcp-inspector-state` and migrating that successfully
  // would let `clearLegacyKeys()` delete the unreadable newer store along
  // with the rest, losing data that a future parser fix or manual recovery
  // could have salvaged. Surface as `unreadable` so the runner records the
  // failure, leaves every legacy key in place, and retries later.
  if (projectsRead === null) {
    return {
      kind: "unreadable",
      reason: "legacy projects/workspaces store is unreadable",
    };
  }

  let projects: Project[] = projectsRead;
  let unreadable: string | null = null;

  if (projects.length === 0) {
    const stateResult = readProjectFromLegacyStateOnly();
    if (stateResult === "unreadable") {
      unreadable = "legacy state store is unreadable";
    } else if (stateResult) {
      projects = [stateResult];
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

  if (projects.length > 0) {
    return { kind: "payload", payload: { projects, envByName } };
  }
  if (unreadable) {
    return { kind: "unreadable", reason: unreadable };
  }
  // No projects, no STATE servers, no parse failures — and we already returned
  // early on no-window. If a legacy key file was present but contained an
  // empty `projects: {}` map, treat it as truly empty so we can mark complete.
  return { kind: "empty" };
}

/**
 * Convenience wrapper preserved for tests and any caller that doesn't care
 * about the absent-vs-unreadable distinction. New callers should prefer
 * `readLegacyMigrationPayloadResult` so they can decide whether to mark
 * the migration complete.
 */
export function readLegacyMigrationPayload(): LegacyMigrationPayload | null {
  const result = readLegacyMigrationPayloadResult();
  return result.kind === "payload" ? result.payload : null;
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

/**
 * Per-project migration progress, keyed by the LEGACY project id. Tracks the
 * Convex projectId allocated for the project plus which server names have
 * been successfully token-imported, so a partial failure can resume at the
 * next boot without re-creating projects or re-importing tokens that already
 * landed.
 *
 * Backwards compat: an older (`string[]`) shape is migrated in-place to the
 * new shape on read. The Convex project id is `null` for entries from the
 * old shape; OAuth import retries for those won't have a server-id mapping
 * and will be skipped (one-time UX cost vs. unbounded retries against an
 * unknown projectId).
 */
type MigrationProgressEntry = {
  convexProjectId: string | null;
  tokensByServerName: Record<string, "imported">;
};
type MigrationProgress = Record<string, MigrationProgressEntry>;

function readMigrationProgress(): MigrationProgress {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(MIGRATION_PROGRESS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy shape: lift to new shape with no convex project id.
      const out: MigrationProgress = {};
      for (const id of parsed) {
        if (typeof id === "string") {
          out[id] = { convexProjectId: null, tokensByServerName: {} };
        }
      }
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const out: MigrationProgress = {};
      for (const [id, entryRaw] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        const entry = entryRaw as Partial<MigrationProgressEntry> | undefined;
        out[id] = {
          convexProjectId:
            typeof entry?.convexProjectId === "string"
              ? entry.convexProjectId
              : null,
          tokensByServerName:
            entry?.tokensByServerName &&
            typeof entry.tokensByServerName === "object"
              ? Object.fromEntries(
                  Object.entries(entry.tokensByServerName).filter(
                    ([, v]) => v === "imported",
                  ),
                )
              : {},
        };
      }
      return out;
    }
  } catch {
    // ignore — treat as empty progress; worst case we re-attempt a project
  }
  return {};
}

function writeMigrationProgress(progress: MigrationProgress): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MIGRATION_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // best-effort
  }
}

function recordProjectCreated(
  legacyProjectId: string,
  convexProjectId: string,
): void {
  const progress = readMigrationProgress();
  const existing = progress[legacyProjectId] ?? {
    convexProjectId: null,
    tokensByServerName: {},
  };
  progress[legacyProjectId] = {
    ...existing,
    convexProjectId,
  };
  writeMigrationProgress(progress);
}

function recordTokensImported(
  legacyProjectId: string,
  serverName: string,
): void {
  const progress = readMigrationProgress();
  const existing = progress[legacyProjectId] ?? {
    convexProjectId: null,
    tokensByServerName: {},
  };
  progress[legacyProjectId] = {
    ...existing,
    tokensByServerName: {
      ...existing.tokensByServerName,
      [serverName]: "imported",
    },
  };
  writeMigrationProgress(progress);
}

/**
 * Read legacy OAuth state for a single server name. Returns `null` when the
 * server has no legacy tokens (nothing to import). Field renames are
 * intentional: legacy storage uses OAuth-cased `client_id`/`client_secret`
 * and `resourceUrl`, while the import payload uses camelCase `clientId`/
 * `clientSecret` and `oauthResourceUrl`. Do not spread legacy values
 * directly — always rename through this helper.
 */
function readLegacyOAuthForServer(name: string): {
  tokens: ImportHostedOAuthTokensRequest["tokens"];
  clientInformation: ImportHostedOAuthTokensRequest["clientInformation"];
  oauthResourceUrl?: string;
  registryServerId?: string;
  useRegistryOAuthProxy?: boolean;
  serverUrl?: string;
} | null {
  if (typeof window === "undefined") return null;
  let tokensRaw: string | null;
  try {
    tokensRaw = localStorage.getItem(`mcp-tokens-${name}`);
  } catch {
    return null;
  }
  if (!tokensRaw) return null;
  let parsedTokens: unknown;
  try {
    parsedTokens = JSON.parse(tokensRaw);
  } catch {
    return null;
  }
  const normalizedTokens = normalizeImportHostedOAuthTokens(parsedTokens);
  if (!normalizedTokens) {
    return null;
  }

  let clientId: string | undefined;
  let clientSecret: string | undefined;
  try {
    const raw = localStorage.getItem(`mcp-client-${name}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.client_id === "string") clientId = parsed.client_id;
        if (typeof parsed.client_secret === "string")
          clientSecret = parsed.client_secret;
      }
    }
  } catch {
    // ignore unparseable client info — bail on missing clientId below
  }
  if (!clientId) return null; // import requires clientId for generic kind

  let oauthResourceUrl: string | undefined;
  let registryServerId: string | undefined;
  let useRegistryOAuthProxy: boolean | undefined;
  try {
    const raw = localStorage.getItem(`mcp-oauth-config-${name}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.resourceUrl === "string")
          oauthResourceUrl = parsed.resourceUrl;
        if (typeof parsed.registryServerId === "string")
          registryServerId = parsed.registryServerId;
        if (typeof parsed.useRegistryOAuthProxy === "boolean")
          useRegistryOAuthProxy = parsed.useRegistryOAuthProxy;
      }
    }
  } catch {
    // ignore
  }

  let serverUrl: string | undefined;
  try {
    const raw = localStorage.getItem(`mcp-serverUrl-${name}`);
    if (raw) serverUrl = raw;
  } catch {
    // ignore
  }

  return {
    tokens: normalizedTokens,
    clientInformation: {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    },
    ...(oauthResourceUrl ? { oauthResourceUrl } : {}),
    ...(registryServerId ? { registryServerId } : {}),
    ...(useRegistryOAuthProxy
      ? { useRegistryOAuthProxy }
      : {}),
    ...(serverUrl ? { serverUrl } : {}),
  };
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
   * Returns the actor's default Convex project id, creating one if none
   * exists. Used for the legacy default-project (`isDefault: true`) branch
   * to merge into the auto-provisioned Convex default instead of calling
   * `createProject`, which would trip `enforceOrganizationProjectLimit` on
   * free-plan orgs (cap=1) where the auto-default already fills the slot.
   *
   * Optional: when omitted (or paired with no `mergeServersIntoExistingProject`),
   * the migration falls back to `createProject` for default projects too,
   * preserving the pre-fix behaviour for tests.
   */
  ensureDefaultProject?: (args: {
    organizationId?: string;
  }) => Promise<string>;
  /**
   * Idempotent merge: pushes the local project's servers into an existing
   * Convex project without deleting servers that aren't in the incoming map.
   * Paired with `ensureDefaultProject`; both must be supplied to take the
   * default-project merge path.
   */
  mergeServersIntoExistingProject?: (args: {
    projectId: string;
    servers: Record<string, unknown>;
  }) => Promise<unknown>;
  /**
   * Resolves the Convex server IDs created by `createProject`, keyed by
   * server name. Used to map legacy name-scoped OAuth state to new
   * `(projectId, serverId)` pairs for `/api/web/oauth/import-tokens`.
   * Optional: when omitted, OAuth-token migration is skipped (legacy
   * behaviour). The real hook in `use-local-state-migration` always
   * supplies it.
   */
  listProjectServers?: (
    projectId: string,
  ) => Promise<Array<{ _id: string; name: string }>>;
  /**
   * Posts pre-exchanged tokens to the inspector's
   * `/api/web/oauth/import-tokens` proxy. Backend write is idempotent so
   * retries on failure are safe. Optional: paired with
   * `listProjectServers` — both must be provided to import tokens.
   */
  importTokens?: (payload: ImportHostedOAuthTokensRequest) => Promise<unknown>;
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
  const result = readLegacyMigrationPayloadResult();
  if (result.kind === "empty") {
    clearMigrationProgress();
    markMigrationComplete();
    return { ok: true, projectsMigrated: 0, errors: [] };
  }
  if (result.kind === "unreadable") {
    // Legacy data exists but we can't parse it. Don't mark complete — a
    // future build with a fixed parser (or a manual recovery) should still
    // be able to migrate this user. Surface as a one-element error list so
    // the runner reports `ok: false` and the caller logs/retries.
    deps.logger?.warn("Legacy migration payload unreadable", {
      reason: result.reason,
    });
    return {
      ok: false,
      projectsMigrated: 0,
      errors: [
        { projectName: "(unreadable legacy state)", error: result.reason },
      ],
    };
  }
  const payload = result.payload;

  const errors: MigrationResult["errors"] = [];
  let projectsMigrated = 0;
  const progress = readMigrationProgress();

  for (const project of payload.projects) {
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

    const existingEntry = progress[project.id];
    let convexProjectId: string | null = existingEntry?.convexProjectId ?? null;

    if (!convexProjectId) {
      // Either first attempt for this project, or an older `string[]`
      // progress entry without a stored convex id.
      const serializedServers = serializeServersForPersistence(projectServers);

      // Default-project branch: the actor already has an auto-provisioned
      // Convex default (created by `users:ensureUser`). Calling
      // `createProject` here would trip `maxWorkspaces` on free-plan orgs
      // (cap=1, slot already filled). Resolve the existing default and
      // merge servers into it instead. Idempotent on retry.
      const useDefaultMergePath =
        project.isDefault === true &&
        typeof deps.ensureDefaultProject === "function" &&
        typeof deps.mergeServersIntoExistingProject === "function";

      if (useDefaultMergePath) {
        try {
          const ensured = await deps.ensureDefaultProject!({
            organizationId: deps.organizationId,
          });
          if (typeof ensured !== "string" || !ensured) {
            throw new Error(
              "ensureDefaultProject returned no project id"
            );
          }
          await deps.mergeServersIntoExistingProject!({
            projectId: ensured,
            servers: serializedServers,
          });
          convexProjectId = ensured;
          recordProjectCreated(project.id, convexProjectId);
          projectsMigrated++;
          deps.logger?.info(
            "Merged local default project into existing Convex default",
            {
              name: project.name,
              convexProjectId,
              serverCount: Object.keys(projectServers).length,
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push({ projectName: project.name, error: message });
          deps.logger?.error(
            "Failed to merge local default project into Convex default",
            { name: project.name, error: message },
          );
          continue;
        }
      } else {
        try {
          const created = await deps.createProject({
            name: project.name,
            description: project.description,
            icon: project.icon,
            clientConfig: project.clientConfig,
            servers: serializedServers,
            organizationId: deps.organizationId,
            visibility: project.visibility,
          });
          convexProjectId = typeof created === "string" ? created : null;
          if (convexProjectId) {
            recordProjectCreated(project.id, convexProjectId);
          }
          projectsMigrated++;
          deps.logger?.info("Migrated local project to Convex", {
            name: project.name,
            serverCount: Object.keys(projectServers).length,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push({ projectName: project.name, error: message });
          deps.logger?.error("Failed to migrate local project", {
            name: project.name,
            error: message,
          });
          continue;
        }
      }
    } else {
      deps.logger?.info("Resuming OAuth import for migrated project", {
        name: project.name,
        convexProjectId,
      });
    }

    if (!convexProjectId) continue;
    if (!deps.listProjectServers || !deps.importTokens) continue;

    // Servers with already-imported tokens skip the round-trip entirely;
    // backend write is idempotent so re-importing on retry is safe but
    // wastes a request and produces noise.
    const alreadyImported =
      progress[project.id]?.tokensByServerName ??
      existingEntry?.tokensByServerName ??
      {};

    const listProjectServers = deps.listProjectServers;
    const importTokens = deps.importTokens;
    let serversByName: Record<string, string> = {};
    let projectImportFailed = false;
    try {
      const list = await listProjectServers(convexProjectId);
      for (const entry of list) {
        if (entry?.name) serversByName[entry.name] = entry._id;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({
        projectName: project.name,
        error: `Failed to resolve server IDs: ${message}`,
      });
      projectImportFailed = true;
      deps.logger?.error("Failed to list project servers post-migration", {
        name: project.name,
        error: message,
      });
    }

    if (!projectImportFailed) {
      for (const serverName of Object.keys(projectServers)) {
        if (alreadyImported[serverName] === "imported") continue;
        const legacy = readLegacyOAuthForServer(serverName);
        if (!legacy) continue;
        const serverId = serversByName[serverName];
        if (!serverId) {
          // Server didn't materialize under the new project (e.g.,
          // syncProjectServers filtered it out). Nothing to attach tokens
          // to — skip without failing the project.
          continue;
        }
        const serverConfig = projectServers[serverName].config as any;
        const serverUrl =
          legacy.serverUrl ??
          (typeof serverConfig?.url === "string"
            ? serverConfig.url
            : serverConfig?.url?.href ?? undefined);
        if (!serverUrl) continue;
        const isRegistry =
          !!legacy.registryServerId &&
          legacy.useRegistryOAuthProxy === true;
        try {
          await importTokens({
            projectId: convexProjectId,
            serverId,
            serverUrl,
            ...(legacy.oauthResourceUrl
              ? { oauthResourceUrl: legacy.oauthResourceUrl }
              : {}),
            kind: isRegistry ? "registry" : "generic",
            ...(isRegistry
              ? {
                  registryServerId: legacy.registryServerId,
                  useRegistryOAuthProxy: true,
                }
              : {}),
            clientInformation: legacy.clientInformation,
            tokens: legacy.tokens,
          });
          recordTokensImported(project.id, serverName);
          deps.logger?.info("Imported legacy OAuth tokens", {
            projectName: project.name,
            serverName,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          projectImportFailed = true;
          errors.push({
            projectName: project.name,
            error: `OAuth import for server "${serverName}" failed: ${message}`,
          });
          deps.logger?.warn(
            "Failed to import legacy OAuth tokens; will retry on next boot",
            { projectName: project.name, serverName, error: message },
          );
        }
      }
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
