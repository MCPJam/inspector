/**
 * Allowlisted views of what an upstream server answered, for hosted responses
 * (MJ-001).
 *
 * Hosted diagnostics report THAT a target answered and what it said at the
 * protocol level, not the answer itself. A response is reduced to its status,
 * a bounded status text and a fixed set of headers; its body is omitted. Where
 * a diagnostic needs protocol data, a separate projection is built field by
 * field from values that passed validation. A parsed upstream object is never
 * copied, spread or passed through, so a field this module does not name
 * cannot reach a response — and recognizing one field (a `jsonrpc` marker, a
 * `resource`, an `issuer`) never grants the rest of the object.
 *
 * Everything here is pure and mode-agnostic. Callers decide when it applies.
 */

import { z } from "zod";

/** The response headers a hosted diagnostic keeps. Everything else is dropped. */
export const ALLOWED_UPSTREAM_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "www-authenticate",
  "mcp-session-id",
  "mcp-protocol-version",
  "allow",
  "retry-after",
];

const MAX_STATUS_TEXT_LENGTH = 64;
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_URL_LENGTH = 1024;
const MAX_NAME_LENGTH = 128;
const MAX_VERSION_LENGTH = 64;
const MAX_TOKEN_LENGTH = 128;
const MAX_TOKEN_LIST_ENTRIES = 32;
const MAX_URL_LIST_ENTRIES = 8;
const MAX_REQUEST_METHOD_LENGTH = 16;
const MAX_JSONRPC_ID_LENGTH = 128;

/** Upper bound on one serialized projection. A larger one is omitted. */
export const MAX_PROJECTION_BYTES = 16 * 1024;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * A display string: control characters replaced, trimmed, cut to `maxLength`.
 * Anything that is not a non-empty string yields `undefined`.
 */
export function boundText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_CHARACTERS, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** An HTTP reason phrase, bounded. Empty when there is none. */
export function boundStatusText(value: unknown): string {
  return boundText(value, MAX_STATUS_TEXT_LENGTH) ?? "";
}

const HttpStatusSchema = z.number().int().min(100).max(599);

/** A valid HTTP status code, or `undefined`. */
export function parseHttpStatus(value: unknown): number | undefined {
  const parsed = HttpStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** `HTTP 404 Not Found`, with the reason phrase bounded. */
export function formatStatusLine(status: number, statusText: unknown): string {
  const text = boundStatusText(statusText);
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
}

/** The allowlisted subset of a response's headers, values bounded. */
export function projectResponseHeaders(
  headers: unknown,
): Record<string, string> {
  const projected: Record<string, string> = {};
  if (!isPlainRecord(headers)) return projected;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!ALLOWED_UPSTREAM_RESPONSE_HEADERS.includes(key)) continue;
    const bounded = boundText(value, MAX_HEADER_VALUE_LENGTH);
    if (bounded !== undefined) projected[key] = bounded;
  }
  return projected;
}

/** A bounded header value, e.g. a `WWW-Authenticate` challenge. */
export function boundHeaderValue(value: unknown): string | undefined {
  return boundText(value, MAX_HEADER_VALUE_LENGTH);
}

function isPlainHttpUrl(value: string): boolean {
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === ""
  );
}

const HttpUrlSchema = z
  .string()
  .min(1)
  .max(MAX_URL_LENGTH)
  .refine(isPlainHttpUrl);

/** An absolute http(s) URL with no credentials, or `undefined`. */
export function parseHttpUrl(value: unknown): string | undefined {
  const parsed = HttpUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function projectUrlList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = value
    .slice(0, MAX_URL_LIST_ENTRIES)
    .map(parseHttpUrl)
    .filter((url): url is string => url !== undefined);
  return urls.length > 0 ? urls : undefined;
}

/** A printable, whitespace-free token: a scope, a grant type, a method name. */
const TokenSchema = z
  .string()
  .min(1)
  .max(MAX_TOKEN_LENGTH)
  .regex(/^[\x21-\x7e]+$/);

function projectTokenList(
  value: unknown,
  allowed?: ReadonlySet<string>,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tokens: string[] = [];
  for (const entry of value.slice(0, MAX_TOKEN_LIST_ENTRIES)) {
    const parsed = TokenSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (allowed && !allowed.has(parsed.data)) continue;
    tokens.push(parsed.data);
  }
  return tokens.length > 0 ? tokens : undefined;
}

const ProtocolVersionSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** An MCP protocol version string, or `undefined`. */
export function parseProtocolVersion(value: unknown): string | undefined {
  const parsed = ProtocolVersionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const JsonRpcCodeSchema = z
  .number()
  .int()
  .min(-2_147_483_648)
  .max(2_147_483_647);

/**
 * Fixed wording per JSON-RPC error code. The server's own `message` and
 * `data` are never reported.
 */
function jsonRpcErrorMessage(code: number): string {
  switch (code) {
    case -32700:
      return "Parse error";
    case -32600:
      return "Invalid request";
    case -32601:
      return "Method not found";
    case -32602:
      return "Invalid params";
    case -32603:
      return "Internal error";
    default:
      return code <= -32000 && code >= -32099
        ? "Server error"
        : "JSON-RPC error";
  }
}

export type JsonRpcErrorProjection = { code: number; message: string };

function projectJsonRpcError(
  value: unknown,
): JsonRpcErrorProjection | undefined {
  if (!isPlainRecord(value)) return undefined;
  const code = JsonRpcCodeSchema.safeParse(value.code);
  if (!code.success || typeof value.message !== "string") return undefined;
  return { code: code.data, message: jsonRpcErrorMessage(code.data) };
}

const JsonRpcIdSchema = z.union([
  z.string().max(MAX_JSONRPC_ID_LENGTH),
  z.number().int().safe(),
]);

export type ServerIdentityProjection = {
  name?: string;
  version?: string;
  title?: string;
};

/** Bounded `name` / `version` / `title` of an MCP `Implementation`. */
export function projectServerIdentity(
  value: unknown,
): ServerIdentityProjection | undefined {
  if (!isPlainRecord(value)) return undefined;
  const name = boundText(value.name, MAX_NAME_LENGTH);
  const version = boundText(value.version, MAX_VERSION_LENGTH);
  const title = boundText(value.title, MAX_NAME_LENGTH);
  if (name === undefined && version === undefined) return undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

const CAPABILITY_KEYS = [
  "tools",
  "resources",
  "prompts",
  "logging",
  "completions",
  "tasks",
] as const;

const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

export type CapabilityFlags = Record<
  (typeof CAPABILITY_KEYS)[number] | "skills",
  boolean
>;

/**
 * Which recognized capabilities a server declared, as booleans. Capability
 * contents — experimental entries, extension settings, nested options — are
 * not reported.
 */
export function projectCapabilityFlags(
  value: unknown,
): CapabilityFlags | undefined {
  if (!isPlainRecord(value)) return undefined;
  const flags = {} as CapabilityFlags;
  for (const key of CAPABILITY_KEYS) {
    flags[key] = isPlainRecord(value[key]);
  }
  const extensions = value.extensions;
  flags.skills =
    isPlainRecord(extensions) && isPlainRecord(extensions[SKILLS_EXTENSION]);
  return flags;
}

/** The recognized capabilities and the boolean options each may declare. */
const CAPABILITY_OPTIONS: Readonly<
  Record<(typeof CAPABILITY_KEYS)[number], readonly string[]>
> = {
  tools: ["listChanged"],
  resources: ["subscribe", "listChanged"],
  prompts: ["listChanged"],
  logging: [],
  completions: [],
  tasks: [],
};

/**
 * Server capabilities in their MCP shape, restricted to the recognized
 * capabilities and their boolean options. The skills extension is reported by
 * presence only; every other extension and experimental entry is dropped.
 */
export function projectServerCapabilities(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) {
    const declared = value[key];
    if (!isPlainRecord(declared)) continue;
    const options: Record<string, boolean> = {};
    for (const option of CAPABILITY_OPTIONS[key]) {
      const setting = declared[option];
      if (typeof setting === "boolean") options[option] = setting;
    }
    projected[key] = options;
  }
  const extensions = value.extensions;
  if (
    isPlainRecord(extensions) &&
    isPlainRecord(extensions[SKILLS_EXTENSION])
  ) {
    projected.extensions = { [SKILLS_EXTENSION]: {} };
  }
  return projected;
}

function withinProjectionBudget<T>(projection: T): T | undefined {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
    return bytes <= MAX_PROJECTION_BYTES ? projection : undefined;
  } catch {
    return undefined;
  }
}

export type InitializeResultProjection = {
  protocolVersion?: string;
  serverInfo?: ServerIdentityProjection;
  capabilities?: CapabilityFlags;
};

/** The diagnostic fields of an initialize result, each validated alone. */
export function projectInitializeResultFields(value: {
  protocolVersion?: unknown;
  serverInfo?: unknown;
  capabilities?: unknown;
}): InitializeResultProjection {
  const protocolVersion = parseProtocolVersion(value.protocolVersion);
  const serverInfo = projectServerIdentity(value.serverInfo);
  const capabilities = projectCapabilityFlags(value.capabilities);
  return {
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
}

const InitializeResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  result: z.object({
    protocolVersion: z.string().min(1),
    capabilities: z.custom<Record<string, unknown>>(isPlainRecord),
    serverInfo: z.object({ name: z.string(), version: z.string() }),
  }),
});

const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([JsonRpcIdSchema, z.null()]),
  error: z.custom<Record<string, unknown>>(isPlainRecord),
});

export type AttemptProjection =
  | ({ kind: "initialize_result" } & InitializeResultProjection)
  | ({ kind: "jsonrpc_error" } & JsonRpcErrorProjection)
  | ({ kind: "resource_metadata" } & ResourceMetadataProjection)
  | ({
      kind: "authorization_server_metadata";
    } & AuthorizationServerMetadataProjection);

/**
 * An answer to `initialize`: a validated result envelope becomes its protocol
 * version, server identity and capability flags; a validated error envelope
 * becomes its code and a fixed message. Anything else projects to nothing.
 */
export function projectInitializeResponse(
  body: unknown,
): AttemptProjection | undefined {
  if (InitializeResponseSchema.safeParse(body).success) {
    // The envelope schema is the gate; each projected field is validated on
    // its own, so optional ones such as `serverInfo.title` survive the gate.
    const result = (body as { result: Record<string, unknown> }).result;
    return withinProjectionBudget({
      kind: "initialize_result" as const,
      ...projectInitializeResultFields(result),
    });
  }
  const failure = JsonRpcErrorResponseSchema.safeParse(body);
  if (failure.success) {
    const error = projectJsonRpcError(failure.data.error);
    if (error) return { kind: "jsonrpc_error", ...error };
  }
  return undefined;
}

export type ResourceMetadataProjection = {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
};

const BEARER_METHODS: ReadonlySet<string> = new Set([
  "header",
  "body",
  "query",
]);

/**
 * RFC 9728 protected resource metadata, reduced to the fields discovery
 * reads. `resource` must be a valid URL or nothing is projected.
 */
export function projectResourceMetadata(
  value: unknown,
): ResourceMetadataProjection | undefined {
  if (!isPlainRecord(value)) return undefined;
  const resource = parseHttpUrl(value.resource);
  if (resource === undefined) return undefined;
  const authorizationServers = projectUrlList(value.authorization_servers);
  const scopes = projectTokenList(value.scopes_supported);
  const bearerMethods = projectTokenList(
    value.bearer_methods_supported,
    BEARER_METHODS,
  );
  return withinProjectionBudget({
    resource,
    ...(authorizationServers
      ? { authorization_servers: authorizationServers }
      : {}),
    ...(scopes ? { scopes_supported: scopes } : {}),
    ...(bearerMethods ? { bearer_methods_supported: bearerMethods } : {}),
  });
}

export type ScopeChallengeProjection = {
  requiredScope?: string;
  resourceMetadataUrl?: string;
};

/**
 * An insufficient-scope challenge, reduced to what a step-up reads: its scope
 * tokens and a valid metadata URL. The description is not kept.
 */
export function projectScopeChallenge(
  value: unknown,
): ScopeChallengeProjection | undefined {
  if (!isPlainRecord(value)) return undefined;
  const scopes =
    typeof value.requiredScope === "string"
      ? projectTokenList(value.requiredScope.split(/\s+/).filter(Boolean))
      : undefined;
  const resourceMetadataUrl = parseHttpUrl(value.resourceMetadataUrl);
  if (!scopes && resourceMetadataUrl === undefined) return undefined;
  return {
    ...(scopes ? { requiredScope: scopes.join(" ") } : {}),
    ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
  };
}

export type AuthorizationServerMetadataProjection = {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
};

const AS_METADATA_URL_FIELDS = [
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
] as const;

const AS_METADATA_LIST_FIELDS = [
  "scopes_supported",
  "response_types_supported",
  "grant_types_supported",
  "code_challenge_methods_supported",
  "token_endpoint_auth_methods_supported",
] as const;

/**
 * RFC 8414 / OpenID discovery metadata, reduced to the fields client
 * registration and the authorization flow read. `issuer` must be a valid URL
 * or nothing is projected.
 */
export function projectAuthorizationServerMetadata(
  value: unknown,
): AuthorizationServerMetadataProjection | undefined {
  if (!isPlainRecord(value)) return undefined;
  const issuer = parseHttpUrl(value.issuer);
  if (issuer === undefined) return undefined;
  const projection: AuthorizationServerMetadataProjection = { issuer };
  for (const field of AS_METADATA_URL_FIELDS) {
    const url = parseHttpUrl(value[field]);
    if (url !== undefined) projection[field] = url;
  }
  for (const field of AS_METADATA_LIST_FIELDS) {
    const tokens = projectTokenList(value[field]);
    if (tokens) projection[field] = tokens;
  }
  if (typeof value.client_id_metadata_document_supported === "boolean") {
    projection.client_id_metadata_document_supported =
      value.client_id_metadata_document_supported;
  }
  return withinProjectionBudget(projection);
}

const PROBE_ATTEMPT_NAMES: ReadonlySet<string> = new Set([
  "streamable_initialize",
  "sse_probe",
  "resource_metadata",
  "authorization_server_metadata",
]);

export type ProjectedAttemptResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentType?: string;
  bodyOmitted: true;
  projection?: AttemptProjection;
};

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The protocol data one kind of probe request may report. An SSE probe
 * reports none: its stream content is never part of a diagnostic.
 */
function projectAttemptBody(
  name: string,
  status: number,
  body: unknown,
): AttemptProjection | undefined {
  switch (name) {
    case "streamable_initialize":
      return projectInitializeResponse(body);
    case "resource_metadata": {
      if (!isSuccessStatus(status)) return undefined;
      const metadata = projectResourceMetadata(body);
      return metadata ? { kind: "resource_metadata", ...metadata } : undefined;
    }
    case "authorization_server_metadata": {
      if (!isSuccessStatus(status)) return undefined;
      const metadata = projectAuthorizationServerMetadata(body);
      return metadata
        ? { kind: "authorization_server_metadata", ...metadata }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * One answered probe request: status, bounded status text, allowlisted
 * headers, and at most a projection of the body — never the body.
 */
export function projectAttemptResponse(
  name: string,
  response: unknown,
): ProjectedAttemptResponse {
  const record = isPlainRecord(response) ? response : {};
  const status = parseHttpStatus(record.status) ?? 0;
  const contentType = boundHeaderValue(record.contentType);
  const projection = projectAttemptBody(name, status, record.body);
  return {
    status,
    statusText: boundStatusText(record.statusText),
    headers: projectResponseHeaders(record.headers),
    ...(contentType !== undefined ? { contentType } : {}),
    bodyOmitted: true,
    ...(projection ? { projection } : {}),
  };
}

export type ProjectedProbeAttempt = {
  name: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: ProjectedAttemptResponse;
  error?: string;
  durationMs: number;
};

const MAX_REQUEST_HEADERS = 64;
const MAX_HEADER_NAME_LENGTH = 128;

/** Stands in for a request header value a hosted response does not repeat. */
export const REDACTED_HEADER_VALUE = "<redacted>";

/** Request headers whose values are protocol data rather than credentials. */
const PROTOCOL_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
]);

/**
 * Request headers as a hosted response reports them: each name, bounded, and
 * the value only for a protocol header. Every other value — `Authorization`,
 * cookies, and any header a server was configured with — is replaced with
 * {@link REDACTED_HEADER_VALUE}, whatever the name, independently of any
 * redaction applied upstream of this function.
 */
export function projectRequestHeaders(
  headers: unknown,
): Record<string, string> {
  const projected: Record<string, string> = {};
  if (!isPlainRecord(headers)) return projected;
  for (const [name, value] of Object.entries(headers).slice(
    0,
    MAX_REQUEST_HEADERS,
  )) {
    const boundedName = boundText(name, MAX_HEADER_NAME_LENGTH);
    if (boundedName === undefined || typeof value !== "string") continue;
    projected[boundedName] = PROTOCOL_REQUEST_HEADERS.has(
      boundedName.toLowerCase(),
    )
      ? (boundText(value, MAX_HEADER_VALUE_LENGTH) ?? "")
      : REDACTED_HEADER_VALUE;
  }
  return projected;
}

/**
 * One recorded probe request. The request half keeps its method, its URL
 * (bounded, since a metadata URL is named by the target), the body this
 * server sent, and its headers through {@link projectRequestHeaders}. The
 * response half goes through {@link projectAttemptResponse}. `error` is
 * passed to `describeError`, which decides what may be said.
 */
export function projectProbeAttempt(
  attempt: unknown,
  describeError: (error: string, answered: boolean) => string,
): ProjectedProbeAttempt | undefined {
  if (!isPlainRecord(attempt)) return undefined;
  const name = attempt.name;
  if (typeof name !== "string" || !PROBE_ATTEMPT_NAMES.has(name)) {
    return undefined;
  }
  const request = isPlainRecord(attempt.request) ? attempt.request : {};
  const answered = attempt.response !== undefined;
  const durationMs =
    typeof attempt.durationMs === "number" &&
    Number.isFinite(attempt.durationMs) &&
    attempt.durationMs >= 0
      ? attempt.durationMs
      : 0;
  return {
    name,
    request: {
      method: boundText(request.method, MAX_REQUEST_METHOD_LENGTH) ?? "GET",
      url: boundText(request.url, MAX_URL_LENGTH) ?? "",
      headers: projectRequestHeaders(request.headers),
      ...(request.body !== undefined ? { body: request.body } : {}),
    },
    ...(answered
      ? { response: projectAttemptResponse(name, attempt.response) }
      : {}),
    ...(typeof attempt.error === "string"
      ? { error: describeError(attempt.error, answered) }
      : {}),
    durationMs,
  };
}

const JSONRPC_METHOD_PATTERN = /^[A-Za-z0-9_./:$-]{1,128}$/;
const JSONRPC_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "jsonrpc",
  "id",
  "method",
]);

/**
 * A JSON-RPC frame as its envelope only: `id`, `method` and an error code
 * survive; `result`, `params`, error text and anything else do not.
 */
export function projectJsonRpcFrame(message: unknown): Record<string, unknown> {
  if (!isPlainRecord(message)) return { contentOmitted: true };
  const frame: Record<string, unknown> = {};
  if (message.jsonrpc === "2.0") frame.jsonrpc = "2.0";
  const id = JsonRpcIdSchema.safeParse(message.id);
  if (id.success) frame.id = id.data;
  if (
    typeof message.method === "string" &&
    JSONRPC_METHOD_PATTERN.test(message.method)
  ) {
    frame.method = message.method;
  }
  const error = projectJsonRpcError(message.error);
  if (error) frame.error = error;
  if (Object.keys(message).some((key) => !JSONRPC_ENVELOPE_KEYS.has(key))) {
    frame.contentOmitted = true;
  }
  return frame;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Events kept per hosted log array: the first half and the last half. */
export const MAX_LOG_EVENTS = 200;
/** Upper bound on one serialized hosted log array. */
export const MAX_LOG_ARRAY_BYTES = 1024 * 1024;

/**
 * A log array within {@link MAX_LOG_EVENTS} and {@link MAX_LOG_ARRAY_BYTES},
 * and how many events it left out.
 */
function projectLogArray(
  events: unknown[],
  project: (event: Record<string, unknown>) => Record<string, unknown>,
): { events: Record<string, unknown>[]; omitted: number } {
  const records = events.filter(isPlainRecord);
  const half = MAX_LOG_EVENTS / 2;
  const candidates =
    records.length > MAX_LOG_EVENTS
      ? [...records.slice(0, half), ...records.slice(-half)]
      : records;
  let omitted = records.length - candidates.length;
  let bytes = 0;
  const kept: Record<string, unknown>[] = [];
  for (const record of candidates) {
    const projected = project(record);
    const size = Buffer.byteLength(JSON.stringify(projected), "utf8");
    if (bytes + size > MAX_LOG_ARRAY_BYTES) {
      omitted += 1;
      continue;
    }
    bytes += size;
    kept.push(projected);
  }
  return { events: kept, omitted };
}

/**
 * The hosted log envelope (`_rpcLogs` / `_httpLogs`) attached to a failed
 * connection, reduced the same way as a probe answer: frames in either
 * direction keep their envelope, exchanges keep their status line and
 * allowlisted response headers, request headers go through
 * {@link projectRequestHeaders}, and a transport error goes through
 * `describeTransportError`. Each array is bounded by {@link projectLogArray};
 * `_rpcLogsOmitted` / `_httpLogsOmitted` count what was left out.
 */
export function projectHostedLogEnvelope(
  envelope: Record<string, unknown> | undefined,
  describeTransportError: (error: string) => string,
): Record<string, unknown> | undefined {
  if (!envelope) return envelope;
  const projected: Record<string, unknown> = {};
  if (Array.isArray(envelope._rpcLogs)) {
    const rpc = projectLogArray(envelope._rpcLogs, projectRpcLogEvent);
    projected._rpcLogs = rpc.events;
    if (rpc.omitted > 0) projected._rpcLogsOmitted = rpc.omitted;
  }
  if (Array.isArray(envelope._httpLogs)) {
    const http = projectLogArray(envelope._httpLogs, (event) =>
      projectHttpLogEvent(event, describeTransportError),
    );
    projected._httpLogs = http.events;
    if (http.omitted > 0) projected._httpLogsOmitted = http.omitted;
  }
  return projected;
}

function logEventIdentity(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const eventId = optionalString(event.eventId);
  return {
    ...(eventId !== undefined ? { eventId } : {}),
    serverId: optionalString(event.serverId) ?? "",
    serverName: optionalString(event.serverName) ?? "",
    timestamp: optionalString(event.timestamp) ?? "",
    ...(isPlainRecord(event.pluginOrigin)
      ? { pluginOrigin: event.pluginOrigin }
      : {}),
  };
}

function projectRpcLogEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...logEventIdentity(event),
    direction: event.direction === "send" ? "send" : "receive",
    message: projectJsonRpcFrame(event.message),
  };
}

/**
 * The request facts an exchange was logged with, as the correlation needs
 * them: a JSON-RPC method name and a protocol version. The routing name is
 * not kept.
 */
function projectBodyValues(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const method =
    typeof value.method === "string" &&
    JSONRPC_METHOD_PATTERN.test(value.method)
      ? value.method
      : undefined;
  const protocolVersion = parseProtocolVersion(value.protocolVersion);
  if (method === undefined && protocolVersion === undefined) return undefined;
  return {
    ...(method !== undefined ? { method } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
  };
}

function projectHttpLogEvent(
  event: Record<string, unknown>,
  describeTransportError: (error: string) => string,
): Record<string, unknown> {
  const exchange = isPlainRecord(event.exchange) ? event.exchange : {};
  const request = isPlainRecord(exchange.request) ? exchange.request : {};
  const response = isPlainRecord(exchange.response)
    ? exchange.response
    : undefined;
  const durationMs =
    typeof exchange.durationMs === "number" &&
    Number.isFinite(exchange.durationMs)
      ? exchange.durationMs
      : 0;
  const bodyValues = projectBodyValues(exchange.bodyValues);
  return {
    ...logEventIdentity(event),
    exchange: {
      serverId: optionalString(exchange.serverId) ?? "",
      request: {
        method: boundText(request.method, MAX_REQUEST_METHOD_LENGTH) ?? "",
        url: boundText(request.url, MAX_URL_LENGTH) ?? "",
        headers: projectRequestHeaders(request.headers),
      },
      ...(response
        ? {
            response: {
              status: parseHttpStatus(response.status) ?? 0,
              statusText: boundStatusText(response.statusText),
              headers: projectResponseHeaders(response.headers),
            },
          }
        : {}),
      ...(typeof exchange.error === "string"
        ? { error: describeTransportError(exchange.error) }
        : {}),
      durationMs,
      ...(bodyValues ? { bodyValues } : {}),
    },
  };
}

/** Items kept per MCP list; later ones are counted as omitted. */
export const MAX_LIST_ITEMS = 500;
/** Upper bound on the serialized list section of one hosted response. */
export const MAX_LIST_SECTION_BYTES = 2 * 1024 * 1024;

const MAX_ITEM_NAME_LENGTH = 256;
const MAX_ITEM_DESCRIPTION_LENGTH = 4096;
const MAX_ITEM_URI_LENGTH = 2048;
const MAX_MIME_TYPE_LENGTH = 128;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4096;
const MAX_PROMPT_ARGUMENTS = 32;
const MAX_ARGUMENT_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_MESSAGE_LENGTH = 512;

type ListItem = Record<string, unknown>;

/** A bounded description, flagged when it was cut. */
function projectDescription(value: unknown): {
  description?: string;
  descriptionTruncated?: true;
} {
  const description = boundText(value, MAX_ITEM_DESCRIPTION_LENGTH);
  if (description === undefined) return {};
  const cleanedLength = (value as string)
    .replace(CONTROL_CHARACTERS, " ")
    .trim().length;
  return {
    description,
    ...(cleanedLength > MAX_ITEM_DESCRIPTION_LENGTH
      ? { descriptionTruncated: true as const }
      : {}),
  };
}

const ITEM_URI_PATTERN =
  /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f-\u009f]*$/;
const ITEM_URI_TEMPLATE_PATTERN = /^[^\s\u0000-\u001f\u007f-\u009f]+$/;

/** A URI with a scheme and no whitespace, bounded, or `undefined`. */
function parseItemUri(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= MAX_ITEM_URI_LENGTH &&
    ITEM_URI_PATTERN.test(value)
    ? value
    : undefined;
}

function parseItemUriTemplate(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= MAX_ITEM_URI_LENGTH &&
    ITEM_URI_TEMPLATE_PATTERN.test(value)
    ? value
    : undefined;
}

const ItemSizeSchema = z.number().int().nonnegative().safe();

/**
 * Whether a JSON value stays within the schema depth and node budget. Walks
 * iteratively and stops as soon as either bound is passed, so an oversized
 * value costs no more than the budget to reject.
 */
function fitsSchemaBudget(value: unknown): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 0 },
  ];
  let visited = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    visited += 1;
    if (visited > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) return false;
    if (typeof node !== "object" || node === null) continue;
    const children = Array.isArray(node) ? node : Object.values(node);
    if (visited + stack.length + children.length > MAX_SCHEMA_NODES) {
      return false;
    }
    for (const child of children) stack.push({ node: child, depth: depth + 1 });
  }
  return true;
}

/**
 * A tool's JSON Schema when it is an object within the per-schema budget,
 * as a fresh copy; otherwise only the fact that it was omitted.
 */
function projectToolSchema(value: unknown): {
  schema?: Record<string, unknown>;
  omitted?: true;
} {
  if (value === undefined) return {};
  if (!isPlainRecord(value) || !fitsSchemaBudget(value)) {
    return { omitted: true };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { omitted: true };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
    return { omitted: true };
  }
  return { schema: JSON.parse(serialized) as Record<string, unknown> };
}

const TOOL_ANNOTATION_HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

function projectToolAnnotations(value: unknown): ListItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const annotations: ListItem = {};
  const title = boundText(value.title, MAX_ITEM_NAME_LENGTH);
  if (title !== undefined) annotations.title = title;
  for (const hint of TOOL_ANNOTATION_HINTS) {
    if (typeof value[hint] === "boolean") annotations[hint] = value[hint];
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/**
 * A listed tool: name, title, bounded description, schemas within budget
 * (or a flag saying one was omitted), and annotations reduced to their title
 * and boolean hints. `_meta`, icons and unknown keys are not carried.
 */
export function projectListedTool(value: unknown): ListItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const name = boundText(value.name, MAX_ITEM_NAME_LENGTH);
  if (name === undefined) return undefined;
  const title = boundText(value.title, MAX_ITEM_NAME_LENGTH);
  const input = projectToolSchema(value.inputSchema);
  const output = projectToolSchema(value.outputSchema);
  const annotations = projectToolAnnotations(value.annotations);
  return {
    name,
    ...(title !== undefined ? { title } : {}),
    ...projectDescription(value.description),
    ...(input.schema ? { inputSchema: input.schema } : {}),
    ...(input.omitted ? { inputSchemaOmitted: true } : {}),
    ...(output.schema ? { outputSchema: output.schema } : {}),
    ...(output.omitted ? { outputSchemaOmitted: true } : {}),
    ...(annotations ? { annotations } : {}),
  };
}

/** A listed resource: URI, name, title, description, MIME type and size. */
export function projectListedResource(value: unknown): ListItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const uri = parseItemUri(value.uri);
  if (uri === undefined) return undefined;
  const name = boundText(value.name, MAX_ITEM_NAME_LENGTH);
  const title = boundText(value.title, MAX_ITEM_NAME_LENGTH);
  const mimeType = boundText(value.mimeType, MAX_MIME_TYPE_LENGTH);
  const size = ItemSizeSchema.safeParse(value.size);
  return {
    uri,
    ...(name !== undefined ? { name } : {}),
    ...(title !== undefined ? { title } : {}),
    ...projectDescription(value.description),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(size.success ? { size: size.data } : {}),
  };
}

/** A listed resource template: URI template, name, title, description, MIME type. */
export function projectListedResourceTemplate(
  value: unknown,
): ListItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const uriTemplate = parseItemUriTemplate(value.uriTemplate);
  if (uriTemplate === undefined) return undefined;
  const name = boundText(value.name, MAX_ITEM_NAME_LENGTH);
  const title = boundText(value.title, MAX_ITEM_NAME_LENGTH);
  const mimeType = boundText(value.mimeType, MAX_MIME_TYPE_LENGTH);
  return {
    uriTemplate,
    ...(name !== undefined ? { name } : {}),
    ...(title !== undefined ? { title } : {}),
    ...projectDescription(value.description),
    ...(mimeType !== undefined ? { mimeType } : {}),
  };
}

function projectPromptArgument(value: unknown): ListItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const name = boundText(value.name, MAX_ITEM_NAME_LENGTH);
  if (name === undefined) return undefined;
  const description = boundText(
    value.description,
    MAX_ARGUMENT_DESCRIPTION_LENGTH,
  );
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(typeof value.required === "boolean"
      ? { required: value.required }
      : {}),
  };
}

/**
 * A listed prompt: name, title, description, and its arguments reduced to
 * name, description and `required`, count-capped and flagged when cut.
 */
export function projectListedPrompt(value: unknown): ListItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const name = boundText(value.name, MAX_ITEM_NAME_LENGTH);
  if (name === undefined) return undefined;
  const title = boundText(value.title, MAX_ITEM_NAME_LENGTH);
  const declared = Array.isArray(value.arguments) ? value.arguments : [];
  const promptArguments = declared
    .slice(0, MAX_PROMPT_ARGUMENTS)
    .map(projectPromptArgument)
    .filter((argument) => argument !== undefined);
  return {
    name,
    ...(title !== undefined ? { title } : {}),
    ...projectDescription(value.description),
    ...(promptArguments.length > 0 ? { arguments: promptArguments } : {}),
    ...(declared.length > MAX_PROMPT_ARGUMENTS
      ? { argumentsTruncated: true }
      : {}),
  };
}

const SKILL_UNLOADABLE_REASONS: ReadonlySet<unknown> = new Set([
  "no_resources",
  "dynamic_resources",
  "too_many_resources",
  "too_large",
]);

/**
 * A listed skill: its URI, name, description, how many files its manifest
 * names, and why it cannot be loaded when it cannot. Frontmatter and the
 * manifest itself are not carried.
 */
export function projectListedSkill(value: unknown): ListItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const skillUri = parseItemUri(value.skillUri);
  if (skillUri === undefined) return undefined;
  const serverId = boundText(value.serverId, MAX_ITEM_NAME_LENGTH);
  const name = boundText(value.name, MAX_ITEM_NAME_LENGTH);
  const unloadable = isPlainRecord(value.unloadable)
    ? value.unloadable
    : undefined;
  const unloadableMessage = boundText(
    unloadable?.message,
    MAX_SKILL_MESSAGE_LENGTH,
  );
  return {
    ...(serverId !== undefined ? { serverId } : {}),
    skillUri,
    ...(name !== undefined ? { name } : {}),
    ...projectDescription(value.description),
    ...(Array.isArray(value.resources)
      ? { resourceCount: value.resources.length }
      : {}),
    ...(unloadable && SKILL_UNLOADABLE_REASONS.has(unloadable.reason)
      ? {
          unloadable: {
            reason: unloadable.reason,
            ...(unloadableMessage !== undefined
              ? { message: unloadableMessage }
              : {}),
          },
        }
      : {}),
  };
}

const LIST_PROJECTORS: ReadonlyArray<
  readonly [string, (value: unknown) => ListItem | undefined]
> = [
  ["tools", projectListedTool],
  ["resources", projectListedResource],
  ["resourceTemplates", projectListedResourceTemplate],
  ["prompts", projectListedPrompt],
  ["skills", projectListedSkill],
];

/** How much of one list a hosted response carries, when not all of it. */
export type ListCut = { returned: number; omitted: number };

export type ProjectedListSection = {
  lists: Record<string, ListItem[]>;
  /** Present for a list only when some of its items were not returned. */
  truncated: Record<string, ListCut>;
};

/**
 * The MCP list results of a doctor run (`tools`, `resources`,
 * `resourceTemplates`, `prompts`, `skills`), each item projected field by
 * field, each list capped at {@link MAX_LIST_ITEMS}, and the section held to
 * {@link MAX_LIST_SECTION_BYTES}.
 *
 * The byte budget is shared out smallest list first: a list that fits its
 * even share of what is left keeps everything and returns the remainder to
 * the others, so one large list cannot crowd out the rest. A list keeps a
 * prefix of its items; everything it does not return — cut by a limit or
 * dropped as malformed — is counted in `truncated`.
 */
export function projectListSection(
  source: Record<string, unknown>,
): ProjectedListSection {
  const candidates: Array<{
    key: string;
    total: number;
    items: ListItem[];
    sizes: number[];
    bytes: number;
  }> = [];
  for (const [key, project] of LIST_PROJECTORS) {
    const listed = source[key];
    if (!Array.isArray(listed)) continue;
    const items: ListItem[] = [];
    const sizes: number[] = [];
    for (const entry of listed.slice(0, MAX_LIST_ITEMS)) {
      const item = project(entry);
      if (item === undefined) continue;
      items.push(item);
      sizes.push(Buffer.byteLength(JSON.stringify(item), "utf8"));
    }
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    candidates.push({ key, total: listed.length, items, sizes, bytes });
  }

  const allowance = new Map<string, number>();
  let remaining = MAX_LIST_SECTION_BYTES;
  const bySize = [...candidates].sort((a, b) => a.bytes - b.bytes);
  bySize.forEach((candidate, index) => {
    const share = Math.floor(remaining / (bySize.length - index));
    const granted = Math.min(candidate.bytes, share);
    allowance.set(candidate.key, granted);
    remaining -= granted;
  });

  const lists: Record<string, ListItem[]> = {};
  const truncated: Record<string, ListCut> = {};
  for (const candidate of candidates) {
    const budget = allowance.get(candidate.key) ?? 0;
    let used = 0;
    let returned = 0;
    while (
      returned < candidate.items.length &&
      used + candidate.sizes[returned]! <= budget
    ) {
      used += candidate.sizes[returned]!;
      returned += 1;
    }
    lists[candidate.key] = candidate.items.slice(0, returned);
    if (candidate.total > returned) {
      truncated[candidate.key] = {
        returned,
        omitted: candidate.total - returned,
      };
    }
  }
  return { lists, truncated };
}
