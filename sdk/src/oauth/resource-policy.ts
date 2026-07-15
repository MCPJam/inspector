// Single source of truth for the RFC 8707 `resource` indicator sent on OAuth
// authorization and token requests.
//
// Every surface (debug state machines, oauth-login, conformance runner,
// Quick OAuth in the inspector client, `auth()`) resolves the resource through
// `evaluateResourceIndicator` so precedence, validation, and canonicalization
// cannot drift between paths. The evaluator only *describes* the decision —
// enforcement is the caller's job and differs by surface: the debugger warns
// and continues (so users can observe real server behavior), while connect,
// login, and conformance surfaces reject non-`valid` decisions.
//
// Spec grounding for the status taxonomy: RFC 8707 permits abstract resource
// indicators in general, but RFC 9728 §2 narrows a Protected Resource
// Metadata `resource` to an https URL without a fragment. A URN in PRM is
// therefore *invalid metadata* (not a valid exotic identifier), and a
// well-formed URL on a different origin is *incompatible* — a compromised
// server must not be able to steer tokens to an audience it doesn't own.
//
// Deliberately NOT part of validity: the official MCP SDK's path-prefix rule
// (the advertised resource must be a path prefix of the server URL). Real
// servers violate it legitimately — e.g. Asana serves its MCP transport at
// /sse while PRM advertises /v2/mcp on the same host — so same-origin values
// that fail the prefix rule stay `valid` and connectable, with the strictness
// gap reported separately via `strictClientCompatible` so debug surfaces can
// warn that spec-strict clients may refuse.

export type ResourceIndicatorSource =
  | "prm"
  | "authorization"
  | "configured"
  | "server";

export type ResourceIndicatorStatus = "valid" | "incompatible" | "invalid";

export interface ResourceIndicatorDecision {
  /**
   * The value to send on the wire: the advertised candidate verbatim
   * (trimmed), or the canonicalized server URL for the `server` fallback.
   */
  value: string;
  source: ResourceIndicatorSource;
  status: ResourceIndicatorStatus;
  /**
   * Whether the value also passes the official MCP SDK's strict binding
   * (origin equality AND the advertised path is a prefix of the server URL's
   * path). Always false when `status` is not `valid`.
   */
  strictClientCompatible: boolean;
  /** Human-readable explanation when not fully valid/strict. */
  reason?: string;
}

export interface EvaluateResourceIndicatorInput {
  serverUrl: string;
  /** `resource` from the server's Protected Resource Metadata. */
  prmResource?: string;
  /** `?resource=` recovered from a previously built authorization URL (callback paths). */
  authorizationUrlResource?: string;
  /** Caller-configured override. */
  configuredResource?: string;
}

export function canonicalizeResourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";

    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

// The official MCP SDK's strict binding (`checkResourceAllowed`), replicated
// bit-for-bit: same origin, and the candidate's path must be a prefix of the
// server URL's path. The raw `pathname.length` guard is deliberate — it
// rejects a trailing-slash-longer candidate (`/mcp/` advertised for a `/mcp`
// server) that the slash-normalized `startsWith` alone would accept.
function passesStrictClientBinding(candidate: URL, server: URL): boolean {
  if (candidate.origin !== server.origin) {
    return false;
  }

  if (server.pathname.length < candidate.pathname.length) {
    return false;
  }

  const serverPath = server.pathname.endsWith("/")
    ? server.pathname
    : `${server.pathname}/`;
  const candidatePath = candidate.pathname.endsWith("/")
    ? candidate.pathname
    : `${candidate.pathname}/`;

  return serverPath.startsWith(candidatePath);
}

function evaluateCandidate(
  candidate: string,
  source: ResourceIndicatorSource,
  serverUrl: string
): ResourceIndicatorDecision {
  const invalid = (reason: string): ResourceIndicatorDecision => ({
    value: candidate,
    source,
    status: "invalid",
    strictClientCompatible: false,
    reason,
  });

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalid(`Resource indicator "${candidate}" is not a parseable URI.`);
  }

  if (parsed.hash) {
    return invalid(
      `Resource indicator "${candidate}" must not include a fragment (RFC 8707 §2).`
    );
  }

  // RFC 9728 §2 requires an https URL. `http` is deliberately let through to
  // the origin check below rather than rejected here: origin equality
  // includes the scheme, so an http candidate can only ever reach `valid`
  // against a server the client is ALREADY talking to over http (local
  // development) — against an https server it lands on `incompatible`.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return invalid(
      `Resource indicator "${candidate}" must be an https URL (RFC 9728 §2).`
    );
  }

  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    return invalid(`Server URL "${serverUrl}" is not a parseable URI.`);
  }

  if (parsed.origin !== server.origin) {
    return {
      value: candidate,
      source,
      status: "incompatible",
      strictClientCompatible: false,
      reason: `Resource indicator "${candidate}" is on a different origin than the server URL "${serverUrl}" — honoring it would let the server steer tokens to an audience it doesn't own.`,
    };
  }

  const strictClientCompatible = passesStrictClientBinding(parsed, server);

  return {
    // Echo the advertised value verbatim: the authorization server compares
    // the request's `resource` against what the RS advertised, so rewriting
    // it (even canonicalization like stripping a trailing slash) risks an
    // audience mismatch the client invented. Only the server-URL fallback,
    // which nobody advertised, is canonicalized.
    value: candidate,
    source,
    status: "valid",
    strictClientCompatible,
    ...(strictClientCompatible
      ? {}
      : {
          reason: `Resource indicator "${candidate}" is not a path prefix of the server URL "${serverUrl}"; clients that enforce the official MCP SDK's strict binding will refuse it.`,
        }),
  };
}

/**
 * Convenience for flow-state readers: prefer the decision persisted at PRM
 * discovery, re-evaluate when the flow was seeded past discovery, and fall
 * back to the raw PRM value only when no server URL is known at all.
 * With a `serverUrl` present the result is always a string.
 */
export function resolveResourceIndicatorValue(input: {
  serverUrl: string;
  prmResource?: string;
  resolved?: ResourceIndicatorDecision;
}): string;
export function resolveResourceIndicatorValue(input: {
  serverUrl?: string;
  prmResource?: string;
  resolved?: ResourceIndicatorDecision;
}): string | undefined;
export function resolveResourceIndicatorValue(input: {
  serverUrl?: string;
  prmResource?: string;
  resolved?: ResourceIndicatorDecision;
}): string | undefined {
  if (input.resolved) {
    return input.resolved.value;
  }
  // Only a truly ABSENT server URL short-circuits — an empty string is still
  // evaluated so the string overload's contract holds (the evaluator returns
  // an invalid string-valued decision for unparseable server URLs).
  if (input.serverUrl === undefined) {
    return input.prmResource;
  }
  return evaluateResourceIndicator({
    serverUrl: input.serverUrl,
    prmResource: input.prmResource,
  }).value;
}

/**
 * Resolve the resource indicator once. Precedence: PRM-advertised value, then
 * the value recovered from an authorization URL, then a configured override,
 * then the (canonicalized) server URL itself. The first present candidate
 * wins and is evaluated against the server URL; later candidates are never
 * considered as fallbacks for an invalid earlier one — a broken advertised
 * value is a finding, not something to silently paper over.
 */
export function evaluateResourceIndicator(
  input: EvaluateResourceIndicatorInput
): ResourceIndicatorDecision {
  const candidates: Array<[string | undefined, ResourceIndicatorSource]> = [
    [input.prmResource, "prm"],
    [input.authorizationUrlResource, "authorization"],
    [input.configuredResource, "configured"],
  ];

  for (const [candidate, source] of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return evaluateCandidate(trimmed, source, input.serverUrl);
    }
  }

  try {
    new URL(input.serverUrl);
  } catch {
    return {
      value: input.serverUrl,
      source: "server",
      status: "invalid",
      strictClientCompatible: false,
      reason: `Server URL "${input.serverUrl}" is not a parseable URI.`,
    };
  }

  return {
    value: canonicalizeResourceUrl(input.serverUrl),
    source: "server",
    status: "valid",
    strictClientCompatible: true,
  };
}
