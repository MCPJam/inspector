import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  content: "full",
  actor: "user_01K00000000000000000000000",
}));
vi.mock("../telemetry-context", () => ({
  currentTelemetryCaptureContext: () => ({
    policy: { content: state.content },
  }),
  currentTelemetryActor: () => state.actor,
  telemetryNamesAllowed: () => state.content === "full",
}));

import { stampSentryEvent } from "../sentry-capture-policy";
import { withInterimSentryPrivacy } from "../sentry-interim-transport";

beforeEach(() => {
  state.content = "full";
  state.actor = "user_01K00000000000000000000000";
});

function capture(id: string) {
  const event = {
    event_id: id.repeat(32),
    exception: { values: [{ type: "Error", value: "private" }] },
  };
  stampSentryEvent(event);
  return event;
}

function sender() {
  const send = vi.fn().mockResolvedValue({});
  return {
    send,
    transport: withInterimSentryPrivacy({
      send,
      flush: vi.fn().mockResolvedValue(true),
    }),
  };
}

it("retains a proven full envelope positive control", async () => {
  const { send, transport } = sender();
  const envelope = [{}, [[{ type: "event" }, capture("1")]]] as never;
  await transport.send(envelope);
  expect(send).toHaveBeenCalledWith(envelope);
});

it("suppresses every envelope after the current policy tightens", async () => {
  const { send, transport } = sender();
  const full = capture("2");
  state.content = "strict";
  await transport.send([{}, [[{ type: "event" }, full]]] as never);
  expect(send).not.toHaveBeenCalled();
});

it("never widens an original strict capture after the policy relaxes", async () => {
  const { send, transport } = sender();
  state.content = "strict";
  const strict = capture("3");
  state.content = "full";
  await transport.send([{}, [[{ type: "event" }, strict]]] as never);
  expect(send).not.toHaveBeenCalled();
});

it("suppresses unknown captures, actor changes and extra envelope families", async () => {
  const { send, transport } = sender();
  await transport.send([
    {},
    [[{ type: "event" }, { event_id: "4".repeat(32) }]],
  ] as never);
  const full = capture("5");
  for (const type of [
    "attachment",
    "span",
    "profile",
    "check_in",
    "client_report",
    "replay_recording",
  ]) {
    await transport.send([
      {},
      [
        [{ type: "event" }, full],
        [{ type }, new Uint8Array([1])],
      ],
    ] as never);
  }
  state.actor = "user_01K11111111111111111111111";
  await transport.send([{}, [[{ type: "event" }, full]]] as never);
  expect(send).not.toHaveBeenCalled();
});

it("only permits recordings paired with a proven full replay capture", async () => {
  const { send, transport } = sender();
  const replay = { ...capture("6"), type: "replay_event" };
  await transport.send([
    {},
    [
      [{ type: "replay_event" }, replay],
      [{ type: "replay_recording" }, new Uint8Array([1])],
    ],
  ] as never);
  expect(send).toHaveBeenCalledOnce();
  state.content = "strict";
  await transport.send([
    {},
    [
      [{ type: "replay_event" }, replay],
      [{ type: "replay_recording" }, new Uint8Array([1])],
    ],
  ] as never);
  expect(send).toHaveBeenCalledOnce();
});
