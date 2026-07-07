import { z } from "zod";

/**
 * Zod schema for the host-compat catalog document + the envelope the backend
 * endpoint (`GET /public/host-catalog`, proxied at `/api/v1/host-catalog`)
 * serves.
 *
 * Forward-compat policy (schema skew: old SDK, newer catalog):
 *  - Unknown object keys are stripped (Zod default) — the backend may add
 *    fields within `schemaVersion` 1 without breaking older SDKs.
 *  - Enum widening is absorbed rather than fatal: unknown display modes are
 *    filtered out; an unknown `provenance` falls back to `assumed` (weakest
 *    trust); an unknown `widgetDisplayModeRequests` reads as unset.
 *  - Anything else unparseable fails the WHOLE parse — callers fall back to
 *    the bundled catalog, never partially apply a fetched one.
 */

/**
 * The catalog document schema version this SDK understands. Additive backend
 * changes stay within this version (Zod strips unknown keys); a breaking
 * change bumps it, and an envelope carrying any other version fails the parse
 * below so the caller falls back to the bundled catalog rather than applying a
 * document it can't correctly interpret.
 */
export const SUPPORTED_CATALOG_SCHEMA_VERSION = 1;

const DISPLAY_MODES = ["inline", "fullscreen", "pip"] as const;

const availableDisplayModesSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((mode) =>
          (DISPLAY_MODES as readonly unknown[]).includes(mode)
        )
      : value,
  z.array(z.enum(DISPLAY_MODES)).optional()
);

export const mcpAppsCapabilitiesSchema = z.object({
  availableDisplayModes: availableDisplayModesSchema,
  toolInputPartial: z.boolean().optional(),
  toolCancelled: z.boolean().optional(),
  hostContextChanged: z.boolean().optional(),
  resourceTeardown: z.boolean().optional(),
  toolInfo: z.boolean().optional(),
  openLinks: z.boolean().optional(),
  serverTools: z.boolean().optional(),
  serverResources: z.boolean().optional(),
  logging: z.boolean().optional(),
  updateModelContext: z.boolean().optional(),
  message: z.boolean().optional(),
  sandboxPermissions: z.boolean().optional(),
  cspFrameDomains: z.boolean().optional(),
  cspBaseUriDomains: z.boolean().optional(),
  resourcePrefersBorder: z.boolean().optional(),
  downloadFile: z.boolean().optional(),
  requestTeardown: z.boolean().optional(),
  widgetDisplayModeRequests: z
    .enum(["accept", "user-initiated-only", "decline"])
    .optional()
    .catch(undefined),
});

const marketHostSchema = z.object({
  // Plain string by design — a new host on the backend must not require an
  // SDK release to parse.
  id: z.string().min(1),
  label: z.string().min(1),
  // Includes "observed" — a first-class CompatProvenance value (the strongest
  // trust level), not an unknown future one; leaving it out would silently
  // downgrade an observed host to the weakest "assumed" via `.catch`. `.catch`
  // still absorbs genuinely-unknown future provenances.
  provenance: z
    .enum(["observed", "probe", "vendor-doc", "assumed"])
    .catch("assumed"),
  rendersMcpApps: z.boolean(),
  supportedProtocolVersions: z.array(z.string()).optional(),
  verifiedAt: z.number().optional(),
});

export const hostCompatCatalogSchema = z.object({
  marketHosts: z.array(marketHostSchema),
  capabilitiesById: z.record(z.string(), mcpAppsCapabilitiesSchema),
  openAiCompatByStyle: z.record(z.string(), z.boolean()),
});

/** The wire envelope around a catalog document. `source` is annotated by the
 * serving proxy (`live` | `bundled`); absent when hitting Convex directly. */
export const hostCompatCatalogEnvelopeSchema = z.object({
  // Gate on the supported version — a future breaking schema (v2+) fails here
  // and triggers the bundled fallback instead of being misapplied.
  schemaVersion: z.literal(SUPPORTED_CATALOG_SCHEMA_VERSION),
  version: z.number(),
  contentHash: z.string(),
  publishedAt: z.number(),
  catalog: hostCompatCatalogSchema,
  source: z.string().optional(),
});

export type HostCompatCatalogEnvelope = z.infer<
  typeof hostCompatCatalogEnvelopeSchema
>;
