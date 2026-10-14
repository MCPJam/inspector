import { telemetryRecord } from "@mcpjam/sdk/internal/telemetry";
import { currentTelemetryActor, currentTelemetryCaptureContext, telemetryNamesAllowed } from "./telemetry-context";

type CapturePolicy = { strict: boolean; names: boolean; actorId?: string; drop?: boolean };
const captured = new WeakMap<object, CapturePolicy>();
const ids = new Map<string, CapturePolicy>();
const current = (): CapturePolicy => ({
  strict: currentTelemetryCaptureContext().policy.content !== "full",
  names: telemetryNamesAllowed(),
  actorId: currentTelemetryActor() ?? undefined,
});
const tighter = (a: CapturePolicy, b: CapturePolicy): CapturePolicy => ({
  strict: a.strict || b.strict || a.actorId !== b.actorId,
  names: a.names && b.names && a.actorId === b.actorId,
  actorId: a.actorId,
  drop: a.drop || b.drop,
});
const UNKNOWN: CapturePolicy = { strict: true, names: false };
function key(value: unknown, span = false): string | undefined {
  return typeof value === "string" && (span ? /^[0-9a-f]{16}$/ : /^[0-9a-f]{32}$/).test(value)
    ? `${span ? "s" : "e"}:${value}` : undefined;
}
function store(id: string | undefined, policy: CapturePolicy): void {
  if (!id) return;
  ids.set(id, ids.has(id) ? tighter(ids.get(id) ?? UNKNOWN, policy) : policy);
  if (ids.size > 4096) ids.delete(ids.keys().next().value ?? "");
}

/** Policy only: no event, span or breadcrumb content is rewritten at capture. */
export function stampSentryEvent(event: object, hint?: { event_id?: string }, drop = false): void {
  const row = telemetryRecord(event);
  const trace = telemetryRecord(telemetryRecord(row.contexts).trace);
  const spanId = key(trace.span_id, true);
  const root = row.type === "transaction" ? ids.get(spanId ?? "") ?? UNKNOWN : current();
  const policy = tighter(current(), root);
  policy.drop = drop;
  captured.set(event, tighter(captured.get(event) ?? policy, policy));
  store(key(row.event_id ?? hint?.event_id), policy);
}

export function stampSentrySpanStart(span: { spanContext(): { spanId: string } }): void {
  store(key(span.spanContext().spanId, true), current());
}

export function stampSentrySpanJson<T extends object>(span: T): T {
  const id = key(telemetryRecord(span).span_id, true);
  const policy = tighter(ids.get(id ?? "") ?? UNKNOWN, current());
  captured.set(span, policy);
  store(id, policy);
  return span;
}

export function sentryCapturePolicy(value: unknown, span = false): CapturePolicy {
  const row = telemetryRecord(value);
  const id = key(span ? row.span_id : row.event_id, span);
  const policy = typeof value === "object" && value !== null ? captured.get(value) : undefined;
  let result = tighter(policy ?? ids.get(id ?? "") ?? UNKNOWN, current());
  if (!span) {
    if (Array.isArray(row.spans) && row.spans.length > 1000) result = tighter(result, UNKNOWN);
    for (const child of Array.isArray(row.spans) ? row.spans.slice(0, 1000) : [])
      result = tighter(result, sentryCapturePolicy(child, true));
    for (const crumb of row.type !== "replay_event" && Array.isArray(row.breadcrumbs) ? row.breadcrumbs : [])
      result = tighter(result, ids.get(breadcrumbKey(crumb) ?? "") ?? UNKNOWN);
  }
  return result;
}

function breadcrumbKey(value: unknown): string | undefined {
  const timestamp = telemetryRecord(value).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? `b:${timestamp}` : undefined;
}

/** The SDK copies breadcrumbs; the shared timestamp keeps the stricter stamp through copies. */
export function stampSentryBreadcrumb(crumb: object): void {
  store(breadcrumbKey(crumb), current());
}
