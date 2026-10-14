import type { Envelope } from "@sentry/core";
import { afterEach, expect, it, vi } from "vitest";
const policy = vi.hoisted(() => ({ strict: true, names: true, actor: "user_01K00000000000000000000000" }));
vi.mock("../telemetry-context", () => ({
  currentTelemetryActor: () => policy.actor,
  telemetryNamesAllowed: () => policy.names,
  currentTelemetryCaptureContext: () => ({ policy: { content: policy.strict ? "strict" : "full" } }),
}));
import { browserSentryOptions, blockSentryReplay, withStrictSentryTransport } from "../strict-sentry-boundary";
import { stampSentryEvent, stampSentrySpanJson, stampSentrySpanStart, stampSentryBreadcrumb } from "../sentry-capture-policy";

let sequence = 0;
const eventId = () => (++sequence).toString(16).padStart(32, "0");
const spanId = () => (++sequence).toString(16).padStart(16, "0");
function sender() {
  const send = vi.fn(async (_envelope: Envelope) => ({}));
  const full = vi.fn((_type: string, payload: Record<string, unknown>) => payload);
  const transport = withStrictSentryTransport({ send, flush: vi.fn(async () => true) }, full);
  const deliver = (type: string, payload: object) => transport.send([{}, [[{ type }, payload]]] as never);
  return { send, full, deliver, transport };
}
afterEach(() => { policy.strict = true; policy.names = true; policy.actor = "user_01K00000000000000000000000"; vi.unstubAllGlobals(); });

it("rebuilds unknown errors, transactions and spans and denies other envelope families", async () => {
  const { transport, send } = sender();
  const unsafe = { message: "SENTINEL", extra: { prompt: "SENTINEL" }, user: { email: "SENTINEL" } };
  const items = [
    [{ type: "event", filename: "SENTINEL" }, { ...unsafe, exception: { values: [{ type: "TypeError", value: "SENTINEL" }] } }],
    [{ type: "transaction" }, { ...unsafe, spans: [{ ...unsafe, span_id: spanId() }] }],
    [{ type: "span" }, { ...unsafe, span_id: spanId() }],
    ...["replay_event", "replay_recording", "attachment", "profile", "session", "log", "unknown"].map((type) => [{ type }, unsafe]),
  ];
  await transport.send([{ trace: "SENTINEL" }, items] as never);
  const output = send.mock.calls[0][0];
  expect(output[0]).toEqual({});
  expect(output[1].map(([header]) => header.type)).toEqual(["event", "transaction", "span"]);
  expect(JSON.stringify(output)).not.toContain("SENTINEL");
});

it("stamps without changing payload, keeps resolved full positives, and tightens queued events", async () => {
  const { deliver, send } = sender();
  policy.strict = false;
  const event = { event_id: eventId(), message: "FULL_POSITIVE" };
  stampSentryEvent(event);
  expect(event.message).toBe("FULL_POSITIVE");
  await deliver("event", structuredClone(event));
  expect(JSON.stringify(send.mock.calls[0])).toContain("FULL_POSITIVE");
  policy.strict = true;
  await deliver("event", structuredClone(event));
  expect(JSON.stringify(send.mock.calls[1])).not.toContain("FULL_POSITIVE");
  const strictEvent = { event_id: eventId(), message: "SENTINEL" };
  stampSentryEvent(strictEvent);
  policy.strict = false;
  await deliver("event", strictEvent);
  expect(JSON.stringify(send.mock.calls[2])).not.toContain("SENTINEL");
});

it("never relaxes standalone spans or strict children inside full transactions", async () => {
  const { deliver, send } = sender();
  policy.strict = false;
  const root = spanId();
  stampSentrySpanStart({ spanContext: () => ({ spanId: root }) });
  policy.strict = true;
  const child = { span_id: spanId(), description: "SENTINEL", data: { content: "SENTINEL" } };
  stampSentrySpanStart({ spanContext: () => ({ spanId: child.span_id }) });
  policy.strict = false;
  expect(stampSentrySpanJson(child)).toBe(child);
  await deliver("span", child);
  const transaction = { type: "transaction", event_id: eventId(), contexts: { trace: { span_id: root } }, spans: [child] };
  stampSentryEvent(transaction);
  await deliver("transaction", transaction);
  expect(JSON.stringify(send.mock.calls)).not.toContain("SENTINEL");
  const full = { span_id: spanId(), data: { content: "FULL_POSITIVE" } };
  stampSentrySpanStart({ spanContext: () => ({ spanId: full.span_id }) });
  stampSentrySpanJson(full);
  await deliver("span", full);
  expect(JSON.stringify(send.mock.calls[2])).toContain("FULL_POSITIVE");
});

it("tightens copied strict breadcrumbs and actor changes at send", async () => {
  const { deliver, send, full } = sender();
  const crumb = { timestamp: ++sequence, message: "SENTINEL" };
  stampSentryBreadcrumb(crumb);
  policy.strict = false;
  const event = { event_id: eventId(), breadcrumbs: [{ ...crumb }] };
  stampSentryEvent(event);
  await deliver("event", event);
  expect(JSON.stringify(send.mock.calls)).not.toContain("SENTINEL");
  const named = { event_id: eventId(), user: { email: "SENTINEL" } };
  stampSentryEvent(named);
  policy.actor = "user_01K00000000000000000000001";
  await deliver("event", named);
  expect(full).not.toHaveBeenCalled();
  expect(JSON.stringify(send.mock.calls)).not.toContain("SENTINEL");
});

it("uses the replay SDK's hint ID and denies recording after replay revocation", async () => {
  const { transport, send } = sender();
  policy.strict = false;
  const id = eventId();
  // Installed Replay emits preprocessEvent before event_id is copied from this hint.
  stampSentryEvent({ type: "replay_event" }, { event_id: id });
  const envelope = () => [{}, [[{ type: "replay_event" }, { event_id: id }], [{ type: "replay_recording" }, '{"segment_id":0}\n[{"type":3,"data":{},"timestamp":1}]']]];
  await transport.send(envelope() as never);
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0][1]).toHaveLength(2);
  blockSentryReplay(id);
  await transport.send(envelope() as never);
  expect(send).toHaveBeenCalledOnce();
});

it("accepts exact emitted asset URLs but rejects customer origins sharing their basename", () => {
  vi.stubGlobal("__MCPJAM_TELEMETRY_FILES__", ["assets/app-abc.js"]);
  const options = browserSentryOptions();
  expect(options.frameAliases?.[`${window.location.origin}/assets/app-abc.js`]).toBe("assets/app-abc.js");
  expect(options.frameAliases?.["https://customer.example/assets/app-abc.js"]).toBeUndefined();
  expect(options.files).toContain("assets/app-abc.js");
});

it("does not miss a strict child beyond the first hundred full spans", async () => {
  const { deliver, send } = sender();
  policy.strict = false;
  const root = spanId();
  stampSentrySpanStart({ spanContext: () => ({ spanId: root }) });
  const spans = Array.from({ length: 101 }, () => {
    const span = { span_id: spanId(), description: "full" };
    stampSentrySpanStart({ spanContext: () => ({ spanId: span.span_id }) });
    return stampSentrySpanJson(span);
  });
  policy.strict = true;
  const child = { span_id: spanId(), description: "SENTINEL" };
  stampSentrySpanStart({ spanContext: () => ({ spanId: child.span_id }) });
  policy.strict = false;
  spans.push(stampSentrySpanJson(child));
  const event = { type: "transaction", event_id: eventId(), contexts: { trace: { span_id: root } }, spans };
  stampSentryEvent(event);
  await deliver("transaction", event);
  expect(JSON.stringify(send.mock.calls)).not.toContain("SENTINEL");
  expect(JSON.stringify(send.mock.calls)).toContain("unknown_operation");
});
