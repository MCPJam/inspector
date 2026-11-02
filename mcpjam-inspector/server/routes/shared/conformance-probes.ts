import { MCP_LOG_LEVELS, type MCPConformanceConfig } from "@mcpjam/sdk";
import { z } from "zod";

/**
 * A tool an operator names as safe for the protocol suite to call. Two
 * 2026-07-28 checks can only observe something on a tool call: one that
 * emits logs (`logProbe`, for the logging check and the log level filtering
 * advice) and one that asks for input (`inputRequiredProbe`). The SDK never
 * picks a tool on its own, so without these those checks report
 * could-not-run. Both routes accept the same shape.
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

/** The log probe also names the level the log level filtering advice asks for. */
const conformanceLogProbeSchema = conformanceProbeSchema
  .extend({ level: z.enum(MCP_LOG_LEVELS).optional() })
  .strict();

export const conformanceProbeFields = {
  logProbe: conformanceLogProbeSchema.optional(),
  inputRequiredProbe: conformanceProbeSchema.optional(),
};

/**
 * Answers the Tasks suite sends with `tasks/update` when its task asks for
 * input, keyed by `inputRequests` key. Opt-in: what a task asks is
 * server-defined, so without them the update acknowledgement check is not
 * applicable. Both routes accept the same shape.
 */
export const conformanceInputResponsesSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .refine(
    (value) => value === undefined || JSON.stringify(value).length <= 10_000,
    "Input responses must serialize to at most 10,000 characters",
  );

export type ConformanceProbes = Pick<
  MCPConformanceConfig,
  "logProbe" | "inputRequiredProbe"
>;
