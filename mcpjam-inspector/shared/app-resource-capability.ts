import { z } from "zod";
import { resolveBuiltInHostCapabilities } from "./host-style-capabilities";

const configSchema = z.object({
  hostStyle: z.string(),
  hostCapabilitiesOverride: z.record(z.string(), z.unknown()).optional(),
  mcpProfile: z
    .object({
      apps: z
        .object({
          mcpAppsOverrides: z
            .object({ serverResources: z.boolean().optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Use the same resource declaration as the renderer; malformed profiles fail closed. */
export function appResourcesEnabled(config: unknown): boolean {
  const parsed = configSchema.safeParse(config);
  return (
    parsed.success &&
    !!resolveBuiltInHostCapabilities({
      hostStyle: parsed.data.hostStyle,
      profile: parsed.data.mcpProfile,
      hostCapabilitiesOverride: parsed.data.hostCapabilitiesOverride,
    }).serverResources
  );
}
