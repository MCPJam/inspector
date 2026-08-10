/**
 * Root-variable substitution AT SPAWN (INS-6).
 *
 * The SDK parser preserves `${PLUGIN_ROOT}` verbatim on purpose: at parse
 * time there IS no root — the bundle has not been materialized, and a value
 * baked in then would be a local absolute path persisted into an immutable,
 * content-addressed version (rotating its hash and pinning one user's home
 * directory into everyone's pin). Substitution belongs here, at the last
 * possible moment, against a cache directory derived from the bundle hash.
 *
 * `${PLUGIN_DATA}` substitutes to the writable per-plugin data directory
 * (`plugin-data.ts`) when the caller supplies one; without it the
 * placeholder stays verbatim and the leftover guard in
 * `preparePluginStdioLaunch` refuses the spawn — a child process never sees
 * a placeholder either way.
 *
 * The placeholder list itself is imported from the SDK rather than restated —
 * one list, one rule, no drift when the spec evolves.
 */
import {
  PLUGIN_ROOT_PLACEHOLDERS,
  containsPluginPlaceholder,
} from "@mcpjam/sdk/plugin-bundle";

/** The stdio fields a plugin component can express a root placeholder in. */
export interface PluginStdioLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  workingDirectory?: string;
}

/**
 * Environment variables every plugin child process gets, pointing at the
 * materialized bundle.
 */
export function pluginRootEnv(root: string): Record<string, string> {
  return { PLUGIN_ROOT: root };
}

/** Replace every known root placeholder in one value. */
export function substitutePluginRoot(value: string, root: string): string {
  let out = value;
  for (const placeholder of PLUGIN_ROOT_PLACEHOLDERS) {
    out = out.split(placeholder).join(root);
  }
  return out;
}

/**
 * Does any field still reference a plugin placeholder (`${PLUGIN_ROOT}` or
 * `${PLUGIN_DATA}`)? This is the detection signal that routes a server
 * config through the plugin materialization path instead of the ordinary
 * stdio spawn.
 */
export function needsPluginRoot(spec: PluginStdioLaunchSpec): boolean {
  return (
    containsPluginPlaceholder(spec.command) ||
    spec.args.some(containsPluginPlaceholder) ||
    Object.values(spec.env).some(containsPluginPlaceholder) ||
    (spec.workingDirectory !== undefined &&
      containsPluginPlaceholder(spec.workingDirectory))
  );
}

/**
 * Substitute both runtime placeholders in one value. `${PLUGIN_ROOT}` maps to
 * the immutable materialized bundle; `${PLUGIN_DATA}` maps to the writable
 * per-plugin data directory (spec: created before launch, preserved across
 * updates). When no data directory is supplied, `${PLUGIN_DATA}` is left
 * verbatim — the caller's leftover-placeholder guard then refuses the spawn,
 * so the literal can never reach a child process.
 */
export function substitutePluginPlaceholders(
  value: string,
  roots: { root: string; dataDir?: string }
): string {
  // Single pass over the ORIGINAL value: sequential per-token replacement
  // would re-scan earlier substitutions, so a substituted path that happened
  // to contain a literal placeholder token would be substituted again.
  return value.replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g, (token) =>
    token === "${PLUGIN_ROOT}" ? roots.root : (roots.dataDir ?? token)
  );
}

/**
 * Resolve a plugin stdio component against its materialized bundle and its
 * writable data directory.
 *
 * The injected `PLUGIN_ROOT`/`PLUGIN_DATA` aliases are applied FIRST; the
 * component's own env entries are substituted over them. (The SDK parser
 * rejects bundles whose env declares the reserved `PLUGIN_ROOT`/`PLUGIN_DATA`
 * keys, so the spec's env can never shadow the injected aliases.)
 */
export function resolvePluginStdioLaunch(
  spec: PluginStdioLaunchSpec,
  root: string,
  options?: { dataDir?: string }
): Required<Pick<PluginStdioLaunchSpec, "command" | "args" | "env">> & {
  workingDirectory?: string;
} {
  const roots = { root, dataDir: options?.dataDir };
  const env: Record<string, string> = {
    ...pluginRootEnv(root),
    ...(roots.dataDir !== undefined ? { PLUGIN_DATA: roots.dataDir } : {}),
  };
  for (const [key, value] of Object.entries(spec.env)) {
    env[key] = substitutePluginPlaceholders(value, roots);
  }
  return {
    command: substitutePluginPlaceholders(spec.command, roots),
    args: spec.args.map((arg) => substitutePluginPlaceholders(arg, roots)),
    env,
    ...(spec.workingDirectory !== undefined
      ? {
          workingDirectory: substitutePluginPlaceholders(
            spec.workingDirectory,
            roots
          ),
        }
      : {}),
  };
}
