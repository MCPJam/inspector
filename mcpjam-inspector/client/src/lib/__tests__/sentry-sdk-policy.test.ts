import * as Sentry from "@sentry/browser";
import type { Envelope } from "@sentry/core";
import { afterEach, expect, it, vi } from "vitest";
const policy = vi.hoisted(() => ({ strict: false }));
vi.mock("../telemetry-context", () => ({
  currentTelemetryActor: () => "user_01K00000000000000000000000",
  telemetryNamesAllowed: () => true,
  currentTelemetryCaptureContext: () => ({ policy: { content: policy.strict ? "strict" : "full" } }),
}));
import { withStrictSentryTransport } from "../strict-sentry-boundary";
import { stampSentryEvent, stampSentrySpanJson, stampSentrySpanStart, stampSentryBreadcrumb } from "../sentry-capture-policy";

afterEach(async () => { await Sentry.close(1000); Sentry.getIsolationScope().clear(); policy.strict = false; });
function initialize() {
  const sent: Envelope[] = [];
  Sentry.init({
    dsn: "https://public@example.ingest.sentry.io/123", integrations: [], tracesSampleRate: 1,
    beforeSendSpan: stampSentrySpanJson,
    transport: () => withStrictSentryTransport({ send: async (envelope: Envelope) => { sent.push(envelope); return {}; }, flush: async () => true }, (_type, payload) => payload),
  });
  const client = Sentry.getClient();
  client?.on("preprocessEvent", stampSentryEvent);
  client?.on("spanStart", stampSentrySpanStart);
  client?.on("beforeAddBreadcrumb", stampSentryBreadcrumb);
  return sent;
}

it("real SDK transaction ending full cannot relax a child started strict", async () => {
  const sent = initialize();
  const root = Sentry.startInactiveSpan({ name: "root", forceTransaction: true });
  policy.strict = true;
  const child = Sentry.withActiveSpan(root, () => Sentry.startInactiveSpan({ name: "SENTINEL", attributes: { content: "SENTINEL" } }));
  policy.strict = false;
  child.end();
  root.end();
  await Sentry.flush(1000);
  expect(sent).toHaveLength(1);
  expect(sent[0][1][0][0].type).toBe("transaction");
  expect(JSON.stringify(sent)).not.toContain("SENTINEL");
});

it("real SDK breadcrumb copies retain capture strictness when a later error is full", async () => {
  const sent = initialize();
  policy.strict = true;
  Sentry.addBreadcrumb({ category: "console", message: "SENTINEL", data: { content: "SENTINEL" } });
  policy.strict = false;
  Sentry.captureException(new TypeError("SENTINEL"));
  await Sentry.flush(1000);
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent)).toContain('"TypeError"');
  expect(JSON.stringify(sent)).not.toContain("SENTINEL");
});

it("real SDK full capture remains eligible and strict roots never relax", async () => {
  const sent = initialize();
  Sentry.captureMessage("FULL_POSITIVE");
  await Sentry.flush(1000);
  expect(JSON.stringify(sent)).toContain("FULL_POSITIVE");
  policy.strict = true;
  const root = Sentry.startInactiveSpan({ name: "SENTINEL", forceTransaction: true });
  policy.strict = false;
  root.end();
  await Sentry.flush(1000);
  expect(JSON.stringify(sent[1])).not.toContain("SENTINEL");
});
