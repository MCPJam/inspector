/**
 * `token` = `1*tchar` (RFC 7230 §3.2.6). Both `auth-scheme` and `auth-param`
 * names are this same production (RFC 7235 §2.1), so they share one definition:
 * a name may open with a digit or punctuation. Spelling the two differently let
 * the tokenizer accept a parameter like `2fa="…"` as part of a Bearer challenge
 * while the name pattern silently dropped the pair.
 */
const TOKEN = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";

/**
 * Parse one challenge's auth-param list (`key=value, key="value"`).
 *
 * `auth-param` allows BWS around the `=` (RFC 7235 §2.1), and a quoted value may
 * contain quoted-pairs, so `realm = "say \"hi\""` has to read as one parameter
 * whose value is `say "hi"`.
 */
function parseAuthParams(paramsString: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pattern = new RegExp(
    `(${TOKEN})\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|([^,\\s]+))`,
    "g",
  );

  for (
    let next = pattern.exec(paramsString);
    next;
    next = pattern.exec(paramsString)
  ) {
    const quoted = next[2];
    params[next[1].toLowerCase()] =
      quoted !== undefined
        ? quoted.replace(/\\([\s\S])/g, "$1")
        : next[3] ?? "";
  }

  return params;
}

/**
 * Auth-params of the first `Bearer` challenge in a `WWW-Authenticate` header.
 *
 * Reads the challenge list instead of anchoring on `Bearer` at the start of the
 * header. A server may advertise another scheme first — `Basic realm="x",
 * Bearer resource_metadata="…"` — and anchoring returned nothing at all for
 * those, so a challenge the 403 gate had accepted arrived at discovery stripped
 * of its `resource_metadata` and `scope`, silently falling back to a PRM URL
 * derived from the server URL.
 */
export function parseBearerAuthenticateParameters(
  header?: string,
): Record<string, string> {
  return parseBearerChallenges(header)[0] ?? {};
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
 * the parsed auth-params of EVERY Bearer challenge — the caller selects the
 * applicable one (an `insufficient_scope` challenge must not be hidden by a
 * later realm-only Bearer under last-challenge-wins).
 */
function parseBearerChallenges(header?: string): Array<Record<string, string>> {
  if (!header) {
    return [];
  }

  // Split on commas that are not inside a double-quoted string. A quoted-pair
  // (RFC 7230 §3.2.6) has to be consumed whole: treating the `"` of a `\"` as a
  // delimiter ends the string early, so the rest of one scheme's realm parses as
  // further challenges — enough for `Basic realm="a\", Bearer error=\"…\""` to
  // advertise a Bearer challenge the server never sent, and this tokenizer gates
  // whether a 403 is accepted.
  const segments: string[] = [];
  let buffer = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (inQuotes && ch === "\\" && i + 1 < header.length) {
      buffer += ch + header[i + 1];
      i++;
    } else if (ch === '"') {
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
  // (a bare auth-scheme token followed by whitespace) opens a new challenge, as
  // does a segment that is nothing but a scheme token — `Bearer` with no
  // auth-params is a valid challenge (RFC 7235 §4.1) and is what servers behind
  // a WAF commonly send. An auth-param segment (`key=value`, no leading
  // `<token> `) continues the current challenge.
  const challenges: Array<{ scheme: string; params: string[] }> = [];
  // `auth-scheme` is a bare `token`, so every position accepts the same set and a
  // scheme may open with a digit or punctuation. Requiring a leading letter made
  // a segment like `1Other error="…"` fall through to the auth-param branch,
  // which credited a following scheme's parameters to the challenge before it.
  //
  // `<token> <rest>` opens a challenge, but `auth-param` permits BWS around its
  // `=` (RFC 7235 §2.1), so `resource_metadata = "…"` is a parameter that looks
  // exactly like a scheme followed by a value. Refusing the match when `=` is
  // what follows the token keeps such a parameter attached to its challenge
  // instead of opening one named after it — which dropped the very
  // `resource_metadata` and `scope` this step reads.
  const CHALLENGE_START = new RegExp(`^(${TOKEN})\\s+(?!\\s*=)(.+)$`, "s");
  const BARE_SCHEME = new RegExp(`^(${TOKEN})$`);
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    const start = CHALLENGE_START.exec(seg);
    const bare = start ? null : BARE_SCHEME.exec(seg);
    if (start) {
      challenges.push({ scheme: start[1].toLowerCase(), params: [start[2]] });
    } else if (bare) {
      challenges.push({ scheme: bare[1].toLowerCase(), params: [] });
    } else if (challenges.length > 0) {
      challenges[challenges.length - 1].params.push(seg);
    }
  }

  return challenges
    .filter((c) => c.scheme === "bearer")
    .map((c) => parseAuthParams(c.params.join(", ")));
}

/** True when the header advertises a Bearer challenge, with or without auth-params. */
export function hasBearerChallenge(header?: string): boolean {
  return parseBearerChallenges(header).length > 0;
}

/**
 * Thrown when the server under test answers the unauthenticated `initialize`
 * probe with a status the flow cannot continue from. Distinct from a transport
 * failure: the request reached the server and it replied, so callers must not
 * relabel it as "failed to request".
 */
export class UnexpectedProbeStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "UnexpectedProbeStatusError";
    this.status = status;
  }
}

/**
 * What the unauthenticated `initialize` probe's status means for the flow:
 * - `challenged`: treat as an auth challenge and continue discovery.
 *   `specCompliant` is false when the challenge arrived on a status MCP does not
 *   allow here, which the debugger proceeds through but must report.
 * - `anonymous_allowed`: the server served the request without a token.
 * - `unexpected`: the flow cannot continue; `message` says why.
 */
export type UnauthenticatedProbeOutcome =
  | { kind: "challenged"; specCompliant: boolean }
  | { kind: "anonymous_allowed" }
  | { kind: "unexpected"; message: string };

/**
 * Classify the unauthenticated probe. MCP requires 401 + `WWW-Authenticate`
 * here, but servers fronted by a CDN/WAF, and those treating anonymous access as
 * a scope failure (RFC 6750 §3.1 pairs 403 with `insufficient_scope`), answer
 * 403 instead. A 403 that still carries a Bearer challenge supplies everything
 * discovery needs, so the debugger continues and flags the violation rather than
 * dead-ending; a bare 403 carries nothing to continue from and almost always
 * means the request never reached the MCP server at all.
 */
export function classifyUnauthenticatedProbe(input: {
  status: number;
  statusText?: string;
  wwwAuthenticateHeader?: string;
  serverMessage?: string;
}): UnauthenticatedProbeOutcome {
  if (input.status === 401) {
    return { kind: "challenged", specCompliant: true };
  }
  if (input.status === 200) {
    return { kind: "anonymous_allowed" };
  }
  if (input.status === 403 && hasBearerChallenge(input.wwwAuthenticateHeader)) {
    return { kind: "challenged", specCompliant: false };
  }

  const reason = input.serverMessage || input.statusText;
  const observed = `HTTP ${input.status}${reason ? ` ${reason}` : ""}`;
  if (input.status === 403) {
    // Naming the absent header is only accurate when none arrived. A 403 that
    // does carry a challenge, for a scheme OAuth cannot use, would otherwise
    // send the user hunting for a header that is sitting in the response.
    if (input.wwwAuthenticateHeader?.trim()) {
      return {
        kind: "unexpected",
        message:
          `MCP server returned ${observed}, and its WWW-Authenticate header ` +
          "offers no Bearer challenge. MCP OAuth has nothing to discover from " +
          "without one, so the flow cannot continue against this server.",
      };
    }
    return {
      kind: "unexpected",
      message:
        `MCP server returned ${observed} with no WWW-Authenticate challenge. ` +
        "MCP requires 401 with a WWW-Authenticate header to begin OAuth, so " +
        "there is nothing to discover from. A bare 403 usually means a proxy, " +
        "WAF, or IP allowlist rejected the request before the MCP server saw it.",
    };
  }
  return {
    kind: "unexpected",
    message:
      `MCP server returned ${observed} where MCP requires 401 Unauthorized ` +
      "(or 200, if the server allows anonymous access).",
  };
}

/** The flow step that sends the unauthenticated `initialize` probe. */
export const UNAUTHENTICATED_PROBE_STEP = "request_without_token";

/**
 * True when a recorded exchange is the unauthenticated probe being answered
 * with an auth challenge — the outcome the debugger expects, so surfaces must
 * not paint it as a failure. Reads the same classification the step itself
 * gates on, so a 403 the flow continued from cannot render as an error beside
 * the warning explaining it.
 */
export function isUnauthenticatedProbeChallenge(input: {
  step?: string;
  status?: number;
  statusText?: string;
  wwwAuthenticateHeader?: string;
}): boolean {
  if (input.step !== UNAUTHENTICATED_PROBE_STEP || input.status === undefined) {
    return false;
  }

  return (
    classifyUnauthenticatedProbe({
      status: input.status,
      statusText: input.statusText,
      wwwAuthenticateHeader: input.wwwAuthenticateHeader,
    }).kind === "challenged"
  );
}

export function parseInsufficientScopeChallenge(
  header?: string,
): InsufficientScopeChallenge {
  const bearerChallenges = parseBearerChallenges(header);
  // Select the insufficient_scope challenge among ALL Bearer challenges — a
  // later realm-only Bearer must not hide an earlier insufficient_scope one.
  const params =
    bearerChallenges.find((p) => p.error === "insufficient_scope") ??
    bearerChallenges[0] ??
    {};
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
