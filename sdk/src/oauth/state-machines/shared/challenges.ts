export function parseBearerAuthenticateParameters(
  header?: string,
): Record<string, string> {
  if (!header) {
    return {};
  }

  const match = header.trim().match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {};
  }

  const params: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g;

  for (let next = pattern.exec(match[1]); next; next = pattern.exec(match[1])) {
    params[next[1].toLowerCase()] = next[2] ?? next[3] ?? "";
  }

  return params;
}

export function parseScopeString(scopeValue?: string): string[] | undefined {
  if (!scopeValue) {
    return undefined;
  }

  const scopes = scopeValue
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  return scopes.length > 0 ? Array.from(new Set(scopes)) : undefined;
}

/**
 * SEP-2350 scope union. Returns the previously-requested scopes followed by any
 * newly-challenged scopes not already present — order-preserving (previous
 * first) and de-duplicated. This is the set a step-up re-authorization requests.
 */
export function computeScopeUnion(
  previous?: string[],
  challenged?: string[],
): string[] {
  const union: string[] = [];
  const seen = new Set<string>();
  for (const scope of [...(previous ?? []), ...(challenged ?? [])]) {
    const trimmed = scope?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    union.push(trimmed);
  }
  return union;
}

export interface InsufficientScopeChallenge {
  /** True only when the `WWW-Authenticate` header carries `error="insufficient_scope"`. */
  isInsufficientScope: boolean;
  /** Scopes named by the challenge's `scope` parameter, if any. */
  challengedScopes?: string[];
  /** RFC 9728 `resource_metadata` pointer, if the challenge carried one. */
  resourceMetadata?: string;
}

/**
 * Parse a `403` `WWW-Authenticate: Bearer …` header for an insufficient-scope
 * step-up challenge (RFC 6750 §3 / SEP-2350). Non-insufficient-scope challenges
 * (e.g. `invalid_token`) return `isInsufficientScope: false` so callers do not
 * mistake a plain 401 re-auth for a scope step-up.
 */
/**
 * A `WWW-Authenticate` header may list several challenges (RFC 7235 §4.1), e.g.
 * `Basic realm="x", Bearer error="insufficient_scope"`. The underlying parser
 * only reads a header that STARTS with `Bearer`, so isolate the Bearer
 * challenge first — from the last `Bearer ` token, whose auth-params run to the
 * end of the header — before delegating.
 */
function selectBearerChallenge(header?: string): string | undefined {
  if (!header) {
    return undefined;
  }
  if (/^\s*Bearer\s/i.test(header)) {
    return header;
  }
  const match = header.match(/(?:^|[,\s])(Bearer\s+.*)$/i);
  return match ? match[1] : undefined;
}

export function parseInsufficientScopeChallenge(
  header?: string,
): InsufficientScopeChallenge {
  const params = parseBearerAuthenticateParameters(
    selectBearerChallenge(header),
  );
  const isInsufficientScope = params.error === "insufficient_scope";
  return {
    isInsufficientScope,
    challengedScopes: parseScopeString(params.scope),
    resourceMetadata: params.resource_metadata || undefined,
  };
}

/** Where an insufficient-scope challenge is being handled — drives the policy split. */
export type StepUpAuthMode = "interactive" | "m2m" | "debugger";

/**
 * What to do with an insufficient-scope challenge:
 * - `reauthorize`: run a fresh authorization requesting the scope union;
 * - `throw`: surface an `InsufficientScopeError` (no browser);
 * - `manual`: let the user inspect and advance the step explicitly (debugger).
 */
export type StepUpAction = "reauthorize" | "throw" | "manual";

/**
 * §10.5 runtime step-up policy split with a bounded retry. `attempt` is the
 * number of step-up re-authorizations ALREADY performed for this persisted
 * client session (0 on the first challenge); once it reaches `maxRetries` the
 * interactive path stops re-authorizing and throws, preventing an infinite
 * cross-request loop (SDK per-request limits are not enough for a persisted
 * session). M2M never opens a browser; the debugger advances by hand.
 */
export function resolveStepUpAction(input: {
  authMode: StepUpAuthMode;
  attempt: number;
  maxRetries?: number;
}): StepUpAction {
  // Guard the exported boundary against a non-finite/negative bound (e.g.
  // Infinity), which would make `attempt < maxRetries` always true and defeat
  // the loop protection. A non-integer or negative value falls back to 1.
  const maxRetries =
    Number.isInteger(input.maxRetries) && (input.maxRetries as number) >= 0
      ? (input.maxRetries as number)
      : 1;
  switch (input.authMode) {
    case "m2m":
      return "throw";
    case "debugger":
      return "manual";
    case "interactive":
      return input.attempt < maxRetries ? "reauthorize" : "throw";
  }
}

export function resolveRequestedScopeValue(input: {
  customScopes?: string;
  challengedScopes?: string[];
  supportedScopes?: string[];
}): string | undefined {
  const customScopes = input.customScopes?.trim();
  if (customScopes) {
    return customScopes;
  }

  const challengedScopes = input.challengedScopes?.filter(Boolean) ?? [];
  if (challengedScopes.length > 0) {
    return Array.from(new Set(challengedScopes)).join(" ");
  }

  const supportedScopes = input.supportedScopes?.filter(Boolean) ?? [];
  if (supportedScopes.length === 0) {
    return undefined;
  }

  return Array.from(new Set(supportedScopes)).join(" ");
}
