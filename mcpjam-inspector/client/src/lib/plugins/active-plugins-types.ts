/**
 * Hand-mirrored result of `plugins:resolveActivePlugins` (two-repo layout —
 * the backend owns the contract; see `plugin-api-types.ts` for the other
 * mirrored plugin shapes).
 *
 * The query answers "which installed plugins does a normal (host-target)
 * Playground chat run right now, and why are the others skipped". The client
 * calls it with `content: false`, so skill bodies are `''` and file URLs are
 * `null`; only the server reads it with content.
 */

/** Why a plugin does not contribute to a turn. */
export type ActivePluginSkipReason =
  | "disabled"
  | "not_ready"
  | "no_active_version"
  | "over_cap"
  | "server_missing"
  | "placement"
  | "needs_auth"
  | "needs_setup"
  | "skill_unpinnable"
  /** Widened: a newer backend may report a reason this mirror lacks. */
  | (string & {});

export type ActivePluginPlacement = "remote" | "local" | "computer";

export interface ActivePluginVersion {
  pluginId: string;
  pluginVersionId: string;
  /** Normalized plugin name (the modelRef namespace). */
  name: string;
  bundleHash: string;
}

export interface ActivePluginServerRow {
  serverId: string;
  name: string;
  componentKey: string;
  placement: ActivePluginPlacement;
}

export interface ActivePluginSkillRow {
  skillId: string;
  modelRef: string;
  name: string;
  description: string;
}

/**
 * One row per installed (non-uninstalled) plugin, contributing or skipped, in
 * plugin order. `servers` / `skills` list the ACTIVE version's components even
 * when the plugin is skipped.
 */
export interface ActivePluginRow {
  pluginId: string;
  /** The active version, if any. */
  pluginVersionId: string | null;
  name: string;
  displayName: string | null;
  status: "active" | "skipped";
  /** Present when `status === "skipped"`. */
  reason?: ActivePluginSkipReason;
  /** The component that caused the skip, when one did. */
  componentKey?: string;
  servers: ActivePluginServerRow[];
  skills: ActivePluginSkillRow[];
}

export interface ActivePluginsResult {
  /** false = gate denied or guest; every list below is empty. */
  enabled: boolean;
  /** Versions that contribute this turn, in plugin order. */
  pluginVersions: ActivePluginVersion[];
  servers: {
    selectedServerIds: string[];
    pluginServerIds: string[];
    baseEffectiveServerIds: string[];
    effectiveServerIds: string[];
    connectable: Array<{ serverId: string; name: string; source: "plugin" }>;
  };
  skills: Array<{
    skillId: string;
    name: string;
    description: string;
    /** `''` on the client read (`content: false`). */
    content: string;
    aggregateHash: string;
    extraFrontmatter?: Record<string, unknown>;
    channels: string[];
    provenance: unknown;
    files: Array<{ path: string; size: number; url: string | null }>;
  }>;
  serverSkills: unknown[];
  attribution: {
    pluginVersions: ActivePluginVersion[];
    effectiveServerIds: string[];
    serverComponents: Array<{
      pluginVersionId: string;
      componentKey: string;
      placement: ActivePluginPlacement;
      authenticationPolicy: "on_install" | "on_use";
      materializedServerId: string;
    }>;
    pluginSkills: Array<{
      pluginVersionId: string;
      modelRef: string;
      materializedSkillId: string;
    }>;
    unavailableComponents: unknown[];
  };
  plugins: ActivePluginRow[];
}
