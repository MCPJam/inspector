import {
  rebuildSentryEvent,
  rebuildSentryTransaction,
  rebuildSentrySpan,
  BROWSER_SENTRY_CATALOG,
  BROWSER_SENTRY_SOURCE_FILES,
  sentryEnvelopeHeaders,
  sentryEventId,
  rebuildSentryClientReport,
  sentryDropCategory,
  type SentryDropCounter,
  type SentryBoundaryOptions,
} from "../../../shared/strict-sentry";
import { sentryCapturePolicy } from "./sentry-capture-policy";
import { filterRecordingEnvelope } from "./sentry-recording-filter";
import {
  currentTelemetryActor,
  currentTelemetryCaptureContext,
} from "./telemetry-context";

export function strictSentryRequired(): boolean {
  return window.isElectron === true || currentTelemetryCaptureContext().policy.content === "strict";
}

export function browserSentryOptions(): SentryBoundaryOptions {
  const emitted =
    (
      globalThis as {
        __MCPJAM_TELEMETRY_FILES__?: readonly string[];
      }
    ).__MCPJAM_TELEMETRY_FILES__ ?? [];
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const debugIds = (globalThis as { __MCPJAM_TELEMETRY_DEBUG_IDS__?: Record<string, string> }).__MCPJAM_TELEMETRY_DEBUG_IDS__ ?? {};
  return {
    ...BROWSER_SENTRY_CATALOG,
    files: [...(import.meta.env.DEV ? BROWSER_SENTRY_SOURCE_FILES : []), ...emitted],
    frameAliases: Object.fromEntries(
      emitted.map((name) => [`${origin}/${name}`, name]),
    ),
    frameOutputNames: Object.fromEntries(emitted.map((name) => [name, `app:///${name}`])),
    frameDebugIds: Object.fromEntries(emitted.flatMap((name) => debugIds[name] ? [[`app:///${name}`, debugIds[name]]] : [])),
    actorId: currentTelemetryActor() ?? undefined,
    release: __APP_VERSION__,
    environment: import.meta.env.PROD ? "prod" : "dev",
    platform: "javascript",
    dist: __BUILD_SURFACE__,
  };
}

const blockedReplayIds = new Set<string>();
export function blockSentryReplay(id: unknown): void {
  if (typeof id === "string") blockedReplayIds.add(id);
}

type Envelope = [
  Record<string, unknown>,
  Array<[Record<string, unknown>, unknown]>,
];
interface Transport {
  send(envelope: never): PromiseLike<unknown>;
  flush(timeout?: number): PromiseLike<boolean>;
}

/** One final serializer selects the stricter capture/send policy for each item. */
export function withStrictSentryTransport<T extends Transport>(
  transport: T,
  fullEvent: (type: string, payload: Record<string, unknown>, names: boolean) => object | null,
  disabled: () => boolean | Promise<boolean> = () => false,
  onDrop?: SentryDropCounter,
): T {
  return {
    ...transport,
    send: async (envelope: Envelope) => {
      // Decompression can yield; choose the live policy only after it finishes.
      if (await disabled()) return {};
      const ready = await filterRecordingEnvelope(envelope);
      if (await disabled()) return {};
      const replay = ready[1].find(([header]) => header.type === "replay_event")?.[1];
      const replayId = (replay as { event_id?: string } | undefined)?.event_id;
      const replayPolicy = sentryCapturePolicy(replay);
      if (replayPolicy.strict) blockSentryReplay(replayId);
      const items: Envelope[1] = [];
      let hasEvent = false;
      for (const [header, payload] of ready[1]) {
        const type = String(header.type);
        if (type === "client_report" && payload && typeof payload === "object" && !Array.isArray(payload)) {
          const report = rebuildSentryClientReport(payload as Record<string, unknown>);
          if (report) items.push([{ type }, report]);
          continue;
        }
        if (type === "replay_recording") {
          if (!replayPolicy.strict && replayId && !blockedReplayIds.has(replayId)) items.push([header, payload]);
          continue;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        const eventFamily = ["event", "transaction", "replay_event"].includes(type);
        if (eventFamily && hasEvent) continue;
        const policy = sentryCapturePolicy(payload, type === "span");
        if (policy.drop) continue;
        policy.strict ||= strictSentryRequired();
        if (!policy.strict) {
          if (!["event", "transaction", "span", "replay_event"].includes(type)) continue;
          if (type === "replay_event" && (!replayId || blockedReplayIds.has(replayId))) continue;
          const clean = fullEvent(type, payload as Record<string, unknown>, policy.names);
          if (clean) {
            items.push([{ type }, eventFamily ? { ...clean, event_id: sentryEventId("event_id" in clean ? clean.event_id : undefined) } : clean]);
            hasEvent ||= eventFamily;
          }
          continue;
        }
        const options = { ...browserSentryOptions(), actorId: policy.actorId };
        if (type === "event") { items.push([{ type }, rebuildSentryEvent(payload, options)]); hasEvent = true; }
        if (type === "span" && "span_id" in payload) items.push([{ type }, rebuildSentrySpan(payload, options)]);
        if (type === "transaction") { items.push([{ type }, rebuildSentryTransaction(payload, options)]); hasEvent = true; }
      }
      const kept = items.map(([header]) => String(header.type));
      for (const [header] of envelope[1]) {
        const type = String(header.type);
        const index = kept.indexOf(type);
        if (index >= 0) kept.splice(index, 1);
        else if (type !== "client_report") onDrop?.("before_send", sentryDropCategory(type), 1);
      }
      if (!items.length) return {};
      const event = items.find(([header]) => ["event", "transaction", "replay_event"].includes(String(header.type)))?.[1];
      const eventId = event && typeof event === "object" && "event_id" in event ? event.event_id : undefined;
      return transport.send([sentryEnvelopeHeaders(eventId), items] as never);
    },
    flush: (timeout?: number) => transport.flush(timeout),
  } as T;
}
