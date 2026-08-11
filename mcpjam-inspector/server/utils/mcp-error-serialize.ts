// SEP-2350 recognition lives in the SDK. This module used to carry a
// hand-maintained copy of the same walker, and the two drifted: only one of
// them knew `resourceMetadataUrl` arrives as a `URL` object. Re-exported
// rather than merely imported so the existing server-side importers
// (`insufficient-scope-step-up.ts`, `routes/web/errors.ts`) keep their path.
import {
  describeError,
  extractInsufficientScopeChallenge,
  originOf,
} from "@mcpjam/sdk";
export {
  extractInsufficientScopeChallenge,
} from "@mcpjam/sdk";
export type { InsufficientScopeChallenge } from "@mcpjam/sdk";
import { maybeCaptureOriginError } from "./error-origin-capture.js";

export function serializeMcpError(error: unknown) {
  const anyErr = error as any;
  const base = {
    name: anyErr?.name ?? "Error",
    message: anyErr?.message ?? String(error),
    code: anyErr?.code ?? anyErr?.error?.code,
    data: anyErr?.data ?? anyErr?.error?.data,
  } as Record<string, unknown>;
  const cause = anyErr?.cause;
  if (cause && typeof cause === "object") {
    base.cause = {
      name: (cause as any)?.name,
      message: (cause as any)?.message,
      code: (cause as any)?.code,
      data: (cause as any)?.data,
    };
  }
  const insufficientScope = extractInsufficientScopeChallenge(error);
  if (insufficientScope) {
    base.insufficientScope = insufficientScope;
  }
  if (process.env.NODE_ENV === "development" && anyErr?.stack) {
    base.stack = anyErr.stack;
  }
  return base;
}

export function jsonError(c: any, error: unknown, fallbackStatus = 500) {
  const details = serializeMcpError(error);
  const explicitStatus =
    typeof (error as any)?.status === "number"
      ? (error as any).status
      : undefined;
  // SEP-2350: an `InsufficientScopeError` from `onInsufficientScope: "throw"`
  // carries no numeric `status`, so without this the challenge would serialize
  // with the generic 500 fallback. A scope step-up challenge MUST come back as
  // HTTP 403 so the client recognizes it and drives the bounded re-auth. Honor
  // an explicit numeric status if the error already carried one.
  const status =
    explicitStatus ?? (details.insufficientScope ? 403 : fallbackStatus);
  const normalized = describeError(error);
  // The `/api/mcp/*` envelope's capture point. Most of what lands here is a
  // user's own MCP server misbehaving, which is exactly why the routes' bare
  // `logger.error` calls have been paging us: this decides once, records the
  // verdict on the error, and only escalates MCPJam-fault failures.
  const { origin } = maybeCaptureOriginError(error, normalized, {
    source: "mcp.jsonError",
    extra: { status },
  });
  if (typeof c?.set === "function") {
    c.set("webErrorMeta", {
      status,
      code: String(details.code ?? "mcp_error"),
      message: String(details.message ?? ""),
      origin,
      slug: normalized.slug,
    });
  }
  return c.json(
    // `success: false` preserves the pre-existing route error contract (the
    // `/resources/read`, `/prompts/get`, and tool routes all returned it before
    // switching to this shared serializer) so existing consumers/tests that read
    // the flag keep working; `mcpError.insufficientScope` still carries the
    // SEP-2350 step-up challenge.
    {
      success: false,
      error: details.message as string,
      mcpError: details,
      normalized,
      origin: originOf(normalized),
    },
    status,
  );
}
