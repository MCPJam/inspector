/**
 * Analytics prop builders for the Connect "Add plugin" surface (PR INS-2 of
 * docs/plans/openai-plugin-import-cross-repo.md).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a plugin bundle is user content, so
 * plugin telemetry must never carry "paths, manifest bodies, skill content,
 * environment values, header values, OAuth tokens, or source ZIP names that
 * may contain user information". Everything emitted from here is a COUNT, a
 * BOOLEAN, a byte size, a closed enum, or a stable machine code — never a
 * bundle path, server URL, env/header name, skill name, or the plugin's own
 * display name.
 *
 * The `bundleHash` prefix is the one identifier that ships: it is a content
 * digest (not a name), it is what the backend's own structured logs record,
 * and it is what makes "this import" joinable across client and server events.
 */

import type { PluginImportPreview } from "./plugin-api-types";

/** Characters allowed in an emitted machine code. */
const CODE_SHAPE = /^[A-Z0-9_]{1,64}$/;

/** How much of a bundle hash rides along (matches the backend log prefix). */
export const PLUGIN_BUNDLE_HASH_PREFIX_LENGTH = 12;

/**
 * Reduce an arbitrary error/issue code to a stable emittable token.
 *
 * Codes reaching the UI are not all backend-authored: `toPluginApiError`
 * falls back to `UNKNOWN` but SDK parser issues and future backend codes
 * arrive as free strings, and a code is exactly the kind of field a message
 * (with a path or URL inside it) could be misrouted into. Anything that is
 * not already an uppercase machine token is reported as `UNKNOWN` rather than
 * emitted verbatim.
 */
export function sanitizePluginCode(code: string | undefined | null): string {
  if (typeof code !== "string") return "UNKNOWN";
  const trimmed = code.trim();
  return CODE_SHAPE.test(trimmed) ? trimmed : "UNKNOWN";
}

/** First {@link PLUGIN_BUNDLE_HASH_PREFIX_LENGTH} hex chars of a bundle hash. */
export function pluginBundleHashPrefix(
  bundleHash: string | undefined | null,
): string | undefined {
  if (typeof bundleHash !== "string") return undefined;
  const hex = bundleHash.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  return hex.slice(0, PLUGIN_BUNDLE_HASH_PREFIX_LENGTH);
}

/**
 * Shape-only description of a preview: the component census plus the content
 * digest prefix. Deliberately drops `preview.identity` entirely — a plugin
 * name/description is authored by whoever wrote the bundle.
 */
export function pluginPreviewAnalyticsProps(
  preview: PluginImportPreview,
): Record<string, unknown> {
  const counts = preview.counts;
  return {
    bundle_hash_prefix: pluginBundleHashPrefix(preview.bundleHash),
    skill_count: counts.skills,
    server_count: counts.servers,
    app_count: counts.apps,
    asset_count: counts.assets,
    unsupported_count: counts.unsupported,
    warning_count: counts.warnings,
    setup_requirement_count: preview.setupRequirements.length,
    // Transports are a closed enum from the parser, so the mix is safe and
    // is the single most useful signal for "which runtimes must work next".
    stdio_server_count: preview.servers.filter((s) => s.transport === "stdio")
      .length,
    http_server_count: preview.servers.filter((s) => s.transport === "http")
      .length,
  };
}
