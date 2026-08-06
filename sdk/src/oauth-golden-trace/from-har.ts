/**
 * HP-44 — ingest a real host's handshake from a HAR capture.
 *
 * This is the GOLDEN side for any host we cannot run in-process: point the host
 * at a proxy, drive the handshake, export the HAR, feed it here.
 *
 * ── What this path has to be careful about ────────────────────────────────
 *
 *  1. A real HAR is mostly NOISE. A desktop client's capture contains telemetry,
 *     update checks and font fetches. Everything not on a known origin and not
 *     classifiable as a handshake leg is dropped, and the count and reasons are
 *     returned in {@link HarIngestReport} rather than discarded — a silent filter
 *     would let a missed `/token` request look like a client that never fetched
 *     a token.
 *
 *  2. A real HAR is usually INCOMPLETE. The `/authorize` leg happens in a
 *     browser the proxy may not see, and consent is driven by a human. Missing
 *     legs become `not-observed` observations, which the differ reports as gaps.
 *     That is the correct output — it is exactly the "unverifiable, here's the
 *     blocker" result the ticket asks for, and it is strictly better than a
 *     plausible guess.
 *
 *  3. A real HAR contains LIVE CREDENTIALS. Redaction happens here, at ingest,
 *     before anything is written — never at render time. `assertTraceIsRedacted`
 *     then re-checks, so a HAR with an unusual token-bearing field fails ingest
 *     instead of landing in the repo.
 */

import { classifyLeg, deriveObservations, withObservedLoopbackPorts } from "./observe.js";
import {
  NORMALIZER_VERSION,
  assertTraceIsRedacted,
  extractLoopbackPorts,
  normalizeWire,
} from "./normalize.js";
import { collectRedirectUris, parseFormFields, parseTraceBody } from "./parse.js";
import { GOLDEN_TRACE_VERSION, notObserved, present } from "./types.js";
import type {
  GoldenTrace,
  TraceBody,
  TraceExchange,
  TraceOAuthImplementation,
  TraceScenario,
  TraceSubject,
} from "./types.js";
import { buildTraceId } from "./from-conformance.js";

// ── Minimal HAR 1.2 shapes (only what this module reads) ─────────────────

type HarNameValue = { name: string; value: string };

type HarPostData = {
  mimeType?: string;
  text?: string;
  params?: HarNameValue[];
};

type HarEntry = {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: HarNameValue[];
    postData?: HarPostData;
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: HarNameValue[];
    content?: {
      mimeType?: string;
      text?: string;
      encoding?: string;
      size?: number;
    };
  };
};

type HarLog = {
  log?: {
    version?: string;
    creator?: { name?: string; version?: string };
    entries?: HarEntry[];
  };
};

/** What was dropped at ingest, and why. A first-class deliverable, not a log. */
export type HarIngestReport = {
  totalEntries: number;
  keptEntries: number;
  /** `url -> reason` for every dropped entry, deduped by URL. */
  dropped: Array<{ url: string; reason: string }>;
  /** Legs the harness expects for a full handshake but did not find. */
  missingLegs: string[];
  /** Non-fatal caveats a reviewer should read before trusting the trace. */
  warnings: string[];
};

function headersToRecord(headers: HarNameValue[] | undefined): Record<string, string> {
  // Null-prototype accumulator: HAR header names are attacker-influenced strings.
  // On a plain `{}` a header named `constructor` would report as "already added"
  // and be joined onto a stringified builtin, and one named `__proto__` would hit
  // the prototype setter and vanish instead of becoming an own property.
  const out: Record<string, string> = Object.create(null);
  for (const header of headers ?? []) {
    if (!header?.name) continue;
    const key = header.name.toLowerCase();
    // HAR lists repeated headers as separate entries; join with `, ` per RFC 9110
    // rather than letting the last one win.
    out[key] = key in out ? `${out[key]}, ${header.value ?? ""}` : (header.value ?? "");
  }
  return out;
}

function bodyFromPostData(
  postData: HarPostData | undefined,
  headers: Record<string, string>,
): TraceBody | undefined {
  if (!postData) return undefined;

  // `params` is HAR's pre-parsed form view. Preferred when present because it
  // survives proxies that omit `text`, and it is already multi-valued.
  if (postData.params && postData.params.length > 0) {
    // Null-prototype for the same reason as `headersToRecord`: on a plain `{}` a
    // param named `constructor` makes `fields[name] ??= []` resolve to the builtin
    // and `.push` on it throws, aborting ingest of the whole capture.
    const fields: Record<string, string[]> = Object.create(null);
    for (const param of postData.params) {
      if (!param?.name) continue;
      (fields[param.name] ??= []).push(param.value ?? "");
    }
    return { encoding: "form", fields };
  }

  if (typeof postData.text === "string" && postData.text !== "") {
    const withMime = postData.mimeType
      ? { ...headers, "content-type": postData.mimeType }
      : headers;
    return parseTraceBody(postData.text, withMime);
  }

  return undefined;
}

type HarContent = {
  mimeType?: string;
  text?: string;
  encoding?: string;
  size?: number;
};

function bodyFromContent(
  content: HarContent | undefined,
  headers: Record<string, string>,
): TraceBody | undefined {
  if (!content) return undefined;
  // Base64 content is binary or a rendered page; never force-parse it.
  if (content.encoding === "base64") {
    return {
      encoding: "opaque",
      ...(content.mimeType ? { contentType: content.mimeType } : {}),
      ...(content.size != null ? { byteLength: content.size } : {}),
    };
  }
  if (typeof content.text !== "string" || content.text === "") return undefined;
  const withMime = content.mimeType
    ? { ...headers, "content-type": content.mimeType }
    : headers;
  return parseTraceBody(content.text, withMime);
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Legs a complete authorization-code handshake is expected to contain, GIVEN the
 * scenario's capabilities.
 *
 * `prm-discovery` is gated on `publishesPrm` because a no-PRM scenario has nothing
 * to discover: a client that never fetches a PRM document there is behaving
 * correctly, and listing the leg as a missing blocker would flag conformant
 * behavior as an incomplete capture — the exact false alarm `missingLegs` exists
 * to avoid. Same reasoning as the scenario gate on the diff itself.
 */
function expectedLegsFor(capabilities: TraceScenario["capabilities"]): string[] {
  return [
    ...(capabilities.publishesPrm ? ["prm-discovery"] : []),
    "as-metadata-discovery",
    "authorize",
    "token",
    "mcp-initialize",
  ];
}

export type CaptureHarTraceInput = {
  /** Parsed HAR JSON (HAR 1.2). */
  har: unknown;
  hostId: string;
  scenario: TraceScenario;
  /** ISO calendar date. Defaults to the date of the first HAR entry. */
  capturedAt?: string;
  /**
   * The host build that was captured. Omitting it is allowed but produces a
   * `not-observed` stamp, which the differ reports as a gap — a trace that
   * cannot name its build goes stale invisibly.
   */
  hostVersion?: string;
  /**
   * The RESOLVED OAuth implementation. Five of six source-verified clients get
   * their OAuth from a dependency (`rmcp`, the upstream TS SDK), so for those
   * hosts the host version alone is not enough to keep this trace honest across
   * a dependency bump. Omitting it is recorded as `not-observed`.
   */
  oauthImplementation?: TraceOAuthImplementation;
  surface?: string;
  build?: string;
  operator?: string;
  notes?: string[];
  /** Extra origins to treat as in-scope, e.g. a vendor's CIMD host. */
  extraOrigins?: Record<string, string>;
};

/**
 * Build a golden trace from a HAR.
 *
 * Returns the trace AND the ingest report. Callers should surface the report:
 * its `dropped` and `missingLegs` are the honest account of what the capture did
 * not cover, which the ticket requires as a deliverable in its own right.
 */
export function captureHarTrace(input: CaptureHarTraceInput): {
  trace: GoldenTrace;
  report: HarIngestReport;
} {
  const har = input.har as HarLog;
  const entries = har?.log?.entries ?? [];

  const inScopeOrigins = new Set(
    [
      originOf(input.scenario.mcpServerUrl),
      originOf(input.scenario.authorizationServerUrl),
      ...Object.values(input.extraOrigins ?? {}).map((value) => originOf(value) ?? value),
    ].filter((value): value is string => value != null),
  );

  // Keyed by URL, first reason wins. A desktop capture polls the same telemetry
  // or update endpoint dozens of times, and a report that listed every poll would
  // both overstate how much was thrown away and bury the one dropped request a
  // reviewer actually needs to see. Insertion order is HAR order, so the listing
  // is deterministic; retaining the FIRST reason keeps it independent of how often
  // a URL recurs.
  const dropped = new Map<string, string>();
  const drop = (url: string, reason: string) => {
    if (!dropped.has(url)) dropped.set(url, reason);
  };
  const warnings: string[] = [];
  const rawWire: TraceExchange[] = [];

  for (const entry of entries) {
    const url = entry?.request?.url;
    if (!url) {
      drop("<no url>", "HAR entry has no request URL");
      continue;
    }

    const method = entry.request?.method ?? "GET";
    const requestHeaders = headersToRecord(entry.request?.headers);
    const requestBody = bodyFromPostData(entry.request?.postData, requestHeaders);

    const classified = classifyLeg({
      method,
      url,
      headers: requestHeaders,
      body: requestBody,
      mcpServerUrl: input.scenario.mcpServerUrl,
    });

    const origin = originOf(url);
    const onKnownOrigin = origin != null && inScopeOrigins.has(origin);

    if (classified.leg === "unknown" && !onKnownOrigin) {
      drop(
        url,
        "not on a scenario origin and matched no handshake-leg rule (assumed unrelated traffic)",
      );
      continue;
    }
    if (classified.leg === "unknown") {
      warnings.push(
        `Kept ${method} ${url} on a scenario origin even though no leg rule matched; recorded as \`unknown\`. Review it — a misclassified leg silently weakens every per-leg finding.`,
      );
    }

    const responseHeaders = headersToRecord(entry.response?.headers);
    const responseBody = bodyFromContent(entry.response?.content, responseHeaders);

    rawWire.push({
      ordinal: rawWire.length,
      leg: classified.leg,
      legBasis: `wire heuristic: ${classified.basis}`,
      request: {
        method,
        url,
        headers: requestHeaders,
        ...(requestBody ? { body: requestBody } : {}),
      },
      ...(entry.response?.status != null
        ? {
            response: {
              status: entry.response.status,
              ...(entry.response.statusText
                ? { statusText: entry.response.statusText }
                : {}),
              headers: responseHeaders,
              ...(responseBody ? { body: responseBody } : {}),
            },
          }
        : {}),
    });
  }

  const redirectUris = rawWire.flatMap((exchange) =>
    collectRedirectUris({ url: exchange.request.url, body: exchange.request.body }),
  );
  const loopbackPorts = extractLoopbackPorts(redirectUris);

  const wire = normalizeWire(rawWire, {
    mcpServerUrl: input.scenario.mcpServerUrl,
    authorizationServerUrl: input.scenario.authorizationServerUrl,
    ...(input.extraOrigins ? { extraOrigins: input.extraOrigins } : {}),
  });

  const capturedAt =
    input.capturedAt ??
    entries.find((entry) => entry?.startedDateTime)?.startedDateTime?.slice(0, 10) ??
    "unknown";
  if (capturedAt === "unknown") {
    warnings.push(
      "No capture date could be determined from the HAR and none was supplied. The trace is stamped `unknown`, which makes it unusable as dated evidence — re-ingest with an explicit `capturedAt`.",
    );
  }

  const legsPresent = new Set<string>(wire.map((exchange) => exchange.leg));
  const missingLegs = expectedLegsFor(input.scenario.capabilities).filter(
    (leg) => !legsPresent.has(leg),
  );

  const subject: TraceSubject = {
    kind: "real-host",
    hostId: input.hostId,
    hostVersion:
      input.hostVersion != null
        ? present(input.hostVersion)
        : notObserved(
            "no host version was supplied at ingest, and a HAR does not carry one",
          ),
    oauthImplementation:
      input.oauthImplementation != null
        ? present(input.oauthImplementation)
        : notObserved(
            "no resolved OAuth implementation was supplied at ingest; for a host that inherits OAuth from a dependency this trace will go stale on a dependency bump with no visible signal",
          ),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.build ? { build: input.build } : {}),
  };

  const observations = withObservedLoopbackPorts(
    deriveObservations({ wire, scenario: input.scenario }),
    loopbackPorts,
  );

  const creator = har?.log?.creator;
  const trace: GoldenTrace = {
    traceVersion: GOLDEN_TRACE_VERSION,
    traceId: buildTraceId({
      hostId: input.hostId,
      scenarioId: input.scenario.scenarioId,
      capturedAt,
      kind: "real-host",
    }),
    subject,
    scenario: input.scenario,
    capture: {
      capturedAt,
      method: {
        via: "har",
        ...(creator?.name ? { harCreator: creator.name } : {}),
        ...(har?.log?.version ? { harVersion: har.log.version } : {}),
      },
      ...(input.operator ? { operator: input.operator } : {}),
      redaction: { applied: true, normalizerVersion: NORMALIZER_VERSION },
      ...(input.notes ? { notes: input.notes } : {}),
    },
    wire,
    observations,
  };

  assertTraceIsRedacted(trace);

  return {
    trace,
    report: {
      totalEntries: entries.length,
      keptEntries: wire.length,
      dropped: [...dropped].map(([url, reason]) => ({ url, reason })),
      missingLegs,
      warnings,
    },
  };
}

/** Exposed for tests: HAR `postData.text` form parsing shares one code path. */
export const __internal = { parseFormFields };
