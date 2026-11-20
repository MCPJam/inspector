/**
 * Server variants on the Inspector server: the definition authorize-batch
 * sends with a variant's id, checked before a connection serves it, the
 * drift an eval run is refused for, and the variants a run recorded.
 *
 * Fail closed: an entry whose variant can't be read is refused, so a
 * variant's id never reaches its base without the edits.
 */
import {
  VARIANT_BASE_DRIFTED_RPC_CODE, VARIANT_LIMITS, VariantError, variantErrorMessages,
  type VariantDefinition,
} from "@mcpjam/sdk/variants";
import { z } from "zod";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const edit = z.object({
  feature: z.literal("tools.description"),
  target: z.string().min(1),
  op: z.literal("set"),
  value: z.string().min(1),
});

/** `VariantDefinition`, as authorize-batch and the backend's create send it. */
export const variantDefinitionSchema = z.object({
  variantId: z.string().min(1),
  serverId: z.string().min(1),
  baseServerId: z.string().min(1),
  edits: z.array(edit).min(1).max(VARIANT_LIMITS.maxEdits),
  editsHash: sha256,
  baseSurfaceHash: sha256,
  toolHashes: z.array(z.object({ tool: z.string().min(1), hash: sha256 })),
  contentHash: sha256,
});

/** A refused variant as a v1 error: a 400 that keeps the contract's code and message. */
export function variantRouteError(error: VariantError): WebRouteError {
  return new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message, { code: error.code });
}

/** The contract's refusal of a base that isn't an HTTP server, or is a variant. */
export function unsupportedVariantBase(): WebRouteError {
  const message = variantErrorMessages.VARIANT_UNSUPPORTED_SERVER();
  return variantRouteError(new VariantError("VARIANT_UNSUPPORTED_SERVER", message));
}

/**
 * The variant an authorize-batch entry serves, or `undefined` for an ordinary
 * server. Throws for one this process can't serve as the contract defines it.
 */
export function authorizedVariant(
  entry: { variant?: unknown; serverConfig: { transportType?: string } },
  serverId: string,
  serverName: string,
): VariantDefinition | undefined {
  if (entry.variant === undefined || entry.variant === null) return undefined;
  const parsed = variantDefinitionSchema.safeParse(entry.variant);
  if (!parsed.success || parsed.data.serverId !== serverId) {
    throw new WebRouteError(500, ErrorCode.INTERNAL_ERROR,
      `The variant server "${serverName}" couldn't be read, so it wasn't connected. Try again, and create the variant again if it keeps failing.`,
      { serverId });
  }
  // Only an HTTP connection dials through the fetch that applies the edits.
  if (entry.serverConfig.transportType !== "http") throw unsupportedVariantBase();
  return parsed.data;
}

const managerVariants = new WeakMap<object, ReadonlyMap<string, VariantDefinition>>();

/** Records which of a manager's servers are variants. */
export function setManagerVariants(manager: object, variants: ReadonlyMap<string, VariantDefinition>) {
  if (variants.size > 0) managerVariants.set(manager, variants);
}

/** The variant a manager serves under `serverId`, if it is one. */
export function managerVariant(manager: object, serverId: string) {
  return managerVariants.get(manager)?.get(serverId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The drift a served variant answered `tools/list` with, found in `error` or
 * its causes: the edited tools that changed or disappeared on the base.
 */
export function variantDriftOf(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    const data = current.data;
    if (current.code === VARIANT_BASE_DRIFTED_RPC_CODE && isRecord(data) &&
        data.code === "VARIANT_BASE_DRIFTED") {
      const tools = Array.isArray(data.tools)
        ? data.tools.filter((tool): tool is string => typeof tool === "string")
        : [];
      const variantId = typeof data.variantId === "string" ? data.variantId : "";
      return { tools, variantId, message: variantErrorMessages.VARIANT_BASE_DRIFTED(tools) };
    }
    current = current.cause;
  }
  return undefined;
}

const runVariants = z.array(z.object({
  serverId: z.string(),
  variantId: z.string(),
  baseServerId: z.string(),
  baseSurfaceHash: z.string(),
  editsHash: z.string(),
  contentHash: z.string(),
})).min(1);

/** A run's `configSnapshot.variants`, field by field; omitted when it served none. */
export function runVariantsProjection(raw: unknown) {
  const parsed = runVariants.safeParse(raw);
  return parsed.success ? { variants: parsed.data } : {};
}
