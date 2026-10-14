import { sentryCapturePolicy } from "./sentry-capture-policy";
import { currentTelemetryCaptureContext } from "./telemetry-context";

type Envelope = [
  Record<string, unknown>,
  Array<[Record<string, unknown>, unknown]>,
];
interface Transport {
  send(envelope: never): PromiseLike<unknown>;
  flush(timeout?: number): PromiseLike<boolean>;
}

/** Until strict serialization activates, suppress every restricted envelope. */
export function withInterimSentryPrivacy<T extends Transport>(transport: T): T {
  return {
    ...transport,
    send: (envelope: Envelope) => {
      const replay = envelope[1].find(
        ([header]) => header.type === "replay_event",
      )?.[1];
      const blocked =
        currentTelemetryCaptureContext().policy.content !== "full" ||
        envelope[1].some(
          ([header, payload]) =>
            ![
              "event",
              "transaction",
              "replay_event",
              "replay_recording",
            ].includes(String(header.type)) ||
            sentryCapturePolicy(
              header.type === "replay_recording" ? replay : payload,
            ).strict,
        );
      return blocked ? Promise.resolve({}) : transport.send(envelope as never);
    },
    flush: (timeout?: number) => transport.flush(timeout),
  } as T;
}
