/**
 * Zod schema for the optional `mcpProfile` payload field on internal
 * widget routes. Validates `profileVersion: 1` strictly and treats
 * everything else as pass-through (so future top-level fields don't
 * require a schema migration).
 *
 * Only `apps.sandbox.csp` is parsed in depth — the legacy CSP path is
 * the only consumer in this PR. `apps.sandbox.permissions`,
 * `initialize`, and `extensions` are accepted verbatim.
 */
import { z } from "zod";

const cspDomainSetSchema = z
  .object({
    connectDomains: z.array(z.string()).optional(),
    resourceDomains: z.array(z.string()).optional(),
    frameDomains: z.array(z.string()).optional(),
    baseUriDomains: z.array(z.string()).optional(),
  })
  .strict();

const sandboxCspSchema = z
  .object({
    mode: z.enum(["host-default", "declared", "relaxed"]).optional(),
    restrictTo: cspDomainSetSchema.optional(),
    deny: cspDomainSetSchema.optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const mcpProfileSchema = z
  .object({
    profileVersion: z.literal(1),
    initialize: z
      .object({
        supportedProtocolVersions: z.array(z.string()).optional(),
        clientInfo: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    apps: z
      .object({
        sandbox: z
          .object({
            csp: sandboxCspSchema.optional(),
            permissions: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type McpProfilePayload = z.infer<typeof mcpProfileSchema>;
