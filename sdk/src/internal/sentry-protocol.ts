/** Build-owned metadata only: callers never supply event/debug payloads here. */
export interface SentryBuildMetadata {
  frameOutputNames?: Readonly<Record<string, string>>;
  frameDebugIds?: Readonly<Record<string, string>>;
  platform?: "javascript" | "node";
  dist?: string;
}

const DEBUG_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUILD_SURFACES = [
  "web",
  "npm",
  "desktop-mac",
  "desktop-win",
  "electron-mac",
  "electron-win",
  "local",
];

/** Read only the build tool's injected marker, never an event's debug metadata. */
export function sentryInjectedDebugId(code: string): string | undefined {
  const id =
    /_sentryDebugIdIdentifier\s*=\s*["']sentry-dbid-([0-9a-f-]{36})["']/.exec(
      code
    )?.[1] ?? /(?:^|\n)\/\/# debugId=([0-9a-f-]{36})\s*$/.exec(code)?.[1];
  return id && DEBUG_ID.test(id) ? id : undefined;
}

export function sentryEventId(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value)
    ? value
    : crypto.randomUUID().replaceAll("-", "");
}

export function sentryProtocolMetadata(
  files: readonly string[],
  options: SentryBuildMetadata
) {
  const images = [...new Set(files)].flatMap((file) => {
    const debugId = options.frameDebugIds?.[file];
    return debugId && DEBUG_ID.test(debugId)
      ? [{ type: "sourcemap", code_file: file, debug_id: debugId }]
      : [];
  });
  return {
    ...(options.platform === "javascript" || options.platform === "node"
      ? { platform: options.platform }
      : {}),
    ...(options.dist && BUILD_SURFACES.includes(options.dist)
      ? { dist: options.dist }
      : {}),
    ...(images.length ? { debug_meta: { images } } : {}),
  };
}

/** IDs are copied only from a reconstructed event; transmission time is local. */
export function sentryEnvelopeHeaders(eventId: unknown) {
  return {
    ...(typeof eventId === "string" && /^[0-9a-f]{32}$/.test(eventId)
      ? { event_id: eventId }
      : {}),
    sent_at: new Date().toISOString(),
  };
}

const REPORT_REASONS = [
  "before_send",
  "event_processor",
  "sample_rate",
  "network_error",
  "queue_overflow",
  "ratelimit_backoff",
  "internal_sdk_error",
  "send_error",
  "insufficient_data",
];
const REPORT_CATEGORIES = [
  "error",
  "transaction",
  "span",
  "replay",
  "attachment",
  "session",
  "profile",
  "log_item",
  "default",
];

/** Client reports contain only finite counters; rejected report payloads do not recurse. */
export function rebuildSentryClientReport(
  input: Record<string, unknown>
): object | null {
  if (
    typeof input.timestamp !== "number" ||
    !Number.isFinite(input.timestamp) ||
    input.timestamp < 0 ||
    input.timestamp > 1e11
  )
    return null;
  const rows = Array.isArray(input.discarded_events)
    ? input.discarded_events.slice(0, 100)
    : [];
  const discarded_events = rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const { reason, category, quantity } = row;
    return typeof reason === "string" &&
      REPORT_REASONS.includes(reason) &&
      typeof category === "string" &&
      REPORT_CATEGORIES.includes(category) &&
      typeof quantity === "number" &&
      Number.isSafeInteger(quantity) &&
      quantity > 0 &&
      quantity <= 1e6
      ? [{ reason, category, quantity }]
      : [];
  });
  return discarded_events.length
    ? { timestamp: input.timestamp, discarded_events }
    : null;
}

export type SentryDropCategory =
  | "error"
  | "transaction"
  | "span"
  | "replay"
  | "attachment"
  | "session"
  | "profile"
  | "log_item"
  | "default";
export type SentryDropCounter = (
  reason: "before_send",
  category: SentryDropCategory,
  count: number
) => void;
export function sentryDropCategory(type: unknown): SentryDropCategory {
  if (type === "event") return "error";
  if (type === "replay_event" || type === "replay_recording") return "replay";
  return typeof type === "string" && REPORT_CATEGORIES.includes(type)
    ? (type as SentryDropCategory)
    : "default";
}
