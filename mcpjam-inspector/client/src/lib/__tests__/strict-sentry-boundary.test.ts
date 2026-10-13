import type { Envelope } from "@sentry/core";
import { afterEach, expect, it, vi } from "vitest";
const policy = vi.hoisted(() => ({ strict: true }));
vi.mock("../telemetry-context", () => ({
  currentTelemetryActor: () => "user_01K00000000000000000000000",
  currentTelemetryCaptureContext: () => ({
    policy: { content: policy.strict ? "strict" : "full" },
  }),
}));
import {
  browserSentryOptions,
  blockSentryReplay,
  withStrictSentryTransport,
} from "../strict-sentry-boundary";

afterEach(() => {
  policy.strict = true;
});
it("keeps useful errors, transactions and spans while dropping every unapproved envelope item", async () => {
  const send = vi.fn(async (_envelope: Envelope) => ({}));
  const transport = withStrictSentryTransport({
    send,
    flush: vi.fn(async () => true),
  });
  const unsafe = {
    message: "SENTINEL",
    request: { data: "SENTINEL" },
    extra: { prompt: "SENTINEL" },
    user: { email: "SENTINEL" },
  };
  const event = {
    ...unsafe,
    event_id: "a".repeat(32),
    exception: { values: [{ type: "TypeError", value: "SENTINEL" }] },
  };
  const items = [
    [{ type: "event", filename: "SENTINEL" }, event],
    [
      { type: "transaction" },
      { ...unsafe, spans: [{ ...unsafe, span_id: "b".repeat(16) }] },
    ],
    [
      { type: "span" },
      { ...unsafe, span_id: "b".repeat(16), trace_id: "a".repeat(32) },
    ],
    ...[
      "replay_event",
      "replay_recording",
      "attachment",
      "profile",
      "session",
      "log",
      "unknown",
    ].map((type) => [{ type }, unsafe]),
  ];
  await transport.send([{ trace: "SENTINEL" }, items] as never);
  expect(send).toHaveBeenCalledOnce();
  const output = send.mock.calls[0][0] as unknown as [
    unknown,
    Array<[Record<string, string>, Record<string, unknown>]>,
  ];
  expect(output[0]).toEqual({});
  expect(output[1].map(([header]) => header.type)).toEqual([
    "event",
    "transaction",
    "span",
  ]);
  expect(JSON.stringify(output)).not.toContain("SENTINEL");
  expect(output[1][0][1]).toMatchObject({
    exception: { values: [{ type: "TypeError", value: "TypeError" }] },
  });
});

it("rechecks an envelope created while full after the policy tightens, and retains eligible full behavior", async () => {
  const send = vi.fn(async (_envelope: Envelope) => ({}));
  const transport = withStrictSentryTransport({
    send,
    flush: vi.fn(async () => true),
  });
  const envelope = [
    {},
    [[{ type: "attachment" }, { text: "SENTINEL" }]],
  ] as never;
  policy.strict = false;
  await transport.send(envelope);
  expect(send).toHaveBeenLastCalledWith(envelope);
  policy.strict = true;
  send.mockClear();
  await transport.send(envelope);
  expect(send).not.toHaveBeenCalled();
});

it("never releases a revoked replay after eligibility returns", async () => {
  const send = vi.fn(async (_envelope: Envelope) => ({}));
  const transport = withStrictSentryTransport({
    send,
    flush: vi.fn(async () => true),
  });
  policy.strict = false;
  const envelope = (id: string) =>
    [
      {},
      [
        [{ type: "replay_event" }, { event_id: id }],
        [{ type: "replay_recording" }, "SENTINEL"],
      ],
    ] as never;
  blockSentryReplay("old-session");
  await transport.send(envelope("old-session"));
  expect(send).not.toHaveBeenCalled();
  await transport.send(envelope("new-session"));
  expect(send).toHaveBeenCalledOnce();
});

it("uses exact build-owned browser filenames and never accepts a matching customer basename", async () => {
  vi.stubGlobal("__MCPJAM_TELEMETRY_CATALOG__", {
    "assets/app-abc.js": ["knownFunction"],
  });
  const options = browserSentryOptions();
  expect(
    options.frameAliases?.[`${window.location.origin}/assets/app-abc.js`],
  ).toBe("assets/app-abc.js");
  expect(
    options.frameAliases?.["https://customer.example/assets/app-abc.js"],
  ).toBeUndefined();
  expect(options.frames?.["assets/app-abc.js"]).toEqual(["knownFunction"]);
  vi.unstubAllGlobals();
});
