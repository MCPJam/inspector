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
 * `${PLUGIN_DATA}` (the writable per-plugin data directory the Agent Plugins
 * spec requires) is detected but NOT yet substituted — the data-directory
 * runtime lands in the runtime-fidelity phase. Until then a component whose
 * spec references it is still recognized as a plugin component, so it can
 * never spawn through the ordinary non-plugin path with the placeholder
 * intact.
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
 * Resolve a plugin stdio component against its materialized bundle.
 *
 * The injected `PLUGIN_ROOT` alias is applied FIRST; the component's own env
 * entries are substituted over it. (The SDK parser rejects bundles whose env
 * declares the reserved `PLUGIN_ROOT`/`PLUGIN_DATA` keys, so the spec's env
 * can never shadow the injected alias.)
 */
export function resolvePluginStdioLaunch(
  spec: PluginStdioLaunchSpec,
  root: string
): Required<Pick<PluginStdioLaunchSpec, "command" | "args" | "env">> & {
  workingDirectory?: string;
} {
  const env: Record<string, string> = { ...pluginRootEnv(root) };
  for (const [key, value] of Object.entries(spec.env)) {
    env[key] = substitutePluginRoot(value, root);
  }
  return {
    command: substitutePluginRoot(spec.command, root),
    args: spec.args.map((arg) => substitutePluginRoot(arg, root)),
    env,
    ...(spec.workingDirectory !== undefined
      ? { workingDirectory: substitutePluginRoot(spec.workingDirectory, root) }
      : {}),
  };
}
