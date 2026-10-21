import {
  bundledHostCompatCatalog,
  getCatalogHost,
  getTemplateMcpAppsCapabilities,
  mcpAppsCapabilitiesSchema,
} from "@mcpjam/sdk/host-compat";
import { z } from "zod";

/** The part of a profile this resolver reads; other keys pass through. */
export const browserMcpProfileSchema = z
  .object({
    apps: z
      .object({ mcpAppsOverrides: mcpAppsCapabilitiesSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const configSchema = z.object({
  hostStyle: z.string().optional(),
  hostCapabilitiesOverride: z.record(z.string(), z.unknown()).optional(),
  mcpProfile: browserMcpProfileSchema.optional(),
});

/** Resolve saved profile switches before handing capabilities to the browser. */
export function resolveBrowserHostCapabilities(
  base?: unknown,
  override?: unknown,
): Record<string, unknown> | undefined {
  const baseConfig = configSchema.parse(base ?? {});
  const config = { ...baseConfig, ...configSchema.parse(override ?? {}) };
  const overrides = config.mcpProfile?.apps?.mcpAppsOverrides;
  if (
    overrides === undefined &&
    config.hostCapabilitiesOverride !== undefined
  ) {
    const { sandbox: _sandbox, ...capabilities } =
      config.hostCapabilitiesOverride;
    return capabilities;
  }
  // Legacy callers with no saved profile retain the harness's existing defaults.
  if (!config.hostStyle && overrides === undefined) return undefined;
  const catalog = bundledHostCompatCatalog();
  const preset = config.hostStyle
    ? getTemplateMcpAppsCapabilities(catalog, config.hostStyle)
    : undefined;
  const matrix = { ...preset, ...overrides };
  const details = config.hostStyle
    ? getCatalogHost(catalog, config.hostStyle)?.hostCapabilitiesOverride
    : undefined;
  const capabilities: Record<string, unknown> = {};
  for (const key of [
    "openLinks",
    "serverTools",
    "serverResources",
    "logging",
    "updateModelContext",
    "message",
    "downloadFile",
  ] as const) {
    if (matrix[key] === true) {
      capabilities[key] =
        details?.[key] ??
        (key === "message" || key === "updateModelContext" ? { text: {} } : {});
    }
  }
  return capabilities;
}
