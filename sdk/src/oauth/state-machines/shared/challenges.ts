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
 * `Basic realm="x", Bearer error="insufficient_scope", scope="a b"`. Both the
 * challenge list AND each challenge's auth-params are comma-separated, and a
 * quoted value may itself contain a comma — so a naive "slice from Bearer to
 * end" would fold a LATER scheme's params (or a fabricated one hidden in a
 * quote) into the Bearer parse. Tokenize quote-aware, group segments into
 * challenges (a segment that starts with `<scheme> <rest>` opens a new
 * challenge; a bare `key=value` segment continues the current one), and return
 * only the Bearer challenge's auth-params (last one wins), re-prefixed so the
 * delegated `Bearer …` parser reads exactly those.
 */
function selectBearerChallenge(header?: string): string | undefined {
  if (!header) {
    return undefined;
  }

  // Split on commas that are not inside a double-quoted string.
  const segments: string[] = [];
  let buffer = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      buffer += ch;
    } else if (ch === "," && !inQuotes) {
      segments.push(buffer);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  segments.push(buffer);

  // Group segments into challenges. A segment of the form `<scheme> <rest>`
  // (a bare auth-scheme token followed by whitespace) opens a new challenge;
  // an auth-param segment (`key=value`, no leading `<token> `) continues it.
  const challenges: Array<{ scheme: string; params: string[] }> = [];
  const CHALLENGE_START = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s+(.+)$/s;
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    const start = CHALLENGE_START.exec(seg);
    if (start) {
      challenges.push({ scheme: start[1].toLowerCase(), params: [start[2]] });
    } else if (challenges.length > 0) {
      challenges[challenges.length - 1].params.push(seg);
    }
  }

  // Last Bearer challenge wins (mirrors last-value-wins param parsing).
  const bearer = challenges.filter((c) => c.scheme === "bearer").pop();
  return bearer ? `Bearer ${bearer.params.join(", ")}` : undefined;
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
