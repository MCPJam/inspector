import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { EventHint } from "@sentry/core";
const { init, send, on } = vi.hoisted(() => ({ init: vi.fn(), send: vi.fn(async (_value: unknown) => ({})), on: vi.fn() }));
vi.mock("@sentry/react", () => ({ init, getClient: () => ({ on }), makeFetchTransport: () => ({ send, flush: async () => true }), browserTracingIntegration: () => ({ name: "Tracing" }), setUser: vi.fn(), setTag: vi.fn() }));
const actor = "user_01K00000000000000000000000";
let sequence = 500;
beforeEach(() => { vi.stubGlobal("__APP_VERSION__", "3.16.0"); vi.stubGlobal("__BUILD_SURFACE__", "web"); vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true"); vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false"); init.mockClear(); send.mockClear(); on.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
async function setup() {
  const privacy = await import("../session-privacy");
  const context = await import("../telemetry-context");
  context.setTelemetryActor(actor);
  context.setTelemetryIdentity(actor, "full");
  context.setTelemetryCaptureContext({ projectIds: ["project_test"], organizationIds: [] });
  context.setTelemetryContentPolicy(actor, "full");
  privacy.setSessionPrivacy("full");
  const identity = await import("../sentry-identity");
  identity.setSentryActor({ id: actor, kind: "signedIn", email: "account@example.test", name: "Account" });
  (await import("../sentry")).initSentry();
  const options = init.mock.calls[0][0];
  const transport = options.transport({});
  const hooks = await import("../sentry-capture-policy");
  const deliver = async (type: string, payload: Record<string, unknown>, hint: EventHint = {}) => {
    const event: Record<string, unknown> = { event_id: (++sequence).toString(16).padStart(32, "0"), ...payload };
    if (type === "span") {
      hooks.stampSentrySpanStart({ spanContext: () => ({ spanId: String(event.span_id) }) });
      hooks.stampSentrySpanJson(event);
    } else on.mock.calls.find(([name]) => name === "preprocessEvent")?.[1](event, hint);
    await transport.send([{}, [[{ type }, event]]]);
    return event;
  };
  return { options, transport, hooks, deliver, privacy, context };
}

it("wires capture stamps only and applies credential/identity/frame rules in the final full event serializer", async () => {
  const { options, hooks, deliver } = await setup();
  expect(options.beforeSend).toBeUndefined();
  expect(options.beforeBreadcrumb).toEqual(expect.any(Function));
  expect(on.mock.calls.map(([name]) => name)).toEqual(["preprocessEvent", "spanStart", "beforeAddBreadcrumb"]);
  const crumb = { timestamp: 999, category: "console", message: "tool result { body: secret }", data: { arguments: ["result", { body: "secret" }] } };
  hooks.stampSentryBreadcrumb(crumb);
  const input = await deliver("event", {
    message: "open /results/CREDENTIAL_SENTINEL",
    request: { url: "https://app.mcpjam.com/servers/owned?code=CREDENTIAL_SENTINEL" },
    user: { id: actor, email: "account@example.test", name: "Account" },
    breadcrumbs: [crumb],
    exception: { values: [{ type: "TypeError", value: "/results/CREDENTIAL_SENTINEL", stacktrace: { frames: [{ filename: "client/src/lib/sentry.ts", lineno: 12, function: "FRAME_SENTINEL", pre_context: ["FRAME_SENTINEL"] }, { filename: "/customer/FRAME_SENTINEL.js", lineno: 1 }] } }] },
  });
  expect(JSON.stringify(input)).toContain("CREDENTIAL_SENTINEL");
  const output = JSON.stringify(send.mock.calls[0]);
  expect(output).not.toMatch(/CREDENTIAL_SENTINEL|FRAME_SENTINEL/);
  expect(output).toContain("account@example.test");
  expect(output).toContain('"filename":"client/src/lib/sentry.ts"');
  expect(output).toContain("/servers/owned");
  expect(output).not.toContain('"body":"secret"');
});

it("preserves full span and replay positives while removing credentials and late opt-outs", async () => {
  const { deliver, transport } = await setup();
  await deliver("span", { span_id: "ab".repeat(8), description: "GET /results/CREDENTIAL_SENTINEL", data: { transaction: "/servers/owned", url: "/oauth/callback?code=CREDENTIAL_SENTINEL" }, stacktrace: { frames: [{ filename: "client/src/lib/sentry.ts", lineno: 12, function: "FRAME_SENTINEL", pre_context: ["FRAME_SENTINEL"] }] } });
  await deliver("replay_event", { type: "replay_event", urls: ["https://app.mcpjam.com/evals/shared/CREDENTIAL_SENTINEL"], user: { id: actor, email: "account@example.test" } });
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(send.mock.calls)).not.toMatch(/CREDENTIAL_SENTINEL|FRAME_SENTINEL/);
  expect(JSON.stringify(send.mock.calls)).toContain("/servers/owned");
  // Config is immutable, but the standard browser opt-out is read at every send.
  vi.stubGlobal("navigator", { doNotTrack: "1" });
  await transport.send([{}, [[{ type: "event" }, { message: "OPT_OUT_SENTINEL" }]]]);
  expect(send).toHaveBeenCalledTimes(2);
});

it.each(["full", "off"] as const)("drops hinted refusals before %s transport delivery", async (level) => {
  const { deliver, privacy } = await setup();
  privacy.setSessionPrivacy(level);
  for (const kind of ["forbidden", "session_revoked", "unauthenticated"]) {
    await deliver("event", { exception: { values: [{ type: "Error", value: kind }] } }, { originalException: new ConvexError({ kind }) });
  }
  expect(send).not.toHaveBeenCalled();
  await deliver("event", { exception: { values: [{ type: "TypeError", value: "real failure" }] } });
  expect(send).toHaveBeenCalledOnce();
});
