import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  currentTelemetryCaptureContext,
  setTelemetryActor,
  setTelemetryCaptureContext,
  setTelemetryContentPolicy,
  setTelemetryIdentity,
  stampPostHogEvent,
  subscribeTelemetryPolicy,
} from "../telemetry-context";
import { setSessionPrivacy, syncSessionRecording } from "../session-privacy";
import {
  decodeCaptureContext,
  TELEMETRY_CONTEXT_PROPERTY,
} from "@/shared/telemetry-privacy";

const actor = "user_01K00000000000000000000000";
beforeEach(() => {
  setTelemetryActor(actor);
  setTelemetryCaptureContext({
    projectIds: ["project_1"],
    organizationIds: [],
  });
  setTelemetryIdentity(actor, "full");
  setSessionPrivacy("pending");
});
afterEach(() => {
  setTelemetryActor(null);
  vi.unstubAllGlobals();
});

it("permits answered product content before replay settles", () => {
  expect(currentTelemetryCaptureContext().policy.content).toBe("strict");
  setTelemetryContentPolicy(actor, "full");
  expect(currentTelemetryCaptureContext().policy).toEqual({
    content: "full",
    identity: "full",
    recording: "off",
  });
  setSessionPrivacy("full");
  expect(currentTelemetryCaptureContext().policy.recording).toBe("full");
});

it("keeps local replay off while permitting authenticated content", () => {
  setSessionPrivacy("off");
  setTelemetryContentPolicy(actor, "full");
  expect(currentTelemetryCaptureContext().policy).toEqual({
    content: "full",
    identity: "full",
    recording: "off",
  });
});

it("keeps Electron strict despite a permissive account", () => {
  vi.stubGlobal("window", { ...window, isElectron: true });
  setTelemetryContentPolicy(actor, "full");
  expect(currentTelemetryCaptureContext().policy).toEqual({
    content: "strict",
    identity: "id_only",
    recording: "off",
  });
});

it("notifies a strict context transition before a later full grant", () => {
  setTelemetryContentPolicy(actor, "full");
  const seen: string[] = [];
  const unsubscribe = subscribeTelemetryPolicy(() =>
    seen.push(currentTelemetryCaptureContext().policy.content),
  );
  setTelemetryCaptureContext({
    projectIds: ["project_2"],
    organizationIds: [],
  });
  const captured = stampPostHogEvent({ event: "send_message", properties: {} });
  setTelemetryContentPolicy(actor, "full");
  unsubscribe();
  expect(seen).toEqual(["strict", "full"]);
  expect(
    decodeCaptureContext(captured.properties[TELEMETRY_CONTEXT_PROPERTY])
      ?.policy.content,
  ).toBe("strict");
});

it("rejects absent actors, stale grants, missing contexts and share pages", () => {
  setTelemetryContentPolicy("another_actor", "full");
  expect(currentTelemetryCaptureContext().policy.content).toBe("strict");
  for (const ids of [
    { projectIds: [], organizationIds: [] },
    { projectIds: ["project_1"], organizationIds: [], sharedLink: true },
  ]) {
    setTelemetryCaptureContext(ids);
    setTelemetryContentPolicy(actor, "full");
    expect(currentTelemetryCaptureContext().policy.content).toBe("strict");
  }
  setTelemetryActor(null);
  setTelemetryContentPolicy(null, "full");
  expect(currentTelemetryCaptureContext().policy.content).toBe("strict");
});

it("enables local product capture without starting replay and preserves masked profiles", () => {
  const client = {
    set_config: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
  };
  setTelemetryContentPolicy(actor, "full");
  setSessionPrivacy("off");
  syncSessionRecording(client, "/servers");
  expect(client.set_config).toHaveBeenLastCalledWith(
    expect.objectContaining({
      autocapture: true,
      capture_exceptions: false,
      mask_all_text: false,
      disable_session_recording: true,
    }),
  );
  expect(client.startSessionRecording).not.toHaveBeenCalled();
  setSessionPrivacy("masked");
  syncSessionRecording(client, "/servers");
  expect(client.set_config).toHaveBeenLastCalledWith(
    expect.objectContaining({ mask_all_text: true }),
  );
});
