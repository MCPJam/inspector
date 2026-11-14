import type { ClaudeAuthEvidence } from "./auth.js";
import type { ClaudeCapabilityBadge } from "../types.js";
import { parseBearerAuthenticateParameters } from "../../oauth/state-machines/shared/challenges.js";

/** A missing scope is legal, but an empty fallback cannot name permissions. */
export function scopeFallbackWarning(
  evidence: ClaudeAuthEvidence
): ClaudeCapabilityBadge | undefined {
  const call = evidence.lazyAuthProbe?.protectedCall;
  const params = parseBearerAuthenticateParameters(
    evidence.unauthenticated?.wwwAuthenticate
  );
  const challenged =
    call?.outcome === "unauthorized" ||
    evidence.unauthenticated?.status === 401;
  const scope = call?.challenge?.requiredScope ?? params.scope;
  const scopes = evidence.prm?.document?.scopes_supported;
  if (
    !challenged ||
    scope?.trim() ||
    (Array.isArray(scopes) &&
      scopes.some((entry) => typeof entry === "string" && entry.trim()))
  )
    return undefined;
  return {
    id: "claude.auth.scope-fallback",
    title: "No permissions advertised",
    state: "not-evaluated",
    provenance: "wire",
    detail:
      "The sign-in challenge names no scope and the resource metadata advertises no scopes. Add the minimum required permissions to the challenge or metadata.",
  };
}
