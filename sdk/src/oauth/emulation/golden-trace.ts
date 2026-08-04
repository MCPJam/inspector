/**
 * Golden-trace normalization and comparison (HP-43 step 6).
 *
 * A run and a real-client capture can only be compared after the values that
 * differ on EVERY execution are neutralized: timestamps, CSRF state, PKCE,
 * authorization codes, tokens, server-generated client ids, and the loopback
 * callback port. What survives normalization is the shape of the dance — which
 * requests, in which order, carrying which parameters and headers — which is
 * exactly what "does this client behave like the real one" asks.
 *
 * Two rules keep the result honest:
 *
 *  - Normalization replaces volatile VALUES but never removes KEYS. A client
 *    that stopped sending `code_challenge` altogether must show up as a
 *    difference, not vanish into the placeholder.
 *  - A comparison carries qualifiers, and a `matched` with any qualifier is
 *    not an unqualified match. Partial coverage, a stale capture, or a
 *    client-version mismatch each keep the claim honest without pretending the
 *    diff itself failed.
 *
 * Real-client captures live in the private backend, like the profiles. This
 * module is the engine only and names no client.
 */

import { canonicalizeOAuthProfile } from "../../host-config/canonicalize.js";
import { sha256Hex } from "../../host-config/hash.js";
import type { HostConfigOAuthProfile } from "../../host-config/types.js";
import type {
  HttpHistoryEntry,
  OAuthFlowStep,
} from "../state-machines/types.js";
import type { OAuthEmulationDivergence } from "./types.js";

/** Replaces any value that legitimately differs on every run. */
export const NORMALIZED_VALUE = "<normalized>";

/** A capture older than this is reported as stale, never as current. */
export const GOLDEN_STALENESS_DAYS = 90;

/**
 * Parameters whose VALUE is per-run noise. The key is always preserved, so
 * dropping a parameter entirely remains a visible difference.
 */
const VOLATILE_PARAMETERS = new Set([
  "state",
  "code",
  "code_verifier",
  "code_challenge",
  "client_id",
  "client_secret",
  "access_token",
  "refresh_token",
  "nonce",
]);

/** Header values that are per-run noise. Knob-bearing headers are compared. */
const VOLATILE_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);

/** Derived from the body, so it tracks normalization rather than the wire. */
const DROPPED_HEADERS = new Set(["content-length", "date"]);

export type NormalizedTraceStepKind = OAuthFlowStep | "authorization_redirect";

export interface NormalizedTraceStep {
  step: NormalizedTraceStepKind;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface OAuthGoldenTrace {
  /**
   * Digest of the profile this capture belongs to. A golden may only be
   * compared against a run of the same profile — otherwise the diff measures
   * two different clients.
   */
  profileDigest: string;
  /** The client build the capture came from, when known. */
  clientVersion?: string;
  /** ISO calendar date (`YYYY-MM-DD`) of the capture. */
  capturedAt: string;
  steps: NormalizedTraceStep[];
}

/**
 * Normalize the loopback callback port — it is chosen per run.
 *
 * The host-start guard is a lookbehind, not `\b`: a word boundary never
 * matches before the `[` of a bracketed IPv6 literal (the preceding `/` and
 * the `[` are both non-word), so `\b` silently excluded `[::1]` entirely.
 */
function normalizeLoopbackPort(value: string): string {
  return value.replace(
    /(?<![\w.])(127\.0\.0\.1|localhost|\[::1\]):\d+/gu,
    "$1:<port>"
  );
}

function normalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return normalizeLoopbackPort(rawUrl);
  }

  const params = [...url.searchParams.entries()].map(
    ([key, value]) =>
      [
        key,
        VOLATILE_PARAMETERS.has(key.toLowerCase())
          ? NORMALIZED_VALUE
          : normalizeLoopbackPort(value),
      ] as [string, string]
  );
  // Sorted so query ORDER — which no spec fixes and which varies harmlessly
  // between HTTP clients — cannot manufacture a mismatch.
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  url.search = "";
  // The fragment is cleared too. Leaving it would append the rebuilt query
  // AFTER it (`/path#frag?a=b`), burying the query inside the fragment — and a
  // fragment is never sent to the server, so it is not part of a wire trace.
  url.hash = "";
  const query = params
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const base = normalizeLoopbackPort(url.toString().replace(/\?$/u, ""));
  return query ? `${base}?${query}` : base;
}

function normalizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (DROPPED_HEADERS.has(lower)) continue;
    out[lower] = VOLATILE_HEADERS.has(lower)
      ? NORMALIZED_VALUE
      : normalizeLoopbackPort(value);
  }
  // Header order carries no meaning on the wire.
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

function normalizeBodyValue(value: unknown, key?: string): unknown {
  if (key && VOLATILE_PARAMETERS.has(key.toLowerCase())) {
    return NORMALIZED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBodyValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([entryKey, entryValue]) => [
          entryKey,
          normalizeBodyValue(entryValue, entryKey),
        ])
    );
  }
  if (typeof value === "string") return normalizeLoopbackPort(value);
  return value;
}

/**
 * Parse a form-encoded body into an object, preserving repeated keys as
 * arrays. Collapsing `scope=a&scope=b` to its last value would let a run with
 * duplicated parameters compare equal to one without them — parity overstated
 * by a parsing artifact.
 */
function parseFormBody(body: string): Record<string, unknown> {
  // Null-prototype: on a plain object literal `out["__proto__"] = value` sets
  // the prototype instead of defining a property, so a form parameter named
  // `__proto__` would vanish from both the comparison and the digest.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of new URLSearchParams(body).entries()) {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

function normalizeBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;

  if (typeof body === "string") {
    // JSON FIRST. A form-encoded body is never valid JSON, but a JSON body can
    // easily look form-encoded — `{"redirect_uri":"http://x?a=b"}` has no
    // spaces and contains `=`, so a shape test would misparse it and change
    // the body before comparison. Only object/array results are accepted here
    // so scalar strings keep their previous treatment.
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object") {
        return normalizeBodyValue(parsed);
      }
    } catch {
      // Not JSON — fall through to the form-encoded reading.
    }
    // Form-encoded bodies are compared as objects: the encoded string's
    // parameter order is an artifact of how the request was built.
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/u.test(body)) {
      return normalizeBodyValue(parseFormBody(body));
    }
    return normalizeLoopbackPort(body);
  }
  return normalizeBodyValue(body);
}

/**
 * Project a run's HTTP history into comparable steps. Responses are excluded
 * deliberately: a golden describes what the CLIENT does, and a server's
 * answers are the variable under test, not part of the client's behavior.
 */
export function normalizeOAuthTrace(
  entries: readonly HttpHistoryEntry[]
): NormalizedTraceStep[] {
  return entries.map((entry) => {
    const step: NormalizedTraceStep = {
      step: entry.step,
      method: entry.request.method.toUpperCase(),
      url: normalizeUrl(entry.request.url),
      headers: normalizeHeaders(entry.request.headers ?? {}),
    };
    const body = normalizeBody(entry.request.body);
    if (body !== undefined) step.body = body;
    return step;
  });
}

/**
 * The authorization redirect is a browser navigation rather than a request the
 * client issues, but its URL carries the parameters an emulated client is
 * judged on, so it is a comparable step in its own right.
 */
export function normalizeAuthorizationRedirectStep(
  authorizationUrl: string
): NormalizedTraceStep {
  return {
    step: "authorization_redirect",
    method: "GET",
    url: normalizeUrl(authorizationUrl),
    headers: {},
  };
}

/**
 * Place the authorization redirect at its point in the flow — after discovery
 * and registration, BEFORE the code is exchanged.
 *
 * Comparison is index-based, so position is meaning: appending the redirect
 * would put it after the token request on any run that completed, and no
 * golden recorded in flow order could ever match. A run that stopped AT the
 * redirect has no token request, so appending and inserting agree there.
 */
export function insertAuthorizationRedirectStep(
  steps: NormalizedTraceStep[],
  authorizationUrl: string | undefined
): NormalizedTraceStep[] {
  if (!authorizationUrl) return steps;
  const redirect = normalizeAuthorizationRedirectStep(authorizationUrl);
  const tokenIndex = steps.findIndex((step) => step.step === "token_request");
  if (tokenIndex === -1) return [...steps, redirect];
  return [...steps.slice(0, tokenIndex), redirect, ...steps.slice(tokenIndex)];
}

/** Content address of a profile — what binds a golden to the client it came from. */
export async function computeOAuthProfileDigest(
  profile: HostConfigOAuthProfile
): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalizeOAuthProfile(profile)));
}

/** Content address of a capture, so a run can name the exact golden it used. */
export async function computeOAuthGoldenTraceDigest(
  trace: Pick<OAuthGoldenTrace, "steps">
): Promise<string> {
  return sha256Hex(JSON.stringify(trace.steps));
}

export type OAuthComparisonStatus =
  | "not_compared"
  | "matched"
  | "matched_with_declared_substitutions"
  | "mismatched";

export type OAuthComparisonNotComparedReason =
  | "no_golden"
  | "golden_profile_mismatch"
  | "no_run_trace";

/**
 * A reason the match cannot be stated plainly. Independent of the diff: the
 * requests may line up exactly and the claim still be qualified.
 */
export type OAuthComparisonQualifier =
  | "partial_coverage"
  | "stale_capture"
  | "client_version_mismatch";

export interface OAuthTraceDifference {
  index: number;
  kind: "missing_in_run" | "unexpected_in_run" | "step" | "method" | "url" | "headers" | "body";
  detail: string;
  expected?: string;
  actual?: string;
}

export interface OAuthGoldenFreshness {
  capturedAt: string;
  ageDays: number;
  stale: boolean;
  clientVersion?: string;
  expectedClientVersion?: string;
}

export interface OAuthTraceComparisonResult {
  status: OAuthComparisonStatus;
  /** Present only when `status` is `not_compared`. */
  reason?: OAuthComparisonNotComparedReason;
  qualifiers: OAuthComparisonQualifier[];
  differences: OAuthTraceDifference[];
  /** Divergences the run itself declared (appended callback, retry, …). */
  declaredSubstitutions: OAuthEmulationDivergence[];
  freshness?: OAuthGoldenFreshness;
}

export interface CompareOAuthEmulationTraceInput {
  /** The run's normalized steps. */
  trace: NormalizedTraceStep[];
  golden: OAuthGoldenTrace;
  /** Digest of the profile the run used. Must match the golden's. */
  profileDigest: string;
  /** `partial` forces the `partial_coverage` qualifier. */
  coverageSummary: "complete" | "partial";
  declaredSubstitutions?: OAuthEmulationDivergence[];
  /** The client build being emulated, when the caller knows it. */
  expectedClientVersion?: string;
  /** Injected so staleness is deterministic; defaults to the current date. */
  now?: Date;
}

function diffStep(
  index: number,
  expected: NormalizedTraceStep,
  actual: NormalizedTraceStep
): OAuthTraceDifference[] {
  const differences: OAuthTraceDifference[] = [];
  if (expected.step !== actual.step) {
    differences.push({
      index,
      kind: "step",
      detail: `expected the ${expected.step} step, ran ${actual.step}`,
      expected: expected.step,
      actual: actual.step,
    });
  }
  if (expected.method !== actual.method) {
    differences.push({
      index,
      kind: "method",
      detail: `${expected.step}: method differs`,
      expected: expected.method,
      actual: actual.method,
    });
  }
  if (expected.url !== actual.url) {
    differences.push({
      index,
      kind: "url",
      detail: `${expected.step}: request URL differs`,
      expected: expected.url,
      actual: actual.url,
    });
  }
  // Both sides are re-normalized before serializing. A run's steps already are
  // (they came from `normalizeOAuthTrace`), but a golden may be hand-authored
  // or hand-edited, and then key order alone would manufacture a mismatch.
  // Normalization is idempotent, so re-applying it to a captured golden is
  // free.
  const expectedHeaders = JSON.stringify(normalizeHeaders(expected.headers));
  const actualHeaders = JSON.stringify(normalizeHeaders(actual.headers));
  if (expectedHeaders !== actualHeaders) {
    differences.push({
      index,
      kind: "headers",
      detail: `${expected.step}: request headers differ`,
      expected: expectedHeaders,
      actual: actualHeaders,
    });
  }
  const expectedBody = JSON.stringify(normalizeBody(expected.body) ?? null);
  const actualBody = JSON.stringify(normalizeBody(actual.body) ?? null);
  if (expectedBody !== actualBody) {
    differences.push({
      index,
      kind: "body",
      detail: `${expected.step}: request body differs`,
      expected: expectedBody,
      actual: actualBody,
    });
  }
  return differences;
}

function computeFreshness(
  golden: OAuthGoldenTrace,
  expectedClientVersion: string | undefined,
  now: Date
): OAuthGoldenFreshness {
  // Strict round-trip, matching the canonicalizer's date rule: `Date` silently
  // rolls an impossible calendar date forward (2026-02-31 → 2026-03-03), which
  // would turn a malformed capture into a confident freshness claim. An
  // unusable date yields NaN and lands in the stale path below.
  const raw = golden.capturedAt;
  const captured = /^\d{4}-\d{2}-\d{2}$/u.test(raw)
    ? new Date(`${raw}T00:00:00Z`)
    : new Date(Number.NaN);
  const roundTrips =
    !Number.isNaN(captured.getTime()) &&
    captured.toISOString().slice(0, 10) === raw;
  const ageMs = roundTrips ? now.getTime() - captured.getTime() : Number.NaN;
  const ageDays = Number.isNaN(ageMs)
    ? Number.NaN
    : Math.floor(ageMs / 86_400_000);
  return {
    capturedAt: golden.capturedAt,
    ageDays,
    // A future-dated capture is as unusable as an unparseable one — nothing
    // was captured tomorrow — and a negative age would otherwise sail past
    // the threshold check and be reported as current.
    stale:
      Number.isNaN(ageDays) ||
      ageDays < 0 ||
      ageDays > GOLDEN_STALENESS_DAYS,
    ...(golden.clientVersion ? { clientVersion: golden.clientVersion } : {}),
    ...(expectedClientVersion ? { expectedClientVersion } : {}),
  };
}

export function compareOAuthEmulationTrace(
  input: CompareOAuthEmulationTraceInput
): OAuthTraceComparisonResult {
  const {
    trace,
    golden,
    profileDigest,
    coverageSummary,
    declaredSubstitutions = [],
    expectedClientVersion,
    now = new Date(),
  } = input;

  // A golden captured from a different profile describes a different client.
  // Diffing it would produce confident nonsense, so refuse rather than report.
  if (golden.profileDigest !== profileDigest) {
    return {
      status: "not_compared",
      reason: "golden_profile_mismatch",
      qualifiers: [],
      differences: [],
      declaredSubstitutions,
    };
  }

  if (trace.length === 0) {
    return {
      status: "not_compared",
      reason: "no_run_trace",
      qualifiers: [],
      differences: [],
      declaredSubstitutions,
    };
  }

  const freshness = computeFreshness(golden, expectedClientVersion, now);
  const qualifiers: OAuthComparisonQualifier[] = [];
  // `not_modeled` fields mean part of the client was never enforced, so even
  // an exact diff cannot be an unqualified match.
  if (coverageSummary === "partial") qualifiers.push("partial_coverage");
  if (freshness.stale) qualifiers.push("stale_capture");
  if (
    expectedClientVersion &&
    golden.clientVersion &&
    golden.clientVersion !== expectedClientVersion
  ) {
    qualifiers.push("client_version_mismatch");
  }

  const differences: OAuthTraceDifference[] = [];
  const shared = Math.min(golden.steps.length, trace.length);
  for (let index = 0; index < shared; index += 1) {
    differences.push(...diffStep(index, golden.steps[index], trace[index]));
  }
  for (let index = shared; index < golden.steps.length; index += 1) {
    differences.push({
      index,
      kind: "missing_in_run",
      detail: `the real client sent a ${golden.steps[index].step} request the run never made`,
      expected: golden.steps[index].url,
    });
  }
  for (let index = shared; index < trace.length; index += 1) {
    differences.push({
      index,
      kind: "unexpected_in_run",
      detail: `the run made a ${trace[index].step} request the real client never made`,
      actual: trace[index].url,
    });
  }

  const status: OAuthComparisonStatus =
    differences.length > 0
      ? "mismatched"
      : declaredSubstitutions.length > 0
        ? "matched_with_declared_substitutions"
        : "matched";

  return {
    status,
    qualifiers,
    differences,
    declaredSubstitutions,
    freshness,
  };
}

/**
 * The only shape that may be reported as plain parity: the requests lined up,
 * nothing was substituted, coverage was complete, and the capture is current.
 */
export function isUnqualifiedMatch(
  result: OAuthTraceComparisonResult
): boolean {
  return result.status === "matched" && result.qualifiers.length === 0;
}
