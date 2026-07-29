/**
 * HP-44 — leg classification and observation derivation.
 *
 * Turns a normalized wire into the diff-relevant summary a reviewer reads.
 * Everything here is a pure function of `wire` + `scenario`, so a trace's
 * `observations` block can always be regenerated and checked against what was
 * committed (see `assertObservationsAreDerived`).
 *
 * The single rule that governs every function below: a field is `absent` ONLY
 * when the leg that would carry it WAS captured and the field was not on it.
 * If the leg is missing from the trace, every field it would have carried is
 * `not-observed` with the leg named as the reason. Getting this backwards is how
 * "we didn't look" becomes "the client doesn't do it", which is the specific
 * error this whole harness exists to prevent.
 */

import {
  MCP_WIRE_LEGS,
  OAUTH_DISCOVERY_LEGS,
  absent,
  notObserved,
  observedValue,
  present,
} from "./types.js";
import type {
  DcrIdentityUsage,
  GoldenTrace,
  Observation,
  PkceUsage,
  ProtocolVersionUsage,
  ResourceIndicatorUsage,
  ResourceIndicatorValueSource,
  TraceBody,
  TraceExchange,
  TraceLeg,
  TraceObservations,
  TraceScenario,
  UserAgentUsage,
} from "./types.js";
import { buildOriginMap, normalizeLoopbackPort } from "./normalize.js";
import type { OriginPlaceholders } from "./normalize.js";

// ── Leg classification ───────────────────────────────────────────────────

/**
 * `OAuthFlowStep` → {@link TraceLeg}.
 *
 * Preferred over URL heuristics whenever available: for an emulator capture the
 * state machine already knows which leg it is on, and a heuristic that
 * disagrees with the machine would be recording our guess about our own code.
 * Steps that produce no HTTP request map to `undefined`.
 */
const STEP_TO_LEG: Record<string, TraceLeg | undefined> = {
  idle: undefined,
  request_without_token: "mcp-unauthenticated",
  received_401_unauthorized: "mcp-unauthenticated",
  // 2025-03-26 starts discovery at the AS metadata document derived from the
  // MCP server origin — there is no PRM rung on that revision.
  discovery_start: "as-metadata-discovery",
  request_resource_metadata: "prm-discovery",
  received_resource_metadata: "prm-discovery",
  request_authorization_server_metadata: "as-metadata-discovery",
  received_authorization_server_metadata: "as-metadata-discovery",
  cimd_prepare: "cimd-fetch",
  cimd_fetch_request: "cimd-fetch",
  cimd_metadata_response: "cimd-fetch",
  request_client_registration: "dcr-register",
  received_client_credentials: "dcr-register",
  generate_pkce_parameters: undefined,
  authorization_request: "authorize",
  received_authorization_code: "authorize",
  token_request: "token",
  received_access_token: "token",
  // This step sends an `initialize` WITH the bearer token, so it is the real
  // handshake — the same classification `classifyLeg` gives the identical request
  // from a HAR. Keeping the two capture paths in agreement is what lets an
  // emulator trace be diffed against a proxy trace at all.
  authenticated_mcp_request: "mcp-initialize",
  complete: undefined,
  // Post-handshake authenticated traffic, which is a different leg from the
  // handshake itself.
  verify_list_tools: "mcp-authenticated",
  verify_call_tool: "mcp-authenticated",
};

export function legForOAuthFlowStep(step: string): TraceLeg | undefined {
  return STEP_TO_LEG[step];
}

export type LegClassificationInput = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: TraceBody;
  /** The MCP server URL, so MCP-wire traffic can be recognized. */
  mcpServerUrl?: string;
};

function headerLookup(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function formField(body: TraceBody | undefined, key: string): string | undefined {
  if (body?.encoding !== "form") return undefined;
  return body.fields[key]?.[0];
}

function jsonRpcMethod(body: TraceBody | undefined): string | undefined {
  if (!body) return undefined;
  if (body.encoding === "jsonrpc") {
    if (body.method) return body.method;
    const json = body.json;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const method = (json as Record<string, unknown>).method;
      if (typeof method === "string") return method;
    }
  }
  if (body.encoding === "json") {
    const json = body.json;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      if (record.jsonrpc === "2.0" && typeof record.method === "string") {
        return record.method;
      }
    }
  }
  return undefined;
}

/**
 * Classify a request into a leg from its wire shape alone.
 *
 * This is the HAR path — a proxy capture has no state-machine context, only
 * bytes. Rules are ordered most-specific first, and the returned `basis` names
 * the rule that fired so a misclassification is debuggable rather than
 * mysterious.
 */
export function classifyLeg(
  input: LegClassificationInput,
): { leg: TraceLeg; basis: string } {
  const method = input.method.toUpperCase();
  let path = input.url;
  let search = "";
  try {
    const parsed = new URL(input.url);
    path = parsed.pathname;
    search = parsed.search;
  } catch {
    const queryStart = input.url.indexOf("?");
    if (queryStart >= 0) {
      path = input.url.slice(0, queryStart);
      search = input.url.slice(queryStart);
    }
  }

  if (path.includes("/.well-known/oauth-protected-resource")) {
    return { leg: "prm-discovery", basis: "well-known path: oauth-protected-resource" };
  }
  if (
    path.includes("/.well-known/oauth-authorization-server") ||
    path.includes("/.well-known/openid-configuration")
  ) {
    return {
      leg: "as-metadata-discovery",
      basis: "well-known path: authorization-server metadata",
    };
  }
  if (
    path.includes("client-id-metadata") ||
    path.includes("client-metadata") ||
    /client[-_]?metadata\.json$/.test(path)
  ) {
    return { leg: "cimd-fetch", basis: "path names a client-id metadata document" };
  }

  const grantType = formField(input.body, "grant_type");
  if (grantType === "refresh_token") {
    return { leg: "refresh", basis: "form body grant_type=refresh_token" };
  }
  if (grantType) {
    return { leg: "token", basis: `form body grant_type=${grantType}` };
  }

  if (method === "POST" && /\/register\b/.test(path)) {
    return { leg: "dcr-register", basis: "POST to a /register path" };
  }
  // A DCR body is recognizable without the path: RFC 7591 requires
  // `redirect_uris`, and no other leg posts `client_name`.
  if (method === "POST" && input.body?.encoding === "json") {
    const json = input.body.json;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      if ("redirect_uris" in record || "client_name" in record) {
        return { leg: "dcr-register", basis: "JSON body has RFC 7591 registration fields" };
      }
    }
  }

  if (/\/authorize\b/.test(path) || /[?&]response_type=/.test(search)) {
    return { leg: "authorize", basis: "authorize path or response_type param" };
  }
  if (/\/token\b/.test(path)) {
    return { leg: "token", basis: "token path" };
  }

  const rpcMethod = jsonRpcMethod(input.body);
  if (rpcMethod) {
    const authorization = headerLookup(input.headers, "authorization");
    // Auth state is checked BEFORE the method name. An `initialize` sent without
    // a token is the unauthenticated PROBE, not the handshake — and whether a
    // client probes first and falls back to OAuth on a 401 (Goose) or authorizes
    // up front (Claude, ChatGPT) is one of the orderings this harness compares.
    // Classifying the probe as `mcp-initialize` would erase that distinction.
    if (!authorization) {
      return {
        leg: "mcp-unauthenticated",
        basis: `JSON-RPC ${rpcMethod}, no Authorization`,
      };
    }
    return rpcMethod === "initialize"
      ? { leg: "mcp-initialize", basis: "authenticated JSON-RPC method=initialize" }
      : { leg: "mcp-authenticated", basis: `JSON-RPC ${rpcMethod} with Authorization` };
  }

  if (input.mcpServerUrl && input.url.startsWith(input.mcpServerUrl)) {
    const authorization = headerLookup(input.headers, "authorization");
    return authorization
      ? { leg: "mcp-authenticated", basis: "MCP server URL with Authorization" }
      : { leg: "mcp-unauthenticated", basis: "MCP server URL, no Authorization" };
  }

  return { leg: "unknown", basis: "no classification rule matched" };
}

// ── Small observation helpers ────────────────────────────────────────────

function distinct(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}

function exchangesForLeg(
  wire: readonly TraceExchange[],
  legs: readonly TraceLeg[],
): TraceExchange[] {
  return wire.filter((exchange) => legs.includes(exchange.leg));
}

/**
 * Collect the distinct values of one request header across a set of legs.
 *
 * The three-way return is the whole discipline: no exchanges on those legs ⇒
 * `not-observed`; exchanges present but none carried the header ⇒ `absent`
 * (a positive finding); otherwise `present` with the distinct values.
 */
function observeRequestHeader(
  wire: readonly TraceExchange[],
  legs: readonly TraceLeg[],
  header: string,
  legLabel: string,
): Observation<string[]> {
  const exchanges = exchangesForLeg(wire, legs);
  if (exchanges.length === 0) {
    return notObserved(`no ${legLabel} request was captured in this trace`);
  }

  // Requests whose headers were never seen (a browser-driven `/authorize`)
  // cannot contribute an `absent` verdict — they contribute nothing at all.
  const observable = exchanges.filter(
    (exchange) => exchange.request.headersObserved !== false,
  );
  if (observable.length === 0) {
    return notObserved(
      `the ${legLabel} request was reconstructed rather than intercepted, so its headers were never on the wire we recorded`,
    );
  }

  const values = observable
    .map((exchange) => headerLookup(exchange.request.headers, header))
    .filter((value): value is string => value != null && value !== "");
  return values.length === 0 ? absent : present(distinct(values));
}

// ── Resource indicator ───────────────────────────────────────────────────

function observeResourceParam(
  wire: readonly TraceExchange[],
  leg: TraceLeg,
  legLabel: string,
): Observation<string[]> {
  const exchanges = exchangesForLeg(wire, [leg]);
  if (exchanges.length === 0) {
    return notObserved(`no ${legLabel} request was captured in this trace`);
  }

  const values: string[] = [];
  for (const exchange of exchanges) {
    // `resource` can arrive as a query param (authorize) or a form field
    // (token/refresh), and can legitimately appear more than once.
    values.push(...(exchange.request.query?.resource ?? []));
    if (exchange.request.body?.encoding === "form") {
      values.push(...(exchange.request.body.fields.resource ?? []));
    }
  }

  return values.length === 0 ? absent : present(values);
}

/**
 * Classify WHICH url the `resource` value corresponds to.
 *
 * Comparison targets are normalized through the same origin map as the wire, or
 * the placeheld wire value could never match a raw configured URL. Claude and
 * ChatGPT send the canonicalized MCP server URL; VS Code sends the PRM
 * document's own `resource`. When the scenario makes those two identical the
 * result is `mcp-server-url`, and the differ treats a
 * `mcp-server-url`/`prm-resource` disagreement under that condition as
 * indistinguishable rather than as a difference.
 */
function classifyResourceValueSource(
  observed: Observation<string[]>,
  scenario: TraceScenario,
  origins: OriginPlaceholders,
): Observation<ResourceIndicatorValueSource> {
  const values = observedValue(observed);
  if (!values || values.length === 0) {
    if (observed.state === "absent") return absent;
    return notObserved(
      "no `resource` value was observed, so its source cannot be classified",
    );
  }

  const originMap = buildOriginMap(origins);
  const substitute = (raw: string): string => {
    let out = normalizeLoopbackPort(raw);
    for (const [name, origin] of originMap) {
      if (out.includes(origin)) out = out.split(origin).join(name);
    }
    return out.replace(/\/$/, "");
  };

  const value = values[0].replace(/\/$/, "");
  const serverUrl = substitute(scenario.mcpServerUrl);
  const prmResource = scenario.capabilities.prmResource
    ? substitute(scenario.capabilities.prmResource)
    : undefined;

  if (value === serverUrl) return present("mcp-server-url");
  if (prmResource && value === prmResource) return present("prm-resource");
  return present("other");
}

function observeResourceIndicator(
  wire: readonly TraceExchange[],
  scenario: TraceScenario,
  origins: OriginPlaceholders,
): ResourceIndicatorUsage {
  const onAuthorize = observeResourceParam(wire, "authorize", "/authorize");
  const onToken = observeResourceParam(wire, "token", "/token");
  const onRefresh = observeResourceParam(wire, "refresh", "token-refresh");

  // Classify from whichever leg actually carried a value; authorize first
  // because it is the leg captured most often.
  const carrier =
    observedValue(onAuthorize) ? onAuthorize
    : observedValue(onToken) ? onToken
    : observedValue(onRefresh) ? onRefresh
    : onAuthorize.state === "absent" || onToken.state === "absent"
      ? absent
      : onAuthorize;

  return {
    onAuthorize,
    onToken,
    onRefresh,
    valueSource: classifyResourceValueSource(carrier, scenario, origins),
  };
}

// ── Protocol version ─────────────────────────────────────────────────────

function observeInitializeBodyVersion(
  wire: readonly TraceExchange[],
): Observation<string> {
  const exchanges = wire.filter(
    (exchange) => jsonRpcMethod(exchange.request.body) === "initialize",
  );
  if (exchanges.length === 0) {
    return notObserved("no MCP `initialize` request was captured in this trace");
  }

  for (const exchange of exchanges) {
    const body = exchange.request.body;
    if (!body || (body.encoding !== "jsonrpc" && body.encoding !== "json")) continue;
    const json = body.json;
    if (!json || typeof json !== "object" || Array.isArray(json)) continue;
    const params = (json as Record<string, unknown>).params;
    if (!params || typeof params !== "object" || Array.isArray(params)) continue;
    const version = (params as Record<string, unknown>).protocolVersion;
    if (typeof version === "string") return present(version);
  }

  return absent;
}

function observeProtocolVersion(
  wire: readonly TraceExchange[],
): ProtocolVersionUsage {
  const headerByLeg: ProtocolVersionUsage["headerByLeg"] = {};
  const legsPresent = distinct(wire.map((exchange) => exchange.leg)) as TraceLeg[];
  for (const leg of legsPresent) {
    headerByLeg[leg] = observeRequestHeader(
      wire,
      [leg],
      "mcp-protocol-version",
      `${leg}`,
    );
  }

  const headerOnOAuthDiscovery = observeRequestHeader(
    wire,
    OAUTH_DISCOVERY_LEGS,
    "mcp-protocol-version",
    "OAuth discovery",
  );
  const headerOnMcpTraffic = observeRequestHeader(
    wire,
    MCP_WIRE_LEGS,
    "mcp-protocol-version",
    "MCP-wire",
  );
  const initializeBody = observeInitializeBodyVersion(wire);

  // Two wires "disagree" when both were captured and either they carry different
  // value sets, or one carries a value and the other demonstrably carries none.
  // If either side is `not-observed` we cannot claim disagreement — that is a
  // gap, and the differ reports it as one.
  const oauthValues = observedValue(headerOnOAuthDiscovery);
  const mcpValues = observedValue(headerOnMcpTraffic);
  const bothCaptured =
    headerOnOAuthDiscovery.state !== "not-observed" &&
    headerOnMcpTraffic.state !== "not-observed";
  const wiresDisagree =
    bothCaptured &&
    JSON.stringify(oauthValues ?? null) !== JSON.stringify(mcpValues ?? null);

  const bodyVersion = observedValue(initializeBody);
  const allHeaderValues = distinct([...(oauthValues ?? []), ...(mcpValues ?? [])]);
  const headerDisagreesWithInitializeBody =
    bodyVersion != null &&
    allHeaderValues.length > 0 &&
    allHeaderValues.some((value) => value !== bodyVersion);

  return {
    initializeBody,
    headerByLeg,
    headerOnOAuthDiscovery,
    headerOnMcpTraffic,
    wiresDisagree,
    headerDisagreesWithInitializeBody,
  };
}

// ── DCR identity ─────────────────────────────────────────────────────────

const MODELLED_DCR_FIELDS = new Set([
  "client_name",
  "redirect_uris",
  "grant_types",
  "response_types",
  "token_endpoint_auth_method",
  "scope",
]);

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : undefined;
}

function observeDcrIdentity(wire: readonly TraceExchange[]): DcrIdentityUsage {
  const registrations = exchangesForLeg(wire, ["dcr-register"]);
  const gap = <T>(field: string): Observation<T> =>
    notObserved(
      `no dynamic client registration request was captured, so ${field} is unknown`,
    );

  if (registrations.length === 0) {
    return {
      clientName: gap("client_name"),
      redirectUris: gap("redirect_uris"),
      observedLoopbackPorts: gap("loopback redirect ports"),
      grantTypes: gap("grant_types"),
      responseTypes: gap("response_types"),
      tokenEndpointAuthMethod: gap("token_endpoint_auth_method"),
      scope: gap("scope"),
      extraFields: gap("unmodelled registration fields"),
    };
  }

  const body = registrations[0].request.body;
  const record =
    body?.encoding === "json" && body.json && typeof body.json === "object" && !Array.isArray(body.json)
      ? (body.json as Record<string, unknown>)
      : undefined;

  if (!record) {
    const reason =
      "a registration request was captured but its body was not structured JSON";
    return {
      clientName: notObserved(reason),
      redirectUris: notObserved(reason),
      observedLoopbackPorts: notObserved(reason),
      grantTypes: notObserved(reason),
      responseTypes: notObserved(reason),
      tokenEndpointAuthMethod: notObserved(reason),
      scope: notObserved(reason),
      extraFields: notObserved(reason),
    };
  }

  const scalar = (key: string): Observation<string> => {
    const value = record[key];
    return typeof value === "string" ? present(value) : absent;
  };
  const list = (key: string): Observation<string[]> => {
    const value = stringArray(record[key]);
    return value ? present(value) : absent;
  };

  // Redirect URIs in the wire are already `{port}`-normalized, so the raw ports
  // are unrecoverable here BY DESIGN — that is what makes the diff robust across
  // runs. The capture paths, which still hold the pre-normalization URIs, inject
  // them via `withObservedLoopbackPorts`. `absent` is therefore the correct
  // derived value: nothing in the normalized wire carries a port.
  const redirectUris = list("redirect_uris");

  const extras = Object.keys(record)
    .filter((key) => !MODELLED_DCR_FIELDS.has(key))
    .sort();

  return {
    clientName: scalar("client_name"),
    redirectUris,
    observedLoopbackPorts: absent,
    grantTypes: list("grant_types"),
    responseTypes: list("response_types"),
    tokenEndpointAuthMethod: scalar("token_endpoint_auth_method"),
    scope: scalar("scope"),
    extraFields: extras.length > 0 ? present(extras) : absent,
  };
}

/**
 * Re-attach loopback ports that normalization stripped.
 *
 * Called by the capture paths, which still hold the pre-normalization redirect
 * URIs. Kept separate from `deriveObservations` so the derivation stays a pure
 * function of the normalized trace — otherwise `assertObservationsAreDerived`
 * could not check a committed trace against its own wire.
 */
export function withObservedLoopbackPorts(
  observations: TraceObservations,
  ports: readonly number[],
): TraceObservations {
  return {
    ...observations,
    dcrIdentity: {
      ...observations.dcrIdentity,
      observedLoopbackPorts:
        observations.dcrIdentity.redirectUris.state === "not-observed"
          ? observations.dcrIdentity.observedLoopbackPorts
          : ports.length > 0
            ? present([...ports])
            : absent,
    },
  };
}

// ── PKCE ─────────────────────────────────────────────────────────────────

function parsePlaceholderLength(value: string): number | undefined {
  const match = /len=(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function observePkce(wire: readonly TraceExchange[]): PkceUsage {
  const authorize = exchangesForLeg(wire, ["authorize"]);
  const token = exchangesForLeg(wire, ["token"]);

  const challengeMethod: Observation<string> =
    authorize.length === 0
      ? notObserved("no /authorize request was captured in this trace")
      : (() => {
          const value = authorize
            .flatMap((exchange) => exchange.request.query?.code_challenge_method ?? [])
            .at(0);
          return value ? present(value) : absent;
        })();

  const challengeLength: Observation<number> =
    authorize.length === 0
      ? notObserved("no /authorize request was captured in this trace")
      : (() => {
          const raw = authorize
            .flatMap((exchange) => exchange.request.query?.code_challenge ?? [])
            .at(0);
          if (!raw) return absent;
          const length = parsePlaceholderLength(raw) ?? raw.length;
          return present(length);
        })();

  const verifierSentOnToken: Observation<boolean> =
    token.length === 0
      ? notObserved("no /token request was captured in this trace")
      : present(
          token.some(
            (exchange) =>
              exchange.request.body?.encoding === "form" &&
              exchange.request.body.fields.code_verifier != null,
          ),
        );

  return { challengeMethod, challengeLength, verifierSentOnToken };
}

// ── User agent ───────────────────────────────────────────────────────────

function observeUserAgent(wire: readonly TraceExchange[]): UserAgentUsage {
  const byLeg: UserAgentUsage["byLeg"] = {};
  const legsPresent = distinct(wire.map((exchange) => exchange.leg)) as TraceLeg[];
  for (const leg of legsPresent) {
    byLeg[leg] = observeRequestHeader(wire, [leg], "user-agent", `${leg}`);
  }

  const observable = wire.filter(
    (exchange) => exchange.request.headersObserved !== false,
  );
  const allValues = distinct(
    observable
      .map((exchange) => headerLookup(exchange.request.headers, "user-agent"))
      .filter((value): value is string => value != null && value !== ""),
  );
  const legsWithoutUa = legsPresent.filter((leg) => byLeg[leg]?.state === "absent");

  // Uniformly-absent counts as consistent. MCPJam's own OAuth runs in a browser,
  // where scripts are FORBIDDEN from setting `User-Agent` — there is no value to
  // capture, which the HP-47 sweep classified as structurally N/A rather than as a
  // gap. Calling that "inconsistent" would report a browser restriction as a
  // client quirk. Only a genuine MIX — some legs carrying a UA and some not, or
  // two different values — is inconsistent.
  return {
    byLeg,
    consistent:
      allValues.length === 0
        ? true
        : allValues.length === 1 && legsWithoutUa.length === 0,
  };
}

// ── Discovery ladder ─────────────────────────────────────────────────────

function observeDiscoveryLadder(wire: readonly TraceExchange[]): string[] {
  const paths: string[] = [];
  for (const exchange of wire) {
    if (!OAUTH_DISCOVERY_LEGS.includes(exchange.leg)) continue;
    let path = exchange.request.url;
    try {
      path = new URL(exchange.request.url).pathname;
    } catch {
      const queryStart = path.indexOf("?");
      if (queryStart >= 0) path = path.slice(0, queryStart);
      const schemeEnd = path.indexOf("}");
      if (schemeEnd >= 0) path = path.slice(schemeEnd + 1);
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Derive the full observation summary from a normalized wire.
 *
 * Pure: same wire + same scenario ⇒ same observations, byte for byte. That is
 * what lets a committed trace be re-verified rather than trusted.
 */
export function deriveObservations(input: {
  wire: readonly TraceExchange[];
  scenario: TraceScenario;
}): TraceObservations {
  const { wire, scenario } = input;
  const origins: OriginPlaceholders = {
    mcpServerUrl: scenario.mcpServerUrl,
    authorizationServerUrl: scenario.authorizationServerUrl,
  };

  return {
    legOrder: distinct(wire.map((exchange) => exchange.leg)) as TraceLeg[],
    endpointsHit: distinct(wire.map((exchange) => exchange.request.url.split("?")[0])),
    discoveryLadder: observeDiscoveryLadder(wire),
    userAgent: observeUserAgent(wire),
    resourceIndicator: observeResourceIndicator(wire, scenario, origins),
    protocolVersion: observeProtocolVersion(wire),
    dcrIdentity: observeDcrIdentity(wire),
    pkce: observePkce(wire),
  };
}

/**
 * Verify a trace's stored `observations` still match what its `wire` implies.
 *
 * Guards the durability property: a hand-edited or half-migrated trace is caught
 * by a test instead of quietly skewing a parity result. `observedLoopbackPorts`
 * is excluded because it is injected from pre-normalization data that the wire
 * no longer carries.
 */
export function findObservationDrift(trace: GoldenTrace): string[] {
  const derived = deriveObservations({
    wire: trace.wire,
    scenario: trace.scenario,
  });

  const strip = (observations: TraceObservations): unknown => ({
    ...observations,
    dcrIdentity: {
      ...observations.dcrIdentity,
      observedLoopbackPorts: undefined,
    },
  });

  const expected = JSON.stringify(strip(derived));
  const actual = JSON.stringify(strip(trace.observations));
  if (expected === actual) return [];

  const drift: string[] = [];
  for (const key of Object.keys(derived) as Array<keyof TraceObservations>) {
    const left = JSON.stringify(
      key === "dcrIdentity"
        ? { ...derived.dcrIdentity, observedLoopbackPorts: undefined }
        : derived[key],
    );
    const right = JSON.stringify(
      key === "dcrIdentity"
        ? { ...trace.observations.dcrIdentity, observedLoopbackPorts: undefined }
        : trace.observations[key],
    );
    if (left !== right) {
      drift.push(`observations.${key}: stored ${right} but wire implies ${left}`);
    }
  }
  return drift;
}
