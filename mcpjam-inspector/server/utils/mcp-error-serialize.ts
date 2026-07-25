import { describeError } from "@mcpjam/sdk";

/** The `WWW-Authenticate` step-up challenge fields surfaced to the client. */
export type InsufficientScopeChallenge = {
  requiredScope?: string;
  resourceMetadataUrl?: string;
  errorDescription?: string;
};

/**
 * Recognize an upstream `InsufficientScopeError` (SEP-2350) anywhere in the
 * error / cause chain and return its `WWW-Authenticate` challenge fields.
 *
 * A runtime `403 insufficient_scope` from a live MCP request surfaces here as
 * this transport-layer error (the SDK constructs the transport with
 * `onInsufficientScope: "throw"`, so it never attempts a doomed server-side
 * interactive re-authorization). Detection is strictly by
 * `constructor.mcpBrand` / `.name` — an actual `InsufficientScopeError`, never
 * a duck-typed `requiredScope` field (an unrelated error carrying that field
 * must not masquerade as a step-up challenge). The class does not extend
 * `OAuthError`, and its fields (`requiredScope`, `resourceMetadataUrl`)
 * originate from the resource server's header, so treat them as untrusted when
 * rendering. Returning the challenge lets the client drive the union-scope
 * step-up re-authorization.
 */
export function extractInsufficientScopeChallenge(
  error: unknown,
): InsufficientScopeChallenge | undefined {
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    // Recognize ONLY an actual `InsufficientScopeError` — by its class brand
    // (`mcpBrand`, survives minification/cross-realm) or `.name`. Do NOT
    // duck-type on a `requiredScope` string: an unrelated error that happens
    // to carry a `requiredScope` field must not be serialized to the client as
    // an OAuth step-up challenge (it would trigger a spurious re-authorization).
    const isInsufficientScope =
      current.constructor?.mcpBrand === "mcp.InsufficientScopeError" ||
      current.name === "InsufficientScopeError";
    if (isInsufficientScope) {
      const requiredScope =
        typeof current.requiredScope === "string"
          ? current.requiredScope
          : undefined;
      const resourceMetadataUrl =
        typeof current.resourceMetadataUrl === "string"
          ? current.resourceMetadataUrl
          : undefined;
      const errorDescription =
        typeof current.errorDescription === "string"
          ? current.errorDescription
          : undefined;
      // Only surface when at least one challenge field is present — a bare
      // name match with no fields carries nothing actionable.
      if (requiredScope || resourceMetadataUrl || errorDescription) {
        return { requiredScope, resourceMetadataUrl, errorDescription };
      }
    }
    current = current.cause;
  }
  return undefined;
}

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
  return c.json(
    { error: details.message as string, mcpError: details, normalized },
    status,
  );
}
