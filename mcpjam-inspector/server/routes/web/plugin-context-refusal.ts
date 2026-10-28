import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  pluginContextRefusalDiagnostic,
  type PluginContextExcess,
  type PluginDiagnostic,
} from "../../../shared/plugin-diagnostics.js";
import { PluginModelContextError } from "../../../shared/plugin-model-context.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";
import { getRequestLogger } from "../../utils/request-logger.js";

/**
 * App context refusals that leave the App's accepted context exactly as it
 * was: a size, rate or memory budget refused the update before anything was
 * stored. The client treats these as known rejections, so the App can send
 * a smaller update at once.
 */
const REFUSAL_STATUS: Readonly<Record<string, ContentfulStatusCode>> = {
  PLUGIN_CONTEXT_TOO_LARGE: 413,
  PLUGIN_CONTEXT_TURN_TOO_LARGE: 413,
  INSTANCE_CONTEXT_TOO_LARGE: 413,
  // The control store's refusal of an oversized write.
  INVALID_INSTANCE_CONTEXT: 413,
  INSTANCE_CONTEXT_RATE_LIMITED: 429,
  PLUGIN_CONTEXT_MEMORY_LIMIT: 503,
};

type Refusal = {
  code: string;
  status: ContentfulStatusCode;
  diagnostics: PluginDiagnostic[];
  excess?: PluginContextExcess;
};

function contextRefusal(error: unknown): Refusal | undefined {
  if (error instanceof PluginModelContextError) {
    const code = error.message;
    if (!code.startsWith("PLUGIN_CONTEXT_")) return undefined;
    return {
      code,
      // Content the client should never have sent, rather than a budget.
      status: REFUSAL_STATUS[code] ?? 400,
      diagnostics: [pluginContextRefusalDiagnostic(code, error.excess)],
      ...(error.excess ? { excess: error.excess } : {}),
    };
  }
  if (
    error instanceof PluginInvocationError &&
    !error.outcomeUnknown &&
    Object.hasOwn(REFUSAL_STATUS, error.code)
  )
    return {
      code: error.code,
      status: REFUSAL_STATUS[error.code],
      diagnostics: error.diagnostics?.length
        ? error.diagnostics
        : [pluginContextRefusalDiagnostic(error.code)],
    };
  return undefined;
}

/**
 * The response for an App context refusal, keeping its specific code and the
 * budget it crossed for the Logs panel, or undefined for any other error.
 */
export function pluginContextRefusalResponse(
  c: Context,
  error: unknown,
  failure: (code: string, extra: Record<string, unknown>) => unknown,
): Response | undefined {
  const refusal = contextRefusal(error);
  if (!refusal) return undefined;
  if (c.var?.requestLogContext)
    getRequestLogger(c, "routes.web.plugin-instances").event(
      "plugin.instance.context.refused",
      {
        code: refusal.code,
        statusCode: refusal.status,
        ...(refusal.excess ?? {}),
      },
    );
  return c.json(
    failure(refusal.code, { diagnostics: refusal.diagnostics }),
    refusal.status,
  );
}
