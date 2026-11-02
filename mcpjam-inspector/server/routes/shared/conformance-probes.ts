import type { MCPConformanceConfig } from "@mcpjam/sdk";
import { z } from "zod";

/**
 * A tool an operator names as safe for the protocol suite to call. Three
 * 2026-07-28 checks can only observe something on a tool call: one that
 * emits logs (`logProbe`, for the two logging checks) and one that asks for
 * input (`inputRequiredProbe`). The SDK never picks a tool on its own, so
 * without these those checks report could-not-run. Both routes accept the
 * same shape.
 */
const conformanceProbeSchema = z
  .object({
    toolName: z.string().trim().min(1).max(256),
    arguments: z
      .record(z.string(), z.unknown())
      .optional()
      .refine(
        (value) =>
          value === undefined || JSON.stringify(value).length <= 10_000,
        "Probe arguments must serialize to at most 10,000 characters",
      ),
  })
  .strict();

export const conformanceProbeFields = {
  logProbe: conformanceProbeSchema.optional(),
  inputRequiredProbe: conformanceProbeSchema.optional(),
};

export type ConformanceProbes = Pick<
  MCPConformanceConfig,
  "logProbe" | "inputRequiredProbe"
>;
