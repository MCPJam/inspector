/**
 * HP-44 — golden-trace parity harness: the trace schema.
 *
 * This module defines what "the emulator behaves exactly like the real host"
 * MEANS, as a data shape a reviewer can check an artifact against. It is the
 * acceptance oracle for HP-43 (emulator enforcement).
 *
 * ── Why this schema looks the way it does ──────────────────────────────────
 *
 * Every unusual decision below traces to a specific way the previous rounds of
 * this work got a fact wrong. They are load-bearing, not stylistic:
 *
 *  1. {@link Observation} is a THREE-state type, not `T | undefined`. "The host
 *     captured this leg and the field was not on the wire" and "we never
 *     captured that leg" are different findings, and collapsing them is exactly
 *     the HP-17 failure mode. VS Code sending NO `MCP-Protocol-Version` on MCP
 *     traffic is a positive, citable finding; not having watched VS Code's MCP
 *     traffic is a gap. One belongs in a profile as `verified`, the other only
 *     as `unverifiable`.
 *
 *     The tri-state is TOTAL, and stays that way: no field that a capture can
 *     leave undetermined is a bare `boolean`, and the two `Partial` per-leg maps
 *     document that a missing key means `not-observed` rather than "no finding".
 *     Each escape from that rule was a bug — a boolean `wiresDisagree` let a
 *     one-wire capture project "these wires agree", and a skipped map key let a
 *     leg only one side recorded vanish out of a diff instead of being reported.
 *
 *  2. {@link ProtocolVersionUsage} records the `initialize` body version and the
 *     `MCP-Protocol-Version` HTTP header SEPARATELY, and the header PER LEG.
 *     These are two different things wearing one name and they disagree in the
 *     wild: Goose runs an RFC 9728 PRM ladder on the OAuth wire while
 *     hard-pinning 2025-03-26 on the MCP wire; VS Code sends the header only on
 *     OAuth discovery and never on MCP traffic; `rmcp` hardcodes
 *     `2024-11-05` on OAuth discovery specifically, affecting both Codex and
 *     Goose. A single field would average all three away.
 *
 *  3. {@link TraceSubject} carries `oauthImplementation` — the resolved
 *     DEPENDENCY and its version — alongside the host version. Five of six
 *     source-verified clients inherit their OAuth behavior from `rmcp` or the
 *     upstream TS SDK rather than their own code, so a trace stamped only with
 *     the host version goes silently stale on a dependency bump.
 *
 *  4. Query params and form fields are `Record<string, string[]>`, NOT
 *     `Record<string, string>`. Whether a client emits `resource` ONCE or TWICE
 *     on `/authorize` is an open question a trace is supposed to settle; a
 *     single-valued map destroys the answer before it can be read.
 *
 *  5. {@link ResourceIndicatorUsage} is not a boolean. Three source-verified
 *     clients send `resource` CONDITIONALLY (omitted entirely when PRM
 *     discovery fails), and the VALUE differs by client — Claude and ChatGPT
 *     send the canonicalized MCP server URL, VS Code sends the PRM document's
 *     own `resource` field. Per-leg values plus a computed value-source
 *     classification preserve both distinctions.
 *
 *  6. {@link TraceScenario} pins the AS/RS feature switches that shape the
 *     dance. Diffing a trace captured against a PRM-publishing server with one
 *     captured against a server that publishes none is meaningless, so the
 *     differ GATES on scenario equality rather than reporting a cascade of
 *     bogus differences.
 *
 * Traces are evidence artifacts, not debugging output: they feed HP-9 (capability
 * audit) and HP-38 (daily re-capture / re-diff / drift flagging), and they
 * POPULATE {@link HostConfigOAuthProfileV1} via `./to-profile.js` rather than
 * inventing a parallel vocabulary.
 *
 * Secrets are redacted at CAPTURE time, never at render time — see
 * `./normalize.js`. A committed trace must contain no live credential.
 */

export const GOLDEN_TRACE_VERSION = 1 as const;

// ── The observation tri-state ─────────────────────────────────────────────

export const TRACE_OBSERVATION_STATES = [
  "present",
  "absent",
  "not-observed",
] as const;

export type TraceObservationState = (typeof TRACE_OBSERVATION_STATES)[number];

/**
 * A single observed fact, with the reason it is missing when it is missing.
 *
 * The `absent` / `not-observed` split is the whole point. `absent` is a
 * POSITIVE finding — the request was captured and the field genuinely was not
 * there, which is citable evidence and maps to a `verified` profile field.
 * `not-observed` means the leg that would carry the field was never captured;
 * it maps to `unverifiable` and carries NO value, mirroring
 * `OAuthProfileEvidence`'s own union.
 *
 * There is deliberately no way to spell "probably X" — an unconfirmed value is
 * unrepresentable rather than merely discouraged.
 */
export type Observation<T> =
  | { state: "present"; value: T }
  | { state: "absent" }
  | { state: "not-observed"; reason: string };

export function present<T>(value: T): Observation<T> {
  return { state: "present", value };
}

export const absent: Observation<never> = { state: "absent" };

export function notObserved<T>(reason: string): Observation<T> {
  return { state: "not-observed", reason };
}

/** Narrowing helper — `present` is the only arm carrying a value. */
export function observedValue<T>(observation: Observation<T>): T | undefined {
  return observation.state === "present" ? observation.value : undefined;
}

// ── Subject: WHO produced this handshake ──────────────────────────────────

/**
 * Where a client's OAuth behavior actually lives.
 *
 * `dependency` requires a RESOLVED version (from a lockfile), not a declared
 * range: `rmcp = "2"` in a manifest does not tell you whether the hardcoded
 * `MCP-Protocol-Version: 2024-11-05` on OAuth discovery is present in the build
 * that was captured.
 */
export type TraceOAuthImplementation =
  | { kind: "first-party" }
  | {
      kind: "dependency";
      /**
       * Package name, e.g. `rmcp` or the upstream TS SDK.
       *
       * Spelled out rather than quoted: `check:mcp-v1-runtime-imports` greps this
       * tree for the upstream package specifier with no comment awareness, so
       * naming it even in a doc comment fails the whole test pipeline.
       */
      package: string;
      /** Exact resolved version. Not a semver range. */
      version: string;
      /** How the version was resolved, e.g. `Cargo.lock` / `package-lock.json`. */
      resolvedFrom: string;
    };

/**
 * Identity of the thing whose handshake was recorded.
 *
 * `kind` is the parity axis: a `real-host` trace is the GOLDEN side and an
 * `emulator` trace is the CANDIDATE side. `hostId` is the catalog id both sides
 * share — a diff is only meaningful between two traces of the same `hostId`.
 */
export type TraceSubject = {
  kind: "real-host" | "emulator";
  /** Catalog host id (`HOST_TEMPLATE_IDS`), e.g. `mcpjam`, `vscode`. */
  hostId: string;
  /**
   * Version of the host binary/app. `absent` when the host genuinely exposes no
   * version (rare); `not-observed` when we could not read it — which is a real
   * durability gap and should be reported, not silently defaulted.
   */
  hostVersion: Observation<string>;
  /** Resolved OAuth implementation. See {@link TraceOAuthImplementation}. */
  oauthImplementation: Observation<TraceOAuthImplementation>;
  /**
   * Distinguishes builds that differ in observable OAuth identity, e.g. VS
   * Code's official build (`client_name: "Visual Studio Code"`) vs the OSS
   * build (`Code - OSS`).
   */
  build?: string;
  /**
   * Which surface of a multi-surface client, e.g. `web` / `desktop` / `cli`.
   * Claude ships at least four surfaces that need not agree with each other.
   */
  surface?: string;
};

// ── Scenario: WHAT the subject was pointed at ────────────────────────────

/**
 * The AS/RS feature switches that determine the SHAPE of a conformant dance.
 *
 * This is a diff gate, not decoration. A client that omits `resource` when PRM
 * discovery fails is behaving correctly; comparing its no-PRM trace against a
 * with-PRM golden trace would report that correct behavior as a parity failure.
 */
export type TraceScenarioCapabilities = {
  /** Does the resource server publish an RFC 9728 PRM document? */
  publishesPrm: boolean;
  /** The PRM document's own `resource` value, when it publishes one. */
  prmResource?: string;
  /** Does the AS advertise a `registration_endpoint` (RFC 7591 DCR)? */
  supportsDcr: boolean;
  /** Does the AS advertise `client_id_metadata_document_supported` (CIMD)? */
  supportsCimd: boolean;
  /** `code_challenge_methods_supported` as advertised. */
  codeChallengeMethods: string[];
  /**
   * The protocol version this server ADVERTISED — the `protocolVersion` it
   * returned from `initialize`.
   *
   * Recorded because it is the only artifact that can settle pin-vs-negotiate.
   * That question is answered by running one client against two servers
   * advertising DIFFERENT versions: a pinning client sends the same value to
   * both, a negotiating one follows each server. Without this field the two
   * captures are indistinguishable, so `traceToOAuthProfile` had to take the
   * "different server" half of the experiment on the caller's word — and a
   * contrast trace against a same-version server produced a `verified` pin out
   * of nothing.
   *
   * Optional because a capture through a third-party HAR need not have observed
   * an `initialize` response at all. Absent means "not known", and the pinning
   * projection treats it as a blocker rather than a licence to assume.
   */
  serverProtocolVersion?: string;
  /**
   * Which discovery documents the AS actually serves, as well-known paths. A
   * server serving only `/.well-known/openid-configuration` exercises a
   * different rung of the ladder than one serving the RFC 8414 form.
   */
  asMetadataDocuments: string[];
  /** Does the RS answer an unauthenticated request with 401 + WWW-Authenticate? */
  challengesUnauthenticated: boolean;
};

export type TraceScenario = {
  /** Stable id so two traces can assert they exercised the same dance. */
  scenarioId: string;
  /** Human summary of what this scenario is for. */
  description?: string;
  /** MCP server URL as configured, pre-normalization (provenance only). */
  mcpServerUrl: string;
  /** Authorization server URL as configured, pre-normalization. */
  authorizationServerUrl?: string;
  capabilities: TraceScenarioCapabilities;
};

// ── Capture provenance ───────────────────────────────────────────────────

export type TraceCaptureMethod =
  | {
      via: "mcpjam-emulator";
      /** Resolved `@mcpjam/sdk` version that produced the run. */
      sdkVersion: string;
      /** Which state machine ran, e.g. `debug-oauth-2025-11-25`. */
      stateMachine?: string;
    }
  | {
      via: "har";
      /** `log.creator.name` from the HAR, e.g. `mitmproxy` / `Charles`. */
      harCreator?: string;
      harVersion?: string;
    }
  | {
      via: "mitm-proxy";
      proxy: string;
    };

export type TraceCaptureMeta = {
  /**
   * ISO calendar date (`YYYY-MM-DD`) — deliberately the same granularity as
   * `OAuthProfileEvidence.capturedAt`, so a trace can be cited as a profile
   * source without a lossy conversion.
   */
  capturedAt: string;
  /** Full ISO instant, when the capture tool provides one. */
  capturedAtExact?: string;
  method: TraceCaptureMethod;
  /** Who ran the capture. Useful when a human had to drive a browser. */
  operator?: string;
  /**
   * Asserted by the capture path, verified by `assertTraceIsRedacted`. A trace
   * with `applied: false` must never be committed.
   */
  redaction: {
    applied: boolean;
    /** Which normalizer produced it, so a redaction bug is attributable. */
    normalizerVersion: number;
  };
  /** Free-form caveats a reviewer needs, e.g. "consent screen driven by hand". */
  notes?: string[];
};

// ── The wire ─────────────────────────────────────────────────────────────

/**
 * Which stage of the handshake a request belongs to.
 *
 * Split finely enough that the per-leg header findings stay separable — in
 * particular `prm-discovery` / `as-metadata-discovery` (the OAuth wire, where
 * `rmcp` pins 2024-11-05) must not merge with `mcp-initialize` /
 * `mcp-authenticated` (the MCP wire, where it negotiates something newer).
 */
export const TRACE_LEGS = [
  "mcp-unauthenticated",
  "prm-discovery",
  "as-metadata-discovery",
  "cimd-fetch",
  "dcr-register",
  "authorize",
  "token",
  "refresh",
  "mcp-initialize",
  "mcp-authenticated",
  "unknown",
] as const;

export type TraceLeg = (typeof TRACE_LEGS)[number];

/** Legs that travel on the OAuth wire (as opposed to the MCP wire). */
export const OAUTH_DISCOVERY_LEGS: readonly TraceLeg[] = [
  "prm-discovery",
  "as-metadata-discovery",
  "cimd-fetch",
];

/** Legs that travel on the MCP wire. */
export const MCP_WIRE_LEGS: readonly TraceLeg[] = [
  "mcp-unauthenticated",
  "mcp-initialize",
  "mcp-authenticated",
];

/**
 * A request or response body.
 *
 * `form` and `json` keep structure so fields can be diffed individually;
 * `opaque` records only shape, for bodies we cannot or should not retain (HTML
 * consent pages, binary). Note `form.fields` and query params are
 * multi-valued — see design note 4 in the module header.
 */
export type TraceBody =
  | { encoding: "form"; fields: Record<string, string[]> }
  | { encoding: "json"; json: unknown }
  | {
      encoding: "jsonrpc";
      /** JSON-RPC `method`, hoisted so leg classification is cheap. */
      method?: string;
      json: unknown;
    }
  | { encoding: "opaque"; contentType?: string; byteLength?: number };

export type TraceRequest = {
  method: string;
  /**
   * Normalized URL: origins replaced with `{mcp_server}` / `{as}` placeholders
   * and volatile path/query values placeheld. Query is ALSO broken out into
   * {@link TraceRequest.query} — the string form is for human reading, the map
   * is what the differ compares.
   */
  url: string;
  /** Header names lowercased; volatile and sensitive values placeheld. */
  headers: Record<string, string>;
  /**
   * Whether this request's headers were actually seen. Defaults to `true`.
   *
   * `false` marks a request the CLIENT did not send itself — above all
   * `/authorize`, which the client hands to a browser as a URL. Its params are
   * fully known (they are in the URL) but its headers belong to the browser and
   * are genuinely unobserved.
   *
   * Without this flag an emulator's synthesized `/authorize` would report every
   * header as `absent` — a positive claim that the client sends no
   * `MCP-Protocol-Version` there — and would then "differ" from a proxy capture
   * that did see the browser's headers. That is a fabricated finding, which is
   * precisely what this schema exists to prevent.
   */
  headersObserved?: boolean;
  /** Multi-valued query parameters, normalized. */
  query?: Record<string, string[]>;
  body?: TraceBody;
};

export type TraceResponse = {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body?: TraceBody;
};

export type TraceExchange = {
  /**
   * 0-based position in the captured handshake. Ordering is itself a finding —
   * Goose connects unauthenticated FIRST and only falls back to OAuth on a 401,
   * the opposite of Claude and ChatGPT — so this is compared, not just used for
   * display.
   */
  ordinal: number;
  leg: TraceLeg;
  /** Why this leg was assigned, when classification was not unambiguous. */
  legBasis?: string;
  request: TraceRequest;
  response?: TraceResponse;
  /** Transport-level failure, when the request produced no response. */
  error?: { message: string };
};

// ── Derived observations ─────────────────────────────────────────────────

/**
 * RFC 8707 resource-indicator behavior.
 *
 * Not a boolean, deliberately. `sent` captures the CONDITION (VS Code and Cline
 * omit `resource` entirely when PRM discovery fails; Codex's is a
 * caller-supplied option), and `valueSource` captures WHICH url is sent —
 * Claude and ChatGPT document the canonicalized MCP server URL while VS Code
 * sends the PRM document's `resource` field. Both distinctions are invisible to
 * a yes/no column.
 */
export type ResourceIndicatorValueSource =
  | "mcp-server-url"
  | "prm-resource"
  | "other";

export type ResourceIndicatorUsage = {
  /** Raw `resource` values on `/authorize`. Multi-valued on purpose. */
  onAuthorize: Observation<string[]>;
  onToken: Observation<string[]>;
  onRefresh: Observation<string[]>;
  /**
   * Which URL the value corresponds to, computed by comparing the observed
   * value against `scenario.capabilities.prmResource` and
   * `scenario.mcpServerUrl`.
   */
  valueSource: Observation<ResourceIndicatorValueSource>;
};

/**
 * The two-headed `protocolVersionPinning` field, kept as separate fields.
 *
 * `initializeBody` is `initialize.params.protocolVersion`. `headerByLeg` is the
 * `MCP-Protocol-Version` HTTP header, recorded per leg because clients vary it:
 * `rmcp` sends `2024-11-05` on OAuth discovery while negotiating a newer
 * version on MCP, and VS Code sends the header on OAuth discovery only.
 *
 * The rollups are convenience views over `headerByLeg`, each derived
 * independently. They are never merged into one value.
 */
export type ProtocolVersionUsage = {
  initializeBody: Observation<string>;
  /**
   * Per-leg `MCP-Protocol-Version`, as the DISTINCT values seen on that leg in
   * first-appearance order — almost always exactly one.
   *
   * A list rather than a scalar because a leg carrying two different values is a
   * real finding (and, for the profile mapping, decisive: exactly one distinct
   * value across a wire is a `pinned` claim, more than one is not a pin at all).
   * Collapsing to "the first one" would manufacture a pin that isn't there.
   *
   * PARTIAL BY INVARIANT: a key exists only for a leg this trace actually
   * captured. A MISSING key is not a fourth state — it means exactly
   * `not-observed`, and every consumer must materialize it as such rather than
   * skipping the leg. `./diff.js` does so through `observationForLeg`, which is
   * what keeps a leg one side never recorded from disappearing out of the report
   * instead of being named as a gap.
   */
  headerByLeg: Partial<Record<TraceLeg, Observation<string[]>>>;
  /** Rollup over {@link OAUTH_DISCOVERY_LEGS}. `absent` ⇒ never sent there. */
  headerOnOAuthDiscovery: Observation<string[]>;
  /** Rollup over {@link MCP_WIRE_LEGS}. `absent` ⇒ never sent there (VS Code). */
  headerOnMcpTraffic: Observation<string[]>;
  /**
   * `present: true` when the two wires carry DIFFERENT values, or when one
   * carries a value and the other demonstrably carries none. This is the
   * split-revision signal (Goose, and every `rmcp`-based client) — surfaced as a
   * first-class field so it cannot be read past.
   *
   * An {@link Observation}, not a `boolean`, for the reason in design note 1: a
   * plain `false` collapses "both wires were captured and they agree" with "we
   * only captured one wire", and the second is not a claim about the client at
   * all. Collapsed, a partial capture projects a no-split-revision finding —
   * `./to-profile.js` reads this field straight into profile evidence, so
   * guarding only inside the differ would not be enough.
   */
  wiresDisagree: Observation<boolean>;
  /**
   * `present: true` when the header value on any leg differs from
   * `initializeBody`. The second half of the same trap, and tri-state for the
   * same reason: `false` requires having observed BOTH an `initialize` and the
   * wires that could carry a disagreeing header.
   */
  headerDisagreesWithInitializeBody: Observation<boolean>;
};

/**
 * DCR identity as it actually appeared in the `/register` request body.
 *
 * Per RFC 7591 this metadata is self-asserted and therefore NOT a sound input
 * to server authorization policy — but servers in the wild do gate on
 * `client_name`, so an emulator has to replay these strings byte-exactly.
 * Recorded as observation, not endorsement.
 */
export type DcrIdentityUsage = {
  clientName: Observation<string>;
  /**
   * Redirect URIs with loopback ports placeheld as `{port}`, so an emulator on
   * an ephemeral port still diffs clean against a real host on a different one.
   */
  redirectUris: Observation<string[]>;
  /**
   * The loopback ports actually seen, kept because the port RANGE is a real
   * per-host fact that the `{port}` placeholder would otherwise destroy — Cline
   * scans 1456–1461, Codex takes an ephemeral port, VS Code registers fixed
   * ones. Redirect URIs carry no secret, so retaining these is safe.
   *
   * Reported as diff CONTEXT, never as a parity difference: two runs of the same
   * client legitimately differ here.
   */
  observedLoopbackPorts: Observation<number[]>;
  grantTypes: Observation<string[]>;
  responseTypes: Observation<string[]>;
  tokenEndpointAuthMethod: Observation<string>;
  scope: Observation<string>;
  /**
   * Fields present in the register body that this schema does not model, so an
   * unmodeled-but-real field shows up as a diff instead of vanishing. Durability
   * over convenience.
   *
   * Keys AND VALUES, in sorted-key order. Names alone would report two bodies
   * that differ only in the VALUE of an unmodeled field as parity, which
   * contradicts the field-by-field DCR-body diff this schema advertises. The
   * values are the ones already redacted and origin-substituted by
   * `./normalize.js` at capture time — retaining them here adds no exposure that
   * `wire` does not already carry.
   */
  extraFields: Observation<Record<string, unknown>>;
  /**
   * Modeled fields that WERE in the register body but carried the wrong JSON
   * type (`client_name: 42`, `redirect_uris: "…"`).
   *
   * Kept as a separate list rather than by widening {@link Observation} with a
   * fourth `malformed` arm: the tri-state is the load-bearing invariant of this
   * whole schema and every consumer switches exhaustively on it. The malformed
   * field's own observation is `not-observed` with the observed JSON type named
   * as the reason — because the modeled VALUE genuinely is unknown to us — while
   * this list carries the positive, diffable fact that the client did send
   * something. Reporting the field as `absent` instead would let the oracle claim
   * the client omitted a field it demonstrably sent.
   */
  malformedFields: Observation<string[]>;
};

export type PkceUsage = {
  /** `code_challenge_method`, e.g. `S256`. */
  challengeMethod: Observation<string>;
  /** Length of the `code_challenge`, retained after the value is placeheld. */
  challengeLength: Observation<number>;
  /** Whether a `code_verifier` appeared on the token request. */
  verifierSentOnToken: Observation<boolean>;
};

export type UserAgentUsage = {
  /**
   * Distinct `user-agent` values per leg, first-appearance order.
   *
   * Partial by the same invariant as {@link ProtocolVersionUsage.headerByLeg}: a
   * missing key means `not-observed`, never "no finding".
   */
  byLeg: Partial<Record<TraceLeg, Observation<string[]>>>;
  /**
   * Whether every captured leg carried the SAME user-agent. Goose is the open
   * case: its `goose/{ver}` UA is verified on the MCP transport, but whether it
   * reaches the authorization server is not — because `rmcp` may build its own
   * HTTP client. A per-leg map plus this flag settles that in one capture.
   *
   * `present` only when EVERY leg in the trace had observed request headers. A
   * browser-driven `/authorize` is reconstructed from a URL
   * (`headersObserved === false`), so its user-agent belongs to the browser and
   * was never on a wire we recorded; a boolean would nonetheless claim a
   * consistency verdict over it, and then "differ" from a proxy capture that did
   * see the browser's headers.
   */
  consistent: Observation<boolean>;
};

/**
 * Diff-relevant facts derived from {@link TraceExchange}[]. Everything here is
 * recomputable from `wire`, and is stored so a reviewer reads conclusions
 * without re-deriving them — and so a drift check can diff the summary cheaply.
 */
export type TraceObservations = {
  /** Legs in the order they first appeared. Ordering is a finding. */
  legOrder: TraceLeg[];
  /** Normalized request URLs, deduped, first-appearance order preserved. */
  endpointsHit: string[];
  /**
   * Well-known paths tried, in order. Path-aware-then-root ladder ordering is a
   * real behavioral difference between clients.
   */
  discoveryLadder: string[];
  userAgent: UserAgentUsage;
  resourceIndicator: ResourceIndicatorUsage;
  protocolVersion: ProtocolVersionUsage;
  dcrIdentity: DcrIdentityUsage;
  pkce: PkceUsage;
};

// ── The trace ────────────────────────────────────────────────────────────

export type GoldenTrace = {
  traceVersion: typeof GOLDEN_TRACE_VERSION;
  /**
   * Stable identity: `<hostId>/<scenarioId>/<capturedAt>`. Deterministic so a
   * re-capture on the same day overwrites rather than accumulating duplicates,
   * and so HP-38's drift check has a stable key.
   */
  traceId: string;
  subject: TraceSubject;
  scenario: TraceScenario;
  capture: TraceCaptureMeta;
  /** The normalized handshake, in capture order. */
  wire: TraceExchange[];
  /** Derived summary — see {@link TraceObservations}. */
  observations: TraceObservations;
};

// ── Diff ─────────────────────────────────────────────────────────────────

/**
 * Diff dimensions, matching the field-by-field axes HP-44 requires:
 * request ordering, endpoints hit, params present/absent, headers, DCR body.
 * `subject` and `scenario` are added because a diff whose two sides disagree
 * about WHAT was captured is not a behavioral finding at all.
 */
export const TRACE_DIFF_DIMENSIONS = [
  "scenario",
  "subject",
  "request-ordering",
  "endpoints",
  "params",
  "headers",
  "dcr-body",
  "protocol-version",
  "resource-indicator",
  "pkce",
  "user-agent",
] as const;

export type TraceDiffDimension = (typeof TRACE_DIFF_DIMENSIONS)[number];

export const TRACE_DIFF_MODES = ["parity", "drift"] as const;

/**
 * What kind of comparison a diff is.
 *
 *   `parity` — emulator vs real host. Subject metadata differences are expected.
 *   `drift`  — the SAME subject captured twice (HP-38). Subject metadata
 *              differences ARE the finding, and there is no emulator on either
 *              side.
 */
export type TraceDiffMode = (typeof TRACE_DIFF_MODES)[number];

/**
 * What to call the two sides in prose, resolved once from the mode.
 *
 * A single source for BOTH the differ's messages and the renderer's headings.
 * With the labels hardcoded, a `drift` diff of two real-host captures was
 * reported as "real host" versus "emulator" throughout — blaming an emulator that
 * was never involved, which is a fabricated finding of exactly the kind this
 * schema exists to prevent.
 */
export type TraceDiffLabels = {
  golden: string;
  candidate: string;
};

/**
 * Severity of one finding.
 *
 *   `match`        — both sides observed the same thing.
 *   `difference`   — both sides observed, and they DISAGREE. The only severity
 *                    that is evidence of an emulator bug.
 *   `gap`          — at least one side did not observe the leg, so the fields
 *                    are not comparable. Reported loudly and never counted as
 *                    a pass; this is the "unverifiable, here's the blocker"
 *                    output the harness is required to produce.
 *   `incomparable` — the two traces are not of the same experiment (different
 *                    scenario or different host), so no field-level comparison
 *                    is meaningful.
 */
export const TRACE_DIFF_SEVERITIES = [
  "match",
  "difference",
  "gap",
  "incomparable",
] as const;

export type TraceDiffSeverity = (typeof TRACE_DIFF_SEVERITIES)[number];

export type TraceDiffFinding = {
  /** Dotted path into the trace, e.g. `observations.resourceIndicator.onToken`. */
  path: string;
  dimension: TraceDiffDimension;
  severity: TraceDiffSeverity;
  /** One-line statement of the finding, phrased for a reviewer. */
  message: string;
  /** Rendered golden-side value (or the reason it is missing). */
  golden?: unknown;
  /** Rendered candidate-side value (or the reason it is missing). */
  candidate?: unknown;
};

export type TraceDiffResult = {
  /**
   * True only when there are zero `difference` and zero `incomparable`
   * findings. `gap` findings do NOT fail parity — an unobserved leg is not
   * evidence of divergence — but they are counted separately and a caller that
   * needs full coverage should assert `gaps === 0` as well.
   */
  parity: boolean;
  goldenTraceId: string;
  candidateTraceId: string;
  /** Which comparison this was, resolved from the option or the two subjects. */
  mode: TraceDiffMode;
  /**
   * The side labels every message in {@link TraceDiffResult.findings} was phrased
   * with, carried so the renderer cannot contradict them. See
   * {@link TraceDiffLabels}.
   */
  labels: TraceDiffLabels;
  counts: Record<TraceDiffSeverity, number>;
  findings: TraceDiffFinding[];
  /** Human summary line, e.g. `3 differences, 2 gaps across 41 comparisons`. */
  summary: string;
};
