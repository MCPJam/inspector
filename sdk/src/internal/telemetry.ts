import { sentryProtocolMetadata, type SentryBuildMetadata } from "./sentry-protocol.js";
export { sentryInjectedDebugId } from "./sentry-protocol.js";

/** Framework-free, reconstructive boundary for first-party telemetry clients. */
export interface TelemetryCatalog extends SentryBuildMetadata {
  diagnosticFields?: Readonly<Record<string, readonly string[]>>;
  files?: readonly string[];
  frameAliases?: Readonly<Record<string, string>>;
  routes?: readonly string[];
  errors?: readonly string[];
  messages?: readonly string[];
}

type Fields = Record<string, unknown>;
const CLASSES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "AbortError",
  "EvalReportingError",
];
const LEVELS = ["fatal", "error", "warning", "info", "debug", "log"];
const TAGS: Record<string, readonly string[]> = {
  deployment: ["hosted", "self_hosted"],
  actor_kind: ["user", "signedIn", "guest", "installation", "unknown"],
  platform: ["web", "npm", "electron", "darwin", "win32", "linux"],
  origin: ["mcpjam", "dependency", "external", "unknown"],
  kind: ["bug", "expected", "dependency", "unknown"],
  severity: ["error", "warning", "info"],
  error_origin: ["user_server", "user_config", "mcpjam", "ambiguous"],
  page_class: ["incident", "routine"],
  surface: ["mcpjam_agent", "action", "api", "desktop", "sdk"],
  entrypoint: [
    "uploadEvalArtifact",
    "evalRunReporter.flush",
    "evalRunReporter.finalize",
    "reportEvalResults",
  ],
  http_status: Array.from({ length: 500 }, (_, index) => String(index + 100)),
};

export function telemetryRecord(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function member(value: unknown, values: readonly string[]): string | undefined {
  return typeof value === "string" && values.includes(value)
    ? value
    : undefined;
}

function bounded(value: unknown, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
    ? value
    : undefined;
}

function token(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

export function telemetryActorId(value: unknown): string | undefined {
  return token(
    value,
    /^(?:user_[0-9A-HJKMNP-TV-Z]{26}|(?:(?:installation:|local-runtime-)?)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{16})$/
  );
}

export function rebuildSentryBreadcrumb<T extends object>(input: T): T | null {
  const source = telemetryRecord(input);
  const category = member(source.category, [
    "navigation",
    "ui.click",
    "http",
    "console",
    "app",
    "lifecycle",
    "process",
    "eval",
    "auth",
  ]);
  const type = member(source.type, [
    "default",
    "debug",
    "error",
    "navigation",
    "http",
    "info",
    "user",
  ]);
  return category || type
    ? ({ ...(category ? { category } : {}), ...(type ? { type } : {}) } as T)
    : null;
}

function frames(
  input: unknown,
  catalog: TelemetryCatalog
): { frames: Fields[]; dropped: number } {
  const values = Array.isArray(input) ? input : [];
  const kept: Fields[] = [];
  for (const raw of values.slice(-100)) {
    const frame = telemetryRecord(raw);
    const rawFilename =
      typeof frame.filename === "string" ? frame.filename : "";
    const ownedFile = catalog.frameAliases?.[rawFilename] ?? rawFilename;
    if (!catalog.files?.includes(ownedFile)) continue;
    const filename = catalog.frameOutputNames?.[ownedFile] ?? ownedFile;
    const lineno = bounded(frame.lineno, 1000000);
    if (lineno === undefined || !Number.isInteger(lineno) || lineno < 1) continue;
    const column = bounded(frame.colno, 1000000);
    const colno = column !== undefined && Number.isInteger(column) ? column : undefined;
    kept.push({
      filename,
      in_app: true,
      ...(lineno === undefined ? {} : { lineno }),
      ...(colno === undefined ? {} : { colno }),
    });
  }
  return { frames: kept, dropped: values.length - kept.length };
}

function exceptions(input: unknown, catalog: TelemetryCatalog) {
  const values = telemetryRecord(input).values;
  let dropped = 0;
  const kept = (Array.isArray(values) ? values.slice(-8) : []).map((raw) => {
    const value = telemetryRecord(raw);
    const type =
      member(value.type, [...CLASSES, ...(catalog.errors ?? [])]) ??
      "UnknownError";
    const stack = frames(telemetryRecord(value.stacktrace).frames, catalog);
    dropped += stack.dropped;
    return {
      type,
      value: type,
      ...(stack.frames.length ? { stacktrace: { frames: stack.frames } } : {}),
    };
  });
  return { values: kept, dropped };
}

function tags(input: unknown): Fields {
  const source = telemetryRecord(input);
  const output: Fields = {};
  for (const [key, values] of Object.entries(TAGS)) {
    const value = member(source[key], values);
    if (value) output[key] = value;
  }
  return output;
}

/** Only the caller's authenticated/minted identity may be supplied here. */
export interface SentryBoundaryOptions extends TelemetryCatalog {
  actorId?: string;
  release?: string;
  environment?: "dev" | "staging" | "prod" | "preview" | "production" | "local" | "test";
}

function envelope(source: Fields, options: SentryBoundaryOptions): Fields {
  const eventId = token(source.event_id, /^[0-9a-f]{32}$/);
  const timestamp = bounded(source.timestamp, 100000000000);
  const actor = telemetryActorId(options.actorId);
  const release = token(
    options.release,
    /^(?:@mcpjam\/sdk@)?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$|^[0-9a-f]{7,40}$/
  );
  return {
    ...sentryProtocolMetadata([], options),
    ...(eventId ? { event_id: eventId } : {}),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(actor ? { user: { id: actor } } : {}),
    ...(release ? { release } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    tags: tags(source.tags),
  };
}

export function rebuildSentryEvent<T extends object>(
  input: T,
  options: SentryBoundaryOptions = {}
): T {
  const source = telemetryRecord(input);
  const chain = exceptions(source.exception, options);
  const extra = telemetryRecord(source.extra);
  const approvedMessage =
    member(source.message, options.messages ?? []) ??
    member(extra.message, options.messages ?? []);
  const message = approvedMessage ?? "telemetry_event";
  const breadcrumbs = Array.isArray(source.breadcrumbs)
    ? source.breadcrumbs
        .slice(-20)
        .map((value) => rebuildSentryBreadcrumb(telemetryRecord(value)))
        .filter(Boolean)
    : [];
  const ownedFrames = chain.values.flatMap((value) => value.stacktrace?.frames ?? []);
  const topFrame = ownedFrames.at(-1);
  const code = member(extra.code ?? extra.errorCode, options.diagnosticFields?.code ?? []);
  return {
    ...envelope(source, options),
    ...sentryProtocolMetadata(ownedFrames.map((frame) => String(frame.filename)), options),
    level: member(source.level, LEVELS) ?? "error",
    ...(chain.values.length
      ? {
          exception: { values: chain.values },
          ...(approvedMessage ? { message } : {}),
        }
      : { message }),
    fingerprint: [
      chain.values.at(-1)?.type ?? message,
      ...(chain.values.length && approvedMessage ? [approvedMessage] : []),
      ...(code ? [code] : []),
      ...(topFrame ? [`${topFrame.filename}:${topFrame.lineno}`] : []),
    ],
    extra: {
      ...(code ? { code } : {}),
      dropped_frames: Math.min(
        1000000,
        chain.dropped
      ),
    },
    ...(breadcrumbs.length ? { breadcrumbs } : {}),
  } as T;
}

export function rebuildSentrySpan<T extends object>(
  input: T,
  options: TelemetryCatalog = {}
): T {
  const source = telemetryRecord(input);
  const description =
    member(source.description, options.routes ?? []) ?? "unknown_operation";
  const spanId = token(source.span_id, /^[0-9a-f]{16}$/);
  const traceId = token(source.trace_id, /^[0-9a-f]{32}$/);
  const parentId = token(source.parent_span_id, /^[0-9a-f]{16}$/);
  const start = bounded(source.start_timestamp, 100000000000) ?? 0;
  const end = bounded(source.timestamp, 100000000000) ?? start;
  return {
    description,
    op:
      member(source.op, [
        "http.server",
        "http.client",
        "function",
        "navigation",
        "ui.action",
      ]) ?? "function",
    span_id: spanId ?? "0000000000000000",
    trace_id: traceId ?? "00000000000000000000000000000000",
    ...(parentId ? { parent_span_id: parentId } : {}),
    start_timestamp: start,
    timestamp: Math.max(start, end),
    data: {},
  } as T;
}

export function rebuildSentryTransaction<T extends object>(
  input: T,
  options: SentryBoundaryOptions = {}
): T {
  const source = telemetryRecord(input);
  const span = rebuildSentrySpan(source, options);
  const trace = rebuildSentrySpan(
    telemetryRecord(telemetryRecord(source.contexts).trace),
    options
  );
  return {
    ...envelope(source, options),
    type: "transaction",
    transaction:
      member(source.transaction, options.routes ?? []) ?? "unknown_operation",
    start_timestamp: span.start_timestamp,
    timestamp: span.timestamp,
    contexts: {
      trace: { trace_id: trace.trace_id, span_id: trace.span_id, op: trace.op },
    },
    spans: (Array.isArray(source.spans) ? source.spans.slice(0, 100) : []).map(
      (value) => rebuildSentrySpan(telemetryRecord(value), options)
    ),
  } as T;
}

/** The final transport serializer denies unrelated envelope families. */
export function restrictSentryEnvelope(
  envelope: { 0: unknown; 1: unknown[] },
  options: SentryBoundaryOptions = {}
): void {
  envelope[0] = {};
  const items = envelope[1].flatMap((item) => {
    if (!Array.isArray(item)) return [];
    const type = telemetryRecord(item[0]).type;
    if (type !== "event" && type !== "transaction" && type !== "span") return [];
    if (
      typeof item[1] !== "object" ||
      item[1] === null ||
      Array.isArray(item[1])
    )
      return [];
    const value =
      type === "event"
        ? rebuildSentryEvent(item[1], options)
        : type === "transaction" ? rebuildSentryTransaction(item[1], options) : rebuildSentrySpan(item[1], options);
    return [[{ type }, value]];
  });
  envelope[1].splice(0, envelope[1].length, ...items);
}

/** The only serializer before a vendor transport; all other families are denied. */
export function withSentryBoundary<T extends {
  send(envelope: never): PromiseLike<unknown>;
  flush(timeout?: number): PromiseLike<boolean>;
}>(transport: T, options: () => SentryBoundaryOptions, disabled: () => boolean): T {
  return {
    ...transport,
    send: async (value: { 0: unknown; 1: unknown[] }) => {
      if (disabled()) return {};
      restrictSentryEnvelope(value, options());
      return value[1].length ? transport.send(value as never) : {};
    },
    flush: (timeout?: number) => transport.flush(timeout),
  } as T;
}

/** Full-policy events still expose only verified file/line frame locations. */
export function rebuildSentryFrameLocations<T extends object>(input: T, catalog: TelemetryCatalog): T {
  const source = telemetryRecord(input);
  const stack = (value: unknown) => ({ frames: frames(telemetryRecord(value).frames, catalog).frames });
  const chain = (value: unknown) => {
    const row = telemetryRecord(value);
    return { ...row, values: (Array.isArray(row.values) ? row.values : []).map((entry) => {
      const item = telemetryRecord(entry);
      return { ...item, ...(item.stacktrace ? { stacktrace: stack(item.stacktrace) } : {}) };
    }) };
  };
  return { ...source,
    ...(source.stacktrace ? { stacktrace: stack(source.stacktrace) } : {}),
    ...(source.exception ? { exception: chain(source.exception) } : {}),
    ...(source.threads ? { threads: chain(source.threads) } : {}),
  } as T;
}
