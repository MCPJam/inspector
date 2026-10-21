import {
  bundledHostCompatCatalog,
  getCatalogHost,
  getTemplateMcpAppsCapabilities,
  mcpAppsCapabilitiesSchema,
} from "@mcpjam/sdk/host-compat";
import { z } from "zod";
import { logger } from "./logger";

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
  const config = { ...parseConfig(base), ...parseConfig(override) };
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
  const host = config.hostStyle
    ? getCatalogHost(catalog, config.hostStyle)
    : undefined;
  if (config.hostStyle && !host) {
    // No preset applies, like the client; say so, or a typo or a style newer
    // than the bundled catalog looks like a deliberate profile.
    logger.warn(`Unknown host style "${config.hostStyle}"; no preset applied`, {
      hostStyle: config.hostStyle,
    });
  }
  const preset = config.hostStyle
    ? getTemplateMcpAppsCapabilities(catalog, config.hostStyle)
    : undefined;
  const matrix = { ...preset, ...overrides };
  const details = host?.hostCapabilitiesOverride;
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

function parseConfig(input: unknown): z.infer<typeof configSchema> {
  const result = configSchema.safeParse(input ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new InvalidClientProfileError(`Invalid client profile at ${issues}`);
}

/** A saved profile the resolver cannot read; fails its eval case up front. */
export class InvalidClientProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClientProfileError";
  }
}
