import {
  rebuildSentryEvent,
  rebuildSentryTransaction,
  rebuildSentrySpan,
  INSPECTOR_SENTRY_CATALOG,
  type SentryBoundaryOptions,
} from "../../../shared/strict-sentry";
import { sentryCapturePolicy } from "./sentry-capture-policy";
import { filterRecordingEnvelope } from "./sentry-recording-filter";
import {
  currentTelemetryActor,
  currentTelemetryCaptureContext,
} from "./telemetry-context";

export function strictSentryRequired(): boolean {
  return currentTelemetryCaptureContext().policy.content === "strict";
}

export function browserSentryOptions(): SentryBoundaryOptions {
  const emitted =
    (
      globalThis as {
        __MCPJAM_TELEMETRY_FILES__?: readonly string[];
      }
    ).__MCPJAM_TELEMETRY_FILES__ ?? [];
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return {
    ...INSPECTOR_SENTRY_CATALOG,
    files: [...INSPECTOR_SENTRY_CATALOG.files, ...emitted],
    frameAliases: Object.fromEntries(
      emitted.map((name) => [`${origin}/${name}`, name]),
    ),
    actorId: currentTelemetryActor() ?? undefined,
    release: __APP_VERSION__,
    environment: import.meta.env.PROD ? "production" : "dev",
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
  disabled: () => boolean = () => false,
): T {
  return {
    ...transport,
    send: async (envelope: Envelope) => {
      // Decompression can yield; choose the live policy only after it finishes.
      if (disabled()) return {};
      const ready = await filterRecordingEnvelope(envelope);
      if (disabled()) return {};
      const replay = ready[1].find(([header]) => header.type === "replay_event")?.[1];
      const replayId = (replay as { event_id?: string } | undefined)?.event_id;
      const replayPolicy = sentryCapturePolicy(replay);
      if (replayPolicy.strict) blockSentryReplay(replayId);
      const items: Envelope[1] = [];
      for (const [header, payload] of ready[1]) {
        const type = String(header.type);
        if (type === "replay_recording") {
          if (!replayPolicy.strict && replayId && !blockedReplayIds.has(replayId)) items.push([header, payload]);
          continue;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        const policy = sentryCapturePolicy(payload, type === "span");
        if (!policy.strict) {
          if (!["event", "transaction", "span", "replay_event"].includes(type)) continue;
          if (type === "replay_event" && (!replayId || blockedReplayIds.has(replayId))) continue;
          const clean = fullEvent(type, payload as Record<string, unknown>, policy.names);
          if (clean) items.push([{ type }, clean]);
          continue;
        }
        const options = { ...browserSentryOptions(), actorId: policy.actorId };
        if (type === "event") items.push([{ type }, rebuildSentryEvent(payload, options)]);
        if (type === "span" && "span_id" in payload) items.push([{ type }, rebuildSentrySpan(payload, options)]);
        if (type === "transaction") items.push([{ type }, rebuildSentryTransaction(payload, options)]);
      }
      if (!items.length) return {};
      return transport.send([{}, items] as never);
    },
    flush: (timeout?: number) => transport.flush(timeout),
  } as T;
}
