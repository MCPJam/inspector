/**
 * Widget-probe ("synthetic monitor") test case configuration.
 *
 * A `widget_probe` case skips the LLM entirely: the runner executes the
 * pinned tool call below, renders the result in the MCP App browser harness,
 * and the widget render predicates (`widgetRendered` / `widgetRenderLatencyUnder`
 * / `widgetNoConsoleErrors`) decide pass/fail. Zero tokens, deterministic input.
 *
 * Mirrored by the Convex validator in mcpjam-backend
 * `convex/lib/probeConfig.ts` (same hand-mirroring arrangement as the
 * predicate validators) — edit both in the same PR.
 */

import { z } from "zod";

export const TEST_CASE_TYPES = ["prompt", "widget_probe"] as const;
export type TestCaseType = (typeof TEST_CASE_TYPES)[number];

/** Probe render budget ceiling — matches the backend validator's cap. */
export const MAX_PROBE_RENDER_TIMEOUT_MS = 120_000;

/**
 * Max serialized size (chars) of a probe's pinned arguments — matches the
 * backend validator's `MAX_PROBE_ARGS_CHARS`. Arguments are stored verbatim and
 * snapshotted into every iteration, so an unbounded blob would bloat rows.
 */
export const MAX_PROBE_ARGS_CHARS = 100_000;

/**
 * Placeholder toolName stamped by "New case → Widget probe" (the backend
 * requires a non-empty toolName at rest, but no tool inventory is loaded at
 * create time). Deliberately not a plausible tool identifier so a real tool
 * can never collide with it; the probe editor treats exactly this literal
 * as "unset".
 */
export const PROBE_TOOL_NAME_PLACEHOLDER = "__pick_a_tool__";

/**
 * The pinned tool call a widget probe executes.
 *
 * `serverId` is the stable project-server reference (resolved against the
 * run environment's `serverBindings` at execution time); `serverName` is the
 * display name kept alongside so older environments without bindings still
 * resolve by name. Id wins when both are present — names are fragile across
 * renames/duplicates.
 */
export const probeConfigSchema = z.object({
  serverId: z.string().min(1).optional(),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= MAX_PROBE_ARGS_CHARS, {
      message: `arguments must be ≤ ${MAX_PROBE_ARGS_CHARS} characters when serialized`,
    }),
  /** Per-probe render budget override in ms; harness default applies when absent. */
  renderTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_PROBE_RENDER_TIMEOUT_MS)
    .optional(),
});

export type ProbeConfig = z.infer<typeof probeConfigSchema>;
