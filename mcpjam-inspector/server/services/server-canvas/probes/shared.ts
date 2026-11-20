/**
 * Helpers the background probes share: summary construction against the
 * contract keys, and URL scrubbing for anything stored.
 *
 * A summary's `detail` is always a fixed phrase written here, never an error
 * message or server text: those can carry URLs with query strings, header
 * values or tokens, and summaries are stored.
 */
import {
  boundedProbeValues,
  type CoverageState,
  type ProbeStatus,
  type ProbeSummary,
  type ProbeValue,
  type ProbeValueKeysMap,
  type ServerProbeId,
} from "@mcpjam/sdk";

export type ProbeValues<P extends ServerProbeId> = Partial<
  Record<ProbeValueKeysMap[P], ProbeValue>
>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function probeSummary<P extends ServerProbeId>(
  probeId: P,
  input: {
    status: ProbeStatus;
    coverage: CoverageState;
    at: number;
    detail?: string;
    values?: ProbeValues<P>;
    checks?: ProbeSummary<P>["checks"];
  },
): ProbeSummary<P> {
  return {
    probeId,
    status: input.status,
    coverage: input.coverage,
    at: input.at,
    ...(input.detail ? { detail: input.detail } : {}),
    values: boundedProbeValues(probeId, input.values ?? {}),
    ...(input.checks && Object.keys(input.checks).length > 0
      ? { checks: input.checks }
      : {}),
  };
}

/** A summary for a probe that did not run, with the reason as a fixed phrase. */
export function unranProbe<P extends ServerProbeId>(
  probeId: P,
  status: Exclude<ProbeStatus, "ok">,
  at: number,
  detail: string,
): ProbeSummary<P> {
  return probeSummary(probeId, { status, coverage: "not-captured", at, detail });
}

/**
 * A URL as it may be stored. Query strings, fragments and user info can carry
 * credentials, so a URL with any of them keeps only scheme, host and path. A
 * URL without them is kept exactly as written, because catalog rules compare
 * issuers and authorization server URLs character for character. Anything
 * that does not parse as http(s) is dropped.
 */
export function storableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) {
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
    return value.includes("?") || value.includes("#") ? url.toString() : value;
  } catch {
    return null;
  }
}

/** The string entries of a metadata list. */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
