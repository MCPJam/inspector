// Shared client-registration vocabulary — the single source of truth for how
// a client establishes its identity at an authorization server, used by both
// the OAuth flows and the XAA debugger (the Client↔Resource-AS registration
// leg). Ordered per MCP authorization guidance: pre-registered first, then
// CIMD (URL-based), with DCR as the fallback for clients that can't
// pre-register or use a metadata document.

export const REGISTRATION_STRATEGIES = [
  "preregistered",
  "cimd",
  "dcr",
] as const;

export type RegistrationStrategy = (typeof REGISTRATION_STRATEGIES)[number];

/**
 * A strategy the user may leave to the flow to resolve: "auto" picks
 * pre-registered credentials, CIMD, or DCR after the server is probed (see
 * `resolveAuthorizationPlan`). Persisted config stores a mode; running flows
 * resolve it to a concrete {@link RegistrationStrategy}.
 */
export type RegistrationMode = "auto" | RegistrationStrategy;

export const DEFAULT_REGISTRATION_STRATEGY: RegistrationStrategy =
  "preregistered";

export const DEFAULT_REGISTRATION_MODE: RegistrationMode = "auto";

/** Legacy spelling accepted on input, never emitted. */
const REGISTRATION_STRATEGY_ALIASES: Record<string, RegistrationStrategy> = {
  pre_registered: "preregistered",
};

/**
 * Narrow an arbitrary persisted/wire value (Convex returns a bare string) to a
 * known concrete strategy. Accepts the legacy `pre_registered` spelling as an
 * alias. Returns undefined for anything unrecognized — including "auto" — so
 * callers can fall back to the safe default rather than trusting the wire.
 */
export function normalizeRegistrationStrategy(
  value: unknown,
): RegistrationStrategy | undefined {
  if (typeof value !== "string") return undefined;
  if ((REGISTRATION_STRATEGIES as readonly string[]).includes(value)) {
    return value as RegistrationStrategy;
  }
  return REGISTRATION_STRATEGY_ALIASES[value];
}

/**
 * Like {@link normalizeRegistrationStrategy} but also admits "auto". Use for
 * persisted config; use the strategy normalizer where a concrete choice is
 * required (e.g. the XAA debugger's run setup).
 */
export function normalizeRegistrationMode(
  value: unknown,
): RegistrationMode | undefined {
  if (value === "auto") return "auto";
  return normalizeRegistrationStrategy(value);
}

/**
 * How a server authenticates at connect time. "auto" selects XAA when the
 * server is XAA-configured and OAuth otherwise — a selection made before the
 * flow starts, never a fallback after a failed attempt.
 */
export const AUTH_METHODS = [
  "auto",
  "oauth",
  "xaa",
  "bearer",
  "none",
] as const;

export type AuthMethod = (typeof AUTH_METHODS)[number];

export function normalizeAuthMethod(value: unknown): AuthMethod | undefined {
  return typeof value === "string" &&
    (AUTH_METHODS as readonly string[]).includes(value)
    ? (value as AuthMethod)
    : undefined;
}
