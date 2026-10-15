import { z } from "zod";
import type { StoredOAuthConfig } from "./mcp-oauth";

// Browser storage keeps public settings only. The same schema validates reads
// and strips unknown fields at every write, including credential properties.
const publicConfigSchema = z.object({
  scopes: z.array(z.string()).optional().catch(undefined),
  hasCustomHeaders: z.literal(true).optional().catch(undefined),
  resourceUrl: z.string().trim().min(1).optional().catch(undefined),
  registryServerId: z.string().optional().catch(undefined),
  useRegistryOAuthProxy: z.boolean().optional().catch(undefined),
  protocolMode: z
    .enum(["auto", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"])
    .optional()
    .catch(undefined),
  protocolVersion: z
    .enum(["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"])
    .optional()
    .catch(undefined),
  registrationMode: z
    .enum(["auto", "cimd", "dcr", "preregistered"])
    .optional()
    .catch(undefined),
  registrationStrategy: z
    .enum(["cimd", "dcr", "preregistered"])
    .optional()
    .catch(undefined),
});

export function parseStoredOAuthConfig(value: unknown): StoredOAuthConfig {
  const parsed = publicConfigSchema
    .extend({
      customHeaders: z
        .record(z.string(), z.string())
        .optional()
        .catch(undefined),
    })
    .parse(value);
  return {
    ...parsed,
    useRegistryOAuthProxy: parsed.useRegistryOAuthProxy === true,
  };
}

export function serializeStoredOAuthConfig(config: StoredOAuthConfig): string {
  return JSON.stringify(publicConfigSchema.parse(config));
}
