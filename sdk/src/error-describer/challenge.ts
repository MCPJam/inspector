/**
 * The parsed, storable shape of a `WWW-Authenticate` challenge.
 *
 * WHY A SUMMARY AND NOT THE HEADER. The raw header is the one thing a 401
 * teaches us for free — it names the scheme, the OAuth error, the scopes and
 * the protected-resource metadata pointer — and it is also the one string
 * that must never be persisted as-is: the ingest redaction pass rewrites any
 * `Bearer …` run to `Bearer [REDACTED]` (the same rule that scrubs tokens),
 * so a stored header comes back with exactly its useful part missing. Every
 * consumer stores THIS shape instead: parsed fields, the pointer reduced to
 * its host, nothing that could be a credential.
 *
 * Browser-safe; the parser it rests on is already served on `/browser`.
 */

import { redactForTelemetry } from "../telemetry-redaction.js";
import { parseBearerChallenges } from "../oauth/state-machines/shared/challenges.js";

export type BearerChallengeSummary = {
  /**
   * `bearer` when any challenge in the header is a Bearer challenge, `other`
   * when the header names only non-Bearer schemes, `none` when there was no
   * `WWW-Authenticate` header at all. This does not determine whether
   * well-known metadata discovery is available.
   */
  scheme: "bearer" | "other" | "none";
  /** RFC 6750 `error` param of the selected Bearer challenge, e.g. `invalid_token`. */
  error?: string;
  /** Space-separated `scope` param of the selected Bearer challenge, split. */
  scopes?: string[];
  /**
   * Host of the RFC 9728 `resource_metadata` pointer, when the challenge
   * carried one. Host only: the full URL can carry a query string a server
   * controls, and this field is persisted.
   */
  resourceMetadataHost?: string;
  /**
   * Body format suggested by Content-Type. HTML may come from the server
   * itself or an intermediary; this field does not establish which.
   */
  bodyKind?: "html" | "json" | "text" | "empty";
};

/** Max characters kept from any single header-derived string. */
const MAX_FIELD_CHARS = 120;

function clip(value: string): string {
  value = String(redactForTelemetry(value));
  return value.length > MAX_FIELD_CHARS
    ? value.slice(0, MAX_FIELD_CHARS)
    : value;
}

/**
 * Reduce a `WWW-Authenticate` header to its storable summary.
 *
 * Never throws; a malformed header reads as `scheme: "other"` (something was
 * advertised, nothing Bearer) rather than as no header at all, because those
 * are different facts about the server.
 */
export function summarizeBearerChallenge(
  header: string | null | undefined,
  options?: { bodyKind?: BearerChallengeSummary["bodyKind"] }
): BearerChallengeSummary {
  const bodyKind = options?.bodyKind;
  if (header === null || header === undefined || header.trim() === "") {
    return { scheme: "none", ...(bodyKind ? { bodyKind } : {}) };
  }
  try {
    const challenges = parseBearerChallenges(header);
    if (challenges.length === 0) {
      return { scheme: "other", ...(bodyKind ? { bodyKind } : {}) };
    }
    // A realm-only challenge must not hide a later actionable challenge.
    const first =
      challenges.find((entry) => entry.error === "insufficient_scope") ??
      challenges.find((entry) => entry.error) ??
      challenges.find((entry) => entry.scope || entry.resource_metadata) ??
      challenges[0] ??
      {};
    const summary: BearerChallengeSummary = { scheme: "bearer" };
    if (typeof first.error === "string" && first.error.trim()) {
      summary.error = clip(first.error.trim().toLowerCase());
    }
    if (typeof first.scope === "string" && first.scope.trim()) {
      const scopes = Array.from(
        new Set(
          first.scope
            .split(/\s+/)
            .map((scope) => scope.trim())
            .filter(Boolean)
            .map(clip)
        )
      );
      if (scopes.length > 0) summary.scopes = scopes.slice(0, 20);
    }
    if (
      typeof first.resource_metadata === "string" &&
      first.resource_metadata.trim()
    ) {
      try {
        summary.resourceMetadataHost = clip(
          new URL(first.resource_metadata.trim()).host
        );
      } catch {
        // A pointer that is not a URL is not evidence of anything storable.
      }
    }
    if (bodyKind) summary.bodyKind = bodyKind;
    return summary;
  } catch {
    return { scheme: "other", ...(bodyKind ? { bodyKind } : {}) };
  }
}

/**
 * Classify a response body by its content type, for `bodyKind`. Cheap and
 * header-only on purpose: nobody should read a 403 body to find out it is a
 * login page.
 */
export function bodyKindFromContentType(
  contentType: string | null | undefined,
  contentLength?: number | null
): BearerChallengeSummary["bodyKind"] {
  if (contentLength === 0) return "empty";
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("html")) return "html";
  if (type.includes("json")) return "json";
  if (type.trim() === "") return undefined;
  return "text";
}
