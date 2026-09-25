/**
 * Strip the open-versus-closed differential out of a HOSTED doctor result, and
 * reduce everything the target answered to an allowlisted projection (MJ-001).
 *
 * ITS OWN MODULE, and that is not tidiness. This is a pure function over an
 * envelope, but it used to live in `routes/web/servers.ts` — so a test for it
 * had to import the whole route, and the route's dependency graph grew until
 * that import alone blew a 30s test timeout. Nothing here needs a route.
 */

import { HOSTED_MODE } from "../config.js";
import {
  boundHeaderValue,
  boundText,
  formatStatusLine,
  isPlainRecord,
  parseHttpStatus,
  parseHttpUrl,
  parseProtocolVersion,
  projectAuthorizationServerMetadata,
  projectProbeAttempt,
  projectResourceMetadata,
  projectServerCapabilities,
  projectServerIdentity,
} from "./hosted-upstream-projection.js";

/**
 * One uniform message for every failure that never got an HTTP response.
 *
 * Deliberately says nothing about WHY. `connect ECONNREFUSED 127.0.0.1:6379`
 * and `tls_get_more_records:packet length too long` are the same fact to the
 * person debugging their own server — the inspector could not talk to it — and
 * two different facts to someone walking a port range, which is what made them
 * the finding's Scenario B port scanner.
 */
export const HOSTED_TRANSPORT_FAILURE_DETAIL =
  "The inspector could not establish a connection to this server.";

/**
 * The one error code every redacted failure collapses to.
 *
 * `normalizeServerDoctorError` derives the code from the raw message by
 * substring, so the code is the message's oracle in miniature: a refused
 * connect matches `econn` and becomes `SERVER_UNREACHABLE`, an open cleartext
 * port's TLS record error matches nothing and becomes `INTERNAL_ERROR`, and a
 * filtered port times out and becomes `TIMEOUT`. Rewriting only the message
 * left those three outcomes as distinguishable as before.
 */
const HOSTED_TRANSPORT_FAILURE_CODE = "SERVER_UNREACHABLE";

/**
 * Strip the open-versus-closed differential out of a HOSTED doctor result.
 *
 * WHAT THIS IS FOR. The pinned transport above stops the private target being
 * REACHED. It does not, on its own, stop the attempt describing what it found:
 * `normalizeServerDoctorError` copies the raw transport message onto
 * `connection.detail`, `checks.connection.detail` and `error.message`, and the
 * probe copies it onto `attempts[].error`. OAuth discovery adds one more:
 * `oauth.discoveryError` is the failure of a fetch to a host the TARGET named
 * in its own `WWW-Authenticate` challenge, so it is a second origin, chosen
 * separately from the server URL, and the same port oracle pointed at it.
 * `bench-probe-child` copies that string onto a user-visible check detail.
 *
 * THE TEST IS STRUCTURAL, NOT A PATTERN LIST. A denylist of socket-error
 * spellings leaks the first time undici renames one. Instead: an attempt that
 * received no response got no further than the socket, so what it says can only
 * be describing a socket, DNS or TLS outcome — and it is replaced wholesale. An
 * attempt that did receive one is reported through the projection below rather
 * than as it arrived. That reasoning is per attempt, so the decision is too: a
 * target whose first transport answers and whose second is refused at the
 * socket used to have the second one's message pass through with the first's.
 *
 * THE ENVELOPE-LEVEL FIELDS TAKE THE STRICTER GATE. `probe.error`,
 * `connection.detail`, `checks[].detail`, `error` and `oauth.discoveryError`
 * summarise the whole run and name no attempt, so a mixed run cannot be
 * resolved per attempt and the summary may well be quoting the refused hop.
 * They survive only when every recorded attempt received a response AND the
 * doctor's connect leg did not fail. That second condition is not redundant:
 * the connect leg runs after the probe, records no attempt of its own, and
 * writes its raw transport error onto `connection.detail`,
 * `checks.connection.detail` and `error` — so a target that answers the probe
 * cleanly and then redirects the connect elsewhere had its socket outcome
 * reflected verbatim under an attempts-only test. A run that recorded no
 * attempt at all offers no proof either and is redacted with the rest.
 *
 * `error.code` GOES WITH `error.message`. It is derived from that message by
 * substring match, so leaving it behind kept the differential the message lost;
 * whenever the message is replaced the code collapses too.
 *
 * `attempts[].durationMs` IS THE SAME ORACLE WITH A STOPWATCH. A refused port
 * returns in about a millisecond and a filtered one burns the whole timeout, so
 * the number separates the outcomes the message no longer does. An attempt that
 * received a response keeps its real duration — the host is demonstrably open,
 * so the timing discloses nothing and is the latency figure the doctor exists
 * to report. An attempt whose error was replaced never got past the socket, so
 * it collapses to the 0 the probe already writes for an attempt it never
 * dialled.
 *
 * An egress refusal keeps its own message: `classifyPinnedTransportError`
 * already phrases it without the address the hostname resolved to, so it is a
 * verdict about the target rather than a resolution oracle, and telling someone
 * their URL is not publicly routable is the one detail that helps them.
 *
 * WHAT AN ANSWER MAY SAY. Once the socket outcomes are settled, the whole
 * envelope is rebuilt from an allowlist ({@link projectHostedDoctorResult}):
 * every answered attempt keeps its status, a bounded status text and the
 * allowlisted headers, with its body omitted and — where the diagnostic needs
 * protocol data — a validated projection beside it; the OAuth metadata and the
 * connected server's initialize data are projected the same way; and every
 * summary string is either one this code or the SDK wrote, with numbers and
 * bounded status text as its only variable parts, or a fixed replacement.
 *
 * A no-op outside hosted mode. Locally the socket error is the answer — a
 * developer whose server is not running needs to be told `ECONNREFUSED` — and
 * the raw response is what a local debugging session is for.
 */
export function redactHostedDoctorTransportDetail<T>(result: T): T {
  if (!HOSTED_MODE) return result;
  redactSocketOutcomes(result);
  return projectHostedDoctorResult(result) as T;
}

/** The transport-failure half of {@link redactHostedDoctorTransportDetail}. */
function redactSocketOutcomes(result: unknown): void {
  const envelope = result as {
    probe?: {
      status?: string;
      /**
       * The probe's OWN top-level error, distinct from the per-attempt ones:
       * `createProbeErrorResult` puts `error.message` here verbatim. Missing
       * this field left the whole redaction cosmetic — the attempt errors were
       * rewritten while the same socket text stayed one key higher up.
       */
      error?: string;
      transport?: {
        attempts?: Array<{
          response?: unknown;
          error?: string;
          durationMs?: number;
        }>;
      };
      oauth?: { discoveryError?: string };
    } | null;
    connection?: { status?: string; detail?: string };
    checks?: Record<string, { status?: string; detail?: string } | undefined>;
    error?: { code?: string; message?: string } | null;
  };

  const attempts = envelope.probe?.transport?.attempts ?? [];
  const answered = (attempt: { response?: unknown } | undefined) =>
    attempt?.response !== undefined;

  const rewrite = (detail: string | undefined): string | undefined =>
    detail === undefined || isEgressRefusalDetail(detail)
      ? detail
      : HOSTED_TRANSPORT_FAILURE_DETAIL;

  for (const attempt of attempts) {
    if (attempt?.error === undefined || answered(attempt)) continue;
    const redacted = rewrite(attempt.error);
    if (redacted === attempt.error) continue;
    attempt.error = redacted;
    attempt.durationMs = 0;
  }

  const everyAttemptAnswered = attempts.length > 0 && attempts.every(answered);
  const connectLegFailed = envelope.connection?.status === "error";
  if (everyAttemptAnswered && !connectLegFailed) {
    return;
  }

  if (envelope.probe?.oauth?.discoveryError !== undefined) {
    envelope.probe.oauth.discoveryError = rewrite(
      envelope.probe.oauth.discoveryError
    );
  }
  if (envelope.probe?.error !== undefined) {
    envelope.probe.error = rewrite(envelope.probe.error);
  }
  if (envelope.connection?.status === "error") {
    envelope.connection.detail = rewrite(envelope.connection.detail);
  }
  for (const check of Object.values(envelope.checks ?? {})) {
    if (check?.status === "error") {
      check.detail = rewrite(check.detail);
    }
  }
  if (envelope.error?.message !== undefined) {
    const redacted = rewrite(envelope.error.message);
    if (redacted !== envelope.error.message) {
      envelope.error.message = redacted;
      envelope.error.code = HOSTED_TRANSPORT_FAILURE_CODE;
    }
  }
}

/**
 * What a hosted response may say about a transport failure: the egress
 * guard's own refusal, or the uniform message.
 */
export function redactHostedTransportFailureText(detail: string): string {
  return isEgressRefusalDetail(detail)
    ? detail
    : HOSTED_TRANSPORT_FAILURE_DETAIL;
}

/**
 * The three exact sentences a refusal is worded as.
 *
 * `classifyPinnedTransportError` writes the first; `hosted-egress-guard`
 * writes the other two. Every pattern is anchored end to end, which is the
 * point: these used to be bare substring tests, and a substring test asks
 * whether the phrase appears ANYWHERE in the detail rather than whether the
 * detail IS a refusal. A socket error carrying attacker-influenced text — a
 * certificate subject, a SAN, a redirect target echoed into the message — only
 * had to contain "private or internal address" to be waved through with its
 * open-versus-closed differential intact, which is the leak this module exists
 * to close.
 *
 * No span is free text. The label is one of the fixed strings callers pass
 * to `assertAllowedHostedTargetUrl`, and the host is limited to the
 * characters a URL host can hold (plus `safeHost`'s own fallback). An earlier
 * `^[^"]*` label span accepted any quote-free prefix, so a socket error
 * written BEFORE the guard's sentence still rode through with it.
 *
 * Failure direction is unchanged and deliberate: a reworded refusal — or a
 * new label nobody added here — matches nothing, so it degrades to the
 * uniform message above rather than leaking. The regression test drives the
 * real transport at a real reserved address, so a rewording fails a test
 * here instead of silently changing what callers are told.
 */
const EGRESS_REFUSAL_LABEL =
  "(?:Server URL|Request URL|OAuth profile server URL)";
const EGRESS_REFUSAL_HOST = "(?:[a-z0-9.:%_\\[\\]-]+|an unparseable URL)";
const EGRESS_REFUSAL_DETAILS: readonly RegExp[] = [
  new RegExp(
    `^Refusing to connect to "${EGRESS_REFUSAL_HOST}": it is not a publicly routable address\\.$`,
    "i"
  ),
  new RegExp(
    `^${EGRESS_REFUSAL_LABEL} points at a private or internal address \\("${EGRESS_REFUSAL_HOST}"\\) that the hosted inspector will not dial\\. Run this server locally in the inspector instead\\.$`,
    "i"
  ),
  new RegExp(
    `^${EGRESS_REFUSAL_LABEL} hostname "${EGRESS_REFUSAL_HOST}" resolves to a private or internal address that the hosted inspector will not dial\\.$`,
    "i"
  ),
];

/** Is this detail the guard's own verdict rather than a socket outcome? */
function isEgressRefusalDetail(detail: string): boolean {
  return EGRESS_REFUSAL_DETAILS.some((pattern) => pattern.test(detail.trim()));
}

/**
 * Summary sentences a hosted doctor response may carry as they are: the
 * uniform transport message, and the fixed wording the SDK doctor and probe
 * write for their own outcomes.
 */
const FIXED_DOCTOR_TEXT: ReadonlySet<string> = new Set([
  HOSTED_TRANSPORT_FAILURE_DETAIL,
  "HTTP probe did not run.",
  "HTTP probe failed.",
  "HTTP endpoint was reachable, but the initialize probe did not complete successfully.",
  "Server responded to initialize but did not return a recognizable MCP initialize result.",
  "Server requires OAuth before a connection can be established.",
  "Server requires OAuth before it can be connected. Run an OAuth login flow first.",
  "Server connected but did not return initialization info.",
  "Server connected but did not advertise capabilities.",
  "Resource server does not implement OAuth 2.0 Protected Resource Metadata.",
  "Outbound OAuth fetch URL is not a valid absolute URL",
  "Invalid URL",
  "Request timed out",
]);

const OAUTH_GUARD_HOST = "[a-z0-9.:%_\\[\\]-]+";
const OAUTH_GUARD_REFUSAL = new RegExp(
  "^(?:" +
    `Refusing outbound OAuth fetch to (?:link-local or cloud-metadata|private/reserved) host "${OAUTH_GUARD_HOST}"` +
    `|Refusing outbound OAuth fetch to loopback host "${OAUTH_GUARD_HOST}" \\(no loopback opt-in\\)` +
    '|Outbound OAuth fetch must be http\\(s\\); got "[a-z][a-z0-9+.-]*:"' +
    ")$",
  "i"
);

const OAUTH_CHALLENGE_SUMMARY =
  /^(?:Server requires OAuth before it can be connected\.|Unauthenticated probe requires OAuth; continuing with provided credentials\.)(?: The challenge arrived on HTTP \d{3}; MCP requires 401 Unauthorized here, so clients that decide to authenticate from the status code alone will not start OAuth against this server\.)?$/;

/** The skills check's own findings, which name skill URIs from the listing. */
const SKILLS_FINDINGS =
  /^\d+ (?:of \d+ sampled skills failed verification|listed (?:entry|entries) rejected as malformed): /;
const MAX_SKILLS_FINDINGS_LENGTH = 1024;

type TextTemplate = (text: string) => string | undefined;

const PROBE_STATUS_SENTENCE =
  /^Server responded with HTTP (\d{3}) ?(.*) to the (initialize|SSE) probe\.$/s;
const RESOURCE_METADATA_STATUS_SENTENCE =
  /^HTTP \d{3} trying to load well-known OAuth protected resource metadata\.$/;

/**
 * SDK sentences with variable parts, each rebuilt from what was validated:
 * status codes, a bounded status text, a host name, a transport name.
 */
const DOCTOR_TEXT_TEMPLATES: readonly TextTemplate[] = [
  (text) => {
    const match = PROBE_STATUS_SENTENCE.exec(text);
    const status = match ? parseHttpStatus(Number(match[1])) : undefined;
    if (!match || status === undefined) return undefined;
    const line = formatStatusLine(status, match[2]);
    return `Server responded with ${line} to the ${match[3]} probe.`;
  },
  (text) => (RESOURCE_METADATA_STATUS_SENTENCE.test(text) ? text : undefined),
  (text) => {
    const match = /^HTTP (\d{3})(?: (.*))?$/s.exec(text);
    const status = match ? parseHttpStatus(Number(match[1])) : undefined;
    return match && status !== undefined
      ? formatStatusLine(status, match[2])
      : undefined;
  },
  (text) => (OAUTH_CHALLENGE_SUMMARY.test(text) ? text : undefined),
  (text) => (OAUTH_GUARD_REFUSAL.test(text) ? text : undefined),
  (text) => (/^Request timed out after \d+ms$/.test(text) ? text : undefined),
  (text) =>
    SKILLS_FINDINGS.test(text)
      ? boundText(text, MAX_SKILLS_FINDINGS_LENGTH)
      : undefined,
  (text) => {
    const match = /^HTTP probe failed: (.*)$/s.exec(text);
    const inner = match ? allowedDoctorText(match[1]) : undefined;
    return inner !== undefined ? `HTTP probe failed: ${inner}` : undefined;
  },
];

/** `text` as a hosted response may carry it, or `undefined` if it may not. */
function allowedDoctorText(text: string): string | undefined {
  if (FIXED_DOCTOR_TEXT.has(text) || isEgressRefusalDetail(text)) return text;
  for (const template of DOCTOR_TEXT_TEMPLATES) {
    const rebuilt = template(text);
    if (rebuilt !== undefined) return rebuilt;
  }
  return undefined;
}

const OMITTED_TEXT_NOTE =
  "Hosted diagnostics omit upstream error text; run the doctor locally for the full message.";

const STEP_FAILURE_TEXT: Readonly<Record<string, string>> = {
  probe: "The HTTP probe did not complete.",
  initialization: "Initialization info could not be collected.",
  capabilities: "Capabilities could not be collected.",
  tools: "Listing tools failed.",
  resources: "Listing resources failed.",
  resourceTemplates: "Listing resource templates failed.",
  prompts: "Listing prompts failed.",
  skills: "Listing or verifying skills failed.",
};

/** The fixed sentence that stands in for a step's failure text. */
function stepFailureText(step: string): string {
  if (step === "connection") return HOSTED_TRANSPORT_FAILURE_DETAIL;
  const failure = STEP_FAILURE_TEXT[step] ?? "A diagnostic step failed.";
  return `${failure} ${OMITTED_TEXT_NOTE}`;
}

const MAX_STEP_DETAIL_LENGTH = 512;

/**
 * A step's detail. A failure says only what {@link allowedDoctorText} allows;
 * a success or a skip is SDK wording about counts and transports, bounded.
 */
function projectStepDetail(
  failed: boolean,
  detail: unknown,
  step: string
): string {
  if (typeof detail !== "string") return failed ? stepFailureText(step) : "";
  if (failed) return allowedDoctorText(detail) ?? stepFailureText(step);
  return boundText(detail, MAX_STEP_DETAIL_LENGTH) ?? "";
}

const DISCOVERY_FAILURE_TEXT = `OAuth metadata discovery did not complete. ${OMITTED_TEXT_NOTE}`;
const INVALID_RESOURCE_METADATA_TEXT =
  "The protected resource metadata document did not match the expected format.";

function projectDiscoveryError(text: string): string {
  const allowed = allowedDoctorText(text);
  if (allowed !== undefined) return allowed;
  // Schema validation reports its issues as a JSON array; say what failed
  // without repeating it.
  return /^\s*\[\s*\{/.test(text)
    ? INVALID_RESOURCE_METADATA_TEXT
    : DISCOVERY_FAILURE_TEXT;
}

const ANSWERED_ATTEMPT_FAILURE_TEXT =
  "The request failed after the server answered.";

function projectAttemptError(error: string, answered: boolean): string {
  return (
    allowedDoctorText(error) ??
    (answered ? ANSWERED_ATTEMPT_FAILURE_TEXT : HOSTED_TRANSPORT_FAILURE_DETAIL)
  );
}

const PROBE_STATUSES: ReadonlySet<unknown> = new Set([
  "ready",
  "oauth_required",
  "reachable",
  "error",
]);
const PROBE_TRANSPORTS: ReadonlySet<unknown> = new Set([
  "streamable-http",
  "sse",
]);
const CONNECTED_TRANSPORTS: ReadonlySet<unknown> = new Set([
  "streamable-http",
  "sse",
  "stdio",
]);
const CONNECTION_STATUSES: ReadonlySet<unknown> = new Set([
  "connected",
  "error",
  "skipped",
]);
const CHECK_STATUSES: ReadonlySet<unknown> = new Set([
  "ok",
  "error",
  "skipped",
]);
const REGISTRATION_STRATEGIES: ReadonlySet<unknown> = new Set([
  "preregistered",
  "dcr",
  "cimd",
]);
const DOCTOR_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function projectRegistrationStrategies(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, REGISTRATION_STRATEGIES.size)
        .filter((entry): entry is string => REGISTRATION_STRATEGIES.has(entry))
    : [];
}

function projectProbeInitialize(value: unknown) {
  if (!isPlainRecord(value)) return undefined;
  const protocolVersion = parseProtocolVersion(value.protocolVersion);
  const serverInfo = projectServerIdentity(value.serverInfo);
  const capabilities = projectServerCapabilities(value.capabilities);
  const contentType = boundHeaderValue(value.contentType);
  return {
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
  };
}

function projectProbeOAuth(value: unknown) {
  const oauth = isPlainRecord(value) ? value : {};
  const wwwAuthenticate = boundHeaderValue(oauth.wwwAuthenticate);
  const resourceMetadataUrl = parseHttpUrl(oauth.resourceMetadataUrl);
  const resourceMetadata = projectResourceMetadata(oauth.resourceMetadata);
  const authorizationServerMetadataUrl = parseHttpUrl(
    oauth.authorizationServerMetadataUrl
  );
  const authorizationServerMetadata = projectAuthorizationServerMetadata(
    oauth.authorizationServerMetadata
  );
  const nonCompliantChallengeStatus = parseHttpStatus(
    oauth.nonCompliantChallengeStatus
  );
  return {
    required: oauth.required === true,
    optional: oauth.optional === true,
    ...(wwwAuthenticate !== undefined ? { wwwAuthenticate } : {}),
    ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
    ...(resourceMetadata !== undefined ? { resourceMetadata } : {}),
    ...(authorizationServerMetadataUrl !== undefined
      ? { authorizationServerMetadataUrl }
      : {}),
    ...(authorizationServerMetadata !== undefined
      ? { authorizationServerMetadata }
      : {}),
    registrationStrategies: projectRegistrationStrategies(
      oauth.registrationStrategies
    ),
    ...(typeof oauth.discoveryError === "string"
      ? { discoveryError: projectDiscoveryError(oauth.discoveryError) }
      : {}),
    ...(nonCompliantChallengeStatus !== undefined
      ? { nonCompliantChallengeStatus }
      : {}),
  };
}

function projectProbe(value: unknown) {
  if (!isPlainRecord(value)) return null;
  const transport = isPlainRecord(value.transport) ? value.transport : {};
  const attempts = Array.isArray(transport.attempts) ? transport.attempts : [];
  const initialize = projectProbeInitialize(value.initialize);
  return {
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.protocolVersion === "string"
      ? { protocolVersion: value.protocolVersion }
      : {}),
    status: PROBE_STATUSES.has(value.status) ? value.status : "error",
    transport: {
      ...(PROBE_TRANSPORTS.has(transport.selected)
        ? { selected: transport.selected }
        : {}),
      attempts: attempts
        .map((attempt) => projectProbeAttempt(attempt, projectAttemptError))
        .filter((attempt) => attempt !== undefined),
    },
    ...(initialize !== undefined ? { initialize } : {}),
    oauth: projectProbeOAuth(value.oauth),
    ...(typeof value.error === "string"
      ? { error: allowedDoctorText(value.error) ?? stepFailureText("probe") }
      : {}),
  };
}

function projectConnection(value: unknown) {
  const connection = isPlainRecord(value) ? value : {};
  const status = CONNECTION_STATUSES.has(connection.status)
    ? connection.status
    : "error";
  return {
    status,
    detail: projectStepDetail(
      status === "error",
      connection.detail,
      "connection"
    ),
  };
}

type ProjectedCheck = { status: unknown; detail: string };

function projectChecks(
  checks: Record<string, unknown>
): Record<string, ProjectedCheck> {
  const projected: Record<string, ProjectedCheck> = {};
  for (const [step, check] of Object.entries(checks)) {
    if (!isPlainRecord(check)) continue;
    const status = CHECK_STATUSES.has(check.status) ? check.status : "error";
    projected[step] = {
      status,
      detail: projectStepDetail(status === "error", check.detail, step),
    };
  }
  return projected;
}

/**
 * The run's headline error. Its message follows the same allowlist as the
 * steps; when it is one step's failure, it takes that step's projected detail
 * so the two read the same. Only an OAuth requirement keeps `details`, rebuilt
 * from validated URLs and known registration strategies.
 */
function projectDoctorError(
  value: unknown,
  rawChecks: Record<string, unknown> | undefined,
  checks: Record<string, ProjectedCheck>
) {
  if (typeof value !== "object" || value === null) return null;
  // May be an error instance whose fields are getters; read without trusting.
  const read = (key: string): unknown => {
    try {
      return (value as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  };
  const rawCode = read("code");
  const code =
    typeof rawCode === "string" && DOCTOR_ERROR_CODE.test(rawCode)
      ? rawCode
      : "INTERNAL_ERROR";
  const rawMessage = read("message");
  let message =
    typeof rawMessage === "string" ? allowedDoctorText(rawMessage) : undefined;
  if (message === undefined) {
    const failedStep = Object.entries(rawChecks ?? {}).find(
      ([, check]) =>
        isPlainRecord(check) &&
        check.status === "error" &&
        check.detail === rawMessage
    )?.[0];
    message =
      failedStep !== undefined && checks[failedStep]
        ? checks[failedStep].detail
        : stepFailureText("run");
  }
  const rawDetails = read("details");
  const details =
    code === "OAUTH_REQUIRED" && isPlainRecord(rawDetails)
      ? projectOAuthRequiredDetails(rawDetails)
      : undefined;
  return { code, message, ...(details ? { details } : {}) };
}

function projectOAuthRequiredDetails(details: Record<string, unknown>) {
  const authorizationServerMetadataUrl = parseHttpUrl(
    details.authorizationServerMetadataUrl
  );
  const resourceMetadataUrl = parseHttpUrl(details.resourceMetadataUrl);
  return {
    registrationStrategies: projectRegistrationStrategies(
      details.registrationStrategies
    ),
    ...(authorizationServerMetadataUrl !== undefined
      ? { authorizationServerMetadataUrl }
      : {}),
    ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
  };
}

/**
 * The connected server's initialize data: protocol version, transport,
 * recognized capabilities and bounded identity. Instructions, experimental
 * entries and extension settings are not reported; the capabilities this
 * server advertised are its own and are kept.
 */
function projectInitInfo(value: unknown) {
  if (!isPlainRecord(value)) return null;
  const protocolVersion = parseProtocolVersion(value.protocolVersion);
  const serverCapabilities = projectServerCapabilities(
    value.serverCapabilities
  );
  const serverVersion = projectServerIdentity(value.serverVersion);
  return {
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(CONNECTED_TRANSPORTS.has(value.transport)
      ? { transport: value.transport }
      : {}),
    ...(serverCapabilities !== undefined ? { serverCapabilities } : {}),
    ...(serverVersion !== undefined ? { serverVersion } : {}),
    ...(isPlainRecord(value.clientCapabilities)
      ? { clientCapabilities: value.clientCapabilities }
      : {}),
  };
}

/**
 * Fields the doctor reports from its own run, or from MCP list results
 * gathered over an initialized session, carried as they are.
 */
const CARRIED_DOCTOR_FIELDS = new Set([
  "target",
  "generatedAt",
  "status",
  "tools",
  "toolsMetadata",
  "resources",
  "resourceTemplates",
  "prompts",
  "skills",
]);

/**
 * Rebuild a doctor result from an allowlist, in the SDK's field order. A field
 * this function does not name is not carried, so a new SDK field stays out of
 * hosted responses until it is added here.
 */
function projectHostedDoctorResult(result: unknown): unknown {
  if (!isPlainRecord(result)) return result;
  const rawChecks = isPlainRecord(result.checks) ? result.checks : undefined;
  const checks = rawChecks ? projectChecks(rawChecks) : {};
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(result)) {
    switch (key) {
      case "probe":
        projected.probe = projectProbe(result.probe);
        break;
      case "connection":
        projected.connection = projectConnection(result.connection);
        break;
      case "initInfo":
        projected.initInfo = projectInitInfo(result.initInfo);
        break;
      case "capabilities":
        projected.capabilities =
          projectServerCapabilities(result.capabilities) ?? null;
        break;
      case "checks":
        projected.checks = checks;
        break;
      case "error":
        projected.error = projectDoctorError(result.error, rawChecks, checks);
        break;
      default:
        if (CARRIED_DOCTOR_FIELDS.has(key)) projected[key] = result[key];
    }
  }
  return projected;
}
