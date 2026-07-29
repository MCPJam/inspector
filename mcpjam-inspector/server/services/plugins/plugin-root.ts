/**
 * Root-variable substitution AT SPAWN (INS-6).
 *
 * The SDK parser preserves `${PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}` verbatim
 * on purpose: at parse time there IS no root — the bundle has not been
 * materialized, and a value baked in then would be a local absolute path
 * persisted into an immutable, content-addressed version (rotating its hash and
 * pinning one user's home directory into everyone's pin). Substitution belongs
 * here, at the last possible moment, against a cache directory derived from the
 * bundle hash.
 *
 * The placeholder list itself is imported from the SDK rather than restated —
 * one list, one rule, no drift when a third alias appears.
 */
import {
  PLUGIN_ROOT_PLACEHOLDERS,
  containsRootPlaceholder,
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
 * materialized bundle. Both names are set unconditionally: a bundle authored
 * against Codex reads `CODEX_PLUGIN_ROOT`, ours reads `PLUGIN_ROOT`, and a
 * component that resolves its own assets at runtime (rather than through an
 * argv placeholder) can only work if the alias it was written against exists.
 */
export function pluginRootEnv(root: string): Record<string, string> {
  return { PLUGIN_ROOT: root, CODEX_PLUGIN_ROOT: root };
}

/** Replace every known root placeholder in one value. */
export function substitutePluginRoot(value: string, root: string): string {
  let out = value;
  for (const placeholder of PLUGIN_ROOT_PLACEHOLDERS) {
    out = out.split(placeholder).join(root);
  }
  return out;
}

/** Does any field still reference a root placeholder? */
export function needsPluginRoot(spec: PluginStdioLaunchSpec): boolean {
  return (
    containsRootPlaceholder(spec.command) ||
    spec.args.some(containsRootPlaceholder) ||
    Object.values(spec.env).some(containsRootPlaceholder) ||
    (spec.workingDirectory !== undefined &&
      containsRootPlaceholder(spec.workingDirectory))
  );
}

/**
 * Resolve a plugin stdio component against its materialized bundle.
 *
 * The injected root aliases are applied FIRST and can be overridden by the
 * component's own env only if the bundle explicitly declares those names —
 * substitution runs over the merged map, so a component that sets
 * `PLUGIN_ROOT=${PLUGIN_ROOT}/inner` still gets a real path.
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
