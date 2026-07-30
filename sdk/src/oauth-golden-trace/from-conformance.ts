/**
 * HP-44 — capture a golden trace from an in-process emulator run.
 *
 * This is the CANDIDATE side of a parity diff, and — for `mcpjam` itself — also
 * the golden side, because MCPJam is first-party and can be run end to end
 * today. Getting a working self-diff first is deliberate: it proves the oracle
 * before any time is spent on proxy capture for hosts we may not be able to run
 * at all.
 *
 * The input is the `ConformanceResult` the existing
 * `sdk/src/oauth-conformance/runner.ts` already produces. Its
 * `steps[].httpAttempts` carry the complete `HttpHistoryEntry` wire record, so
 * no new instrumentation is needed to capture our own behavior — the harness
 * bolts onto HP-39's CLI + test-server story rather than duplicating it.
 *
 * Leg classification prefers the state machine's own `OAuthFlowStep` over URL
 * heuristics. For our own code the machine KNOWS which leg it is on; a heuristic
 * that disagreed would be recording our guess about ourselves. The heuristic is
 * kept as a fallback for steps that map to no leg, and `legBasis` records which
 * one fired.
 */

import type { ConformanceResult } from "../oauth-conformance/types.js";
import type { HttpHistoryEntry } from "../oauth/state-machines/types.js";
import { classifyLeg, deriveObservations, legForOAuthFlowStep, withObservedLoopbackPorts } from "./observe.js";
import {
  NORMALIZER_VERSION,
  assertTraceIsRedacted,
  extractLoopbackPorts,
  normalizeWire,
} from "./normalize.js";
import { collectRedirectUris, parseTraceBody } from "./parse.js";
import { GOLDEN_TRACE_VERSION, notObserved, present } from "./types.js";
import type {
  GoldenTrace,
  TraceExchange,
  TraceOAuthImplementation,
  TraceScenario,
  TraceSubject,
} from "./types.js";

declare const __MCPJAM_SDK_VERSION__: string;

/** Resolved SDK version, or `unknown` when the define was not substituted. */
function resolveSdkVersion(): string | undefined {
  try {
    return typeof __MCPJAM_SDK_VERSION__ === "string"
      ? __MCPJAM_SDK_VERSION__
      : undefined;
  } catch {
    return undefined;
  }
}

/** Build a deterministic trace id. Same host + scenario + day ⇒ same id. */
export function buildTraceId(input: {
  hostId: string;
  scenarioId: string;
  capturedAt: string;
  kind: TraceSubject["kind"];
}): string {
  return `${input.hostId}/${input.scenarioId}/${input.capturedAt}/${input.kind}`;
}

/**
 * Flatten a ConformanceResult's per-step HTTP attempts into wire order.
 *
 * `httpAttempts` are appended in execution order within a step, and steps are
 * pushed in execution order, so plain concatenation already reflects the wire.
 * Note the deliberate absence of a timestamp sort: same-millisecond requests
 * would reorder non-deterministically and destroy the ordering finding, which is
 * one of the things this harness exists to compare.
 *
 * Duplicates are NOT removed here — see {@link dedupeWireArtifacts}, which has
 * to run after normalization to work at all.
 */
export function collectHttpHistory(
  result: ConformanceResult,
): HttpHistoryEntry[] {
  const entries: HttpHistoryEntry[] = [];
  for (const step of result.steps) {
    for (const attempt of step.httpAttempts ?? []) entries.push(attempt);
  }
  return entries;
}

/**
 * Collapse the runner's double-reporting of each request.
 *
 * The conformance runner surfaces one HTTP exchange on BOTH of its paired steps
 * — `request_resource_metadata` and `received_resource_metadata` are two views of
 * the same round trip. Left uncollapsed, every trace would claim the client sent
 * each request twice and both the `legOrder` and full-sequence findings would be
 * nonsense.
 *
 * This must run AFTER normalization, not before. Pre-normalization the two copies
 * differ in exactly the fields normalization exists to erase — the JSON-RPC `id`
 * above all — so a raw-body key silently fails to match and the duplicate
 * survives. That was a real bug caught by looking at a captured trace, which is
 * a small vindication of the whole "check it against a recorded artifact"
 * premise.
 *
 * Within a key the MOST COMPLETE record wins: carrying a response beats not
 * carrying one, and more request headers beats fewer (the `request_*` view is
 * sometimes recorded before headers are attached). First-appearance order is
 * preserved, so a genuine discovery ladder — whose rungs have different URLs —
 * survives intact.
 *
 * Tradeoff, stated because it is a real one: a client that sends the SAME request
 * twice with byte-identical headers and body collapses to one exchange. Post
 * normalization those two requests are indistinguishable anyway, so no
 * information a diff could act on is lost.
 */
export function dedupeWireArtifacts(
  wire: readonly TraceExchange[],
): TraceExchange[] {
  const order: string[] = [];
  const best = new Map<string, TraceExchange>();

  const completeness = (exchange: TraceExchange): number =>
    (exchange.response ? 1_000 : 0) +
    Object.keys(exchange.request.headers ?? {}).length;

  for (const exchange of wire) {
    const key = JSON.stringify([
      exchange.leg,
      exchange.request.method,
      exchange.request.url,
      exchange.request.body ?? null,
    ]);

    const existing = best.get(key);
    if (!existing) {
      order.push(key);
      best.set(key, exchange);
      continue;
    }
    if (completeness(exchange) > completeness(existing)) best.set(key, exchange);
  }

  return order.map((key, index) => ({ ...best.get(key)!, ordinal: index }));
}

/**
 * Reconstruct the `/authorize` exchange, which never appears in `httpAttempts`.
 *
 * The client does not FETCH the authorization URL — it hands it to a browser. So
 * there is no intercepted request, but the URL itself (and therefore every param
 * that matters: `resource`, `code_challenge`, `state`, `scope`, `redirect_uri`)
 * is fully known and is recorded by the state machine as an info log.
 *
 * Reconstructing it is what makes the richest part of the diff available at all.
 * The reconstruction is marked `headersObserved: false` so the harness reports
 * this leg's headers as UNOBSERVED rather than claiming the client sends none —
 * see `TraceRequest.headersObserved`.
 */
function reconstructAuthorizeExchange(
  authorizationUrl: string,
  ordinal: number,
): TraceExchange {
  return {
    ordinal,
    leg: "authorize",
    legBasis:
      "reconstructed from the authorization URL the client handed to a browser: the client never fetches it itself, so no intercepted request exists",
    request: {
      method: "GET",
      url: authorizationUrl,
      headers: {},
      headersObserved: false,
    },
  };
}

/** Recover the authorization URL from a conformance run's info logs. */
function findAuthorizationUrl(result: ConformanceResult): string | undefined {
  for (const step of result.steps) {
    for (const log of step.logs ?? []) {
      if (log.step !== "authorization_request") continue;
      const data = log.data as { url?: unknown } | undefined;
      if (data && typeof data.url === "string") return data.url;
    }
  }
  return undefined;
}

function toExchange(
  entry: HttpHistoryEntry,
  ordinal: number,
  mcpServerUrl: string,
): TraceExchange {
  const requestBody = parseTraceBody(entry.request.body, entry.request.headers);

  const stepLeg = legForOAuthFlowStep(entry.step);
  const classified = classifyLeg({
    method: entry.request.method,
    url: entry.request.url,
    headers: entry.request.headers,
    body: requestBody,
    mcpServerUrl,
  });

  const leg = stepLeg ?? classified.leg;
  const legBasis = stepLeg
    ? `OAuthFlowStep=${entry.step}`
    : `wire heuristic: ${classified.basis} (step \`${entry.step}\` maps to no leg)`;

  return {
    ordinal,
    leg,
    legBasis,
    request: {
      method: entry.request.method,
      url: entry.request.url,
      headers: entry.request.headers,
      ...(requestBody ? { body: requestBody } : {}),
    },
    ...(entry.response
      ? {
          response: {
            status: entry.response.status,
            ...(entry.response.statusText
              ? { statusText: entry.response.statusText }
              : {}),
            headers: entry.response.headers,
            ...(parseTraceBody(entry.response.body, entry.response.headers)
              ? { body: parseTraceBody(entry.response.body, entry.response.headers)! }
              : {}),
          },
        }
      : {}),
    ...(entry.error ? { error: { message: entry.error.message } } : {}),
  };
}

/**
 * The emulator-side inputs a trace actually needs, independent of HOW the
 * emulator was driven.
 *
 * Two drivers exist today and a third is coming, so the capture path is defined
 * against the wire record rather than against any one runner's result type:
 *
 *   - `OAuthConformanceTest` (the CLI / CI path) — see {@link captureEmulatorTrace}.
 *   - `runOAuthStateMachine` directly, which is how the browser Inspector runs
 *     its production OAuth and how a test can drive a machine with non-default
 *     options.
 *   - HP-43's per-host emulator, which will be configured from a host profile and
 *     has no reason to route through the conformance runner at all.
 *
 * Coupling capture to `ConformanceResult` would have forced HP-43 to either fake
 * one or duplicate this module.
 */
export type EmulatorFlowRecord = {
  /** The wire, in execution order. `OAuthFlowState.httpHistory`. */
  httpHistory: readonly HttpHistoryEntry[];
  /**
   * The authorization URL the client handed to a browser, when there was one.
   *
   * Supplied separately because it is NOT in `httpHistory`: the client builds this
   * URL and delegates it, so no request of its own is ever intercepted. Passing it
   * lets the harness reconstruct the `/authorize` leg — where `resource`,
   * `code_challenge`, `state` and `scope` all live — which is otherwise the richest
   * part of the diff and completely invisible.
   */
  authorizationUrl?: string;
};

/** Project a `ConformanceResult` onto the driver-independent record. */
export function toEmulatorFlowRecord(
  result: ConformanceResult,
): EmulatorFlowRecord {
  const authorizationUrl = findAuthorizationUrl(result);
  return {
    httpHistory: collectHttpHistory(result),
    ...(authorizationUrl ? { authorizationUrl } : {}),
  };
}

export type CaptureEmulatorTraceInput = {
  /** The completed (or partially completed) conformance run. */
  result: ConformanceResult;
  /** Catalog host id whose behavior the emulator was reproducing. */
  hostId: string;
  /** The scenario the run was pointed at. Gates any later diff. */
  scenario: TraceScenario;
  /** ISO calendar date (`YYYY-MM-DD`). Passed in so traces stay reproducible. */
  capturedAt: string;
  /** Full ISO instant, when the caller has one. */
  capturedAtExact?: string;
  /**
   * Version of the emulated host's own build. Omit for `mcpjam`, where the SDK
   * version below IS the host version.
   */
  hostVersion?: string;
  /**
   * Which implementation the emulator is reproducing. Defaults to
   * `first-party` — correct for MCPJam's own state machines, and WRONG for any
   * host that inherits OAuth from `rmcp` or the upstream TS SDK, so callers
   * emulating those must pass it explicitly.
   */
  oauthImplementation?: TraceOAuthImplementation;
  /** e.g. `debug-oauth-2025-11-25`. Recorded for attributability. */
  stateMachine?: string;
  surface?: string;
  build?: string;
  notes?: string[];
};

/**
 * Build a normalized, redacted golden trace from a conformance run.
 *
 * Throws if the result still contains a secret-shaped value after
 * normalization, so a leaking capture fails loudly at the point of capture
 * rather than being committed and discovered later.
 */
export function captureEmulatorTrace(
  input: CaptureEmulatorTraceInput,
): GoldenTrace {
  const { result, ...rest } = input;
  return captureEmulatorTraceFromFlow({
    ...rest,
    flow: toEmulatorFlowRecord(result),
  });
}

/**
 * Build a golden trace from a raw emulator flow record.
 *
 * The driver-independent entry point — see {@link EmulatorFlowRecord}. Use this
 * when the emulator was not driven through `OAuthConformanceTest`: a direct
 * `runOAuthStateMachine` call, the browser Inspector, or HP-43's per-host
 * emulator.
 */
export function captureEmulatorTraceFromFlow(
  input: Omit<CaptureEmulatorTraceInput, "result"> & { flow: EmulatorFlowRecord },
): GoldenTrace {
  const rawWire = input.flow.httpHistory.map((entry, index) =>
    toExchange(entry, index, input.scenario.mcpServerUrl),
  );

  // Splice the reconstructed `/authorize` in at its true wire position: after the
  // client obtained a client_id and before it redeems the code at /token. Placing
  // it by leg rather than by timestamp keeps the ordering finding meaningful even
  // though this exchange has no timestamp of its own.
  if (input.flow.authorizationUrl) {
    const authorize = reconstructAuthorizeExchange(input.flow.authorizationUrl, 0);
    const tokenIndex = rawWire.findIndex(
      (exchange) => exchange.leg === "token" || exchange.leg === "refresh",
    );
    const insertAt = tokenIndex >= 0 ? tokenIndex : rawWire.length;
    rawWire.splice(insertAt, 0, authorize);
    rawWire.forEach((exchange, index) => {
      exchange.ordinal = index;
    });
  }

  // Recover loopback ports BEFORE normalization placeholds them.
  const redirectUris = rawWire.flatMap((exchange) =>
    collectRedirectUris({
      url: exchange.request.url,
      body: exchange.request.body,
    }),
  );
  const loopbackPorts = extractLoopbackPorts(redirectUris);

  const originOptions = {
    mcpServerUrl: input.scenario.mcpServerUrl,
    authorizationServerUrl: input.scenario.authorizationServerUrl,
  };
  // Normalize FIRST, then collapse: the runner's two copies of each exchange
  // differ only in fields normalization erases. See `dedupeWireArtifacts`.
  const wire = dedupeWireArtifacts(normalizeWire(rawWire, originOptions));

  const sdkVersion = resolveSdkVersion();
  const subject: TraceSubject = {
    kind: "emulator",
    hostId: input.hostId,
    hostVersion:
      input.hostVersion != null
        ? present(input.hostVersion)
        : sdkVersion != null
          ? present(sdkVersion)
          : notObserved(
              "the @mcpjam/sdk version define was not substituted in this build",
            ),
    oauthImplementation: present(
      input.oauthImplementation ?? { kind: "first-party" },
    ),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.build ? { build: input.build } : {}),
  };

  const observations = withObservedLoopbackPorts(
    deriveObservations({ wire, scenario: input.scenario }),
    loopbackPorts,
  );

  const trace: GoldenTrace = {
    traceVersion: GOLDEN_TRACE_VERSION,
    traceId: buildTraceId({
      hostId: input.hostId,
      scenarioId: input.scenario.scenarioId,
      capturedAt: input.capturedAt,
      kind: "emulator",
    }),
    subject,
    scenario: input.scenario,
    capture: {
      capturedAt: input.capturedAt,
      ...(input.capturedAtExact ? { capturedAtExact: input.capturedAtExact } : {}),
      method: {
        via: "mcpjam-emulator",
        sdkVersion: sdkVersion ?? "unknown",
        ...(input.stateMachine ? { stateMachine: input.stateMachine } : {}),
      },
      redaction: { applied: true, normalizerVersion: NORMALIZER_VERSION },
      ...(input.notes ? { notes: input.notes } : {}),
    },
    wire,
    observations,
  };

  assertTraceIsRedacted(trace);
  return trace;
}
