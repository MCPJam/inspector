import { mcpAppsCapabilitiesSchema } from "@mcpjam/sdk/host-compat";
import {
  findBuiltInStyleCapabilities,
  resolveBuiltInHostCapabilities,
} from "@/shared/host-style-capabilities";
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

/** Resolve saved profile switches the way chat does, for the browser harness. */
export function resolveBrowserHostCapabilities(
  base?: unknown,
  override?: unknown,
): Record<string, unknown> | undefined {
  const config = { ...parseConfig(base), ...parseConfig(override) };
  // Legacy callers with no saved profile retain the harness's existing defaults.
  if (
    !config.hostStyle &&
    config.mcpProfile?.apps?.mcpAppsOverrides === undefined &&
    config.hostCapabilitiesOverride === undefined
  ) {
    return undefined;
  }
  if (config.hostStyle && !findBuiltInStyleCapabilities(config.hostStyle)) {
    // No preset applies, like the client; say so, or a typo or a style newer
    // than this build looks like a deliberate profile.
    logger.warn(`Unknown host style "${config.hostStyle}"; no preset applied`, {
      hostStyle: config.hostStyle,
    });
  }
  return resolveBuiltInHostCapabilities({
    hostStyle: config.hostStyle,
    profile: config.mcpProfile,
    hostCapabilitiesOverride: config.hostCapabilitiesOverride,
  });
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
