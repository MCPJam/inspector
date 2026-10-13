import {
  rebuildSentryEvent,
  rebuildSentryTransaction,
  rebuildSentrySpan,
  INSPECTOR_SENTRY_CATALOG,
  type SentryBoundaryOptions,
} from "../../../shared/strict-sentry";
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
        __MCPJAM_TELEMETRY_CATALOG__?: Record<string, readonly string[]>;
      }
    ).__MCPJAM_TELEMETRY_CATALOG__ ?? {};
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return {
    ...INSPECTOR_SENTRY_CATALOG,
    frames: { ...INSPECTOR_SENTRY_CATALOG.frames, ...emitted },
    frameAliases: Object.fromEntries(
      Object.keys(emitted).map((name) => [`${origin}/${name}`, name]),
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

/** Recheck queued payloads at send time, after policy transitions. */
export function withStrictSentryTransport<T extends Transport>(
  transport: T,
): T {
  return {
    ...transport,
    send: async (envelope: Envelope) => {
      const replay = envelope[1].find(
        ([header]) => header.type === "replay_event",
      )?.[1] as { event_id?: string } | undefined;
      const hasRecording = envelope[1].some(
        ([header]) =>
          header.type === "replay_recording" || header.type === "replay_event",
      );
      const deniedReplay =
        hasRecording &&
        (!replay?.event_id || blockedReplayIds.has(replay.event_id));
      if (!strictSentryRequired()) {
        const allowed = deniedReplay
          ? envelope[1].filter(
              ([header]) =>
                !["replay_event", "replay_recording"].includes(
                  String(header.type),
                ),
            )
          : envelope[1];
        return allowed.length
          ? transport.send([envelope[0], allowed] as never)
          : {};
      }
      blockSentryReplay(replay?.event_id);
      const items: Envelope[1] = [];
      for (const [header, payload] of envelope[1]) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          continue;
        if (header.type === "event")
          items.push([
            { type: "event" },
            rebuildSentryEvent(payload, browserSentryOptions()),
          ]);
        if (header.type === "span" && "span_id" in payload)
          items.push([
            { type: "span" },
            rebuildSentrySpan(payload, browserSentryOptions()),
          ]);
        if (header.type === "transaction")
          items.push([
            { type: "transaction" },
            rebuildSentryTransaction(payload, browserSentryOptions()),
          ]);
      }
      // Unknown items, replay, attachments, profiles and logs have no strict contract.
      if (!items.length) return {};
      return transport.send([{}, items] as never);
    },
    flush: (timeout?: number) => transport.flush(timeout),
  } as T;
}
