import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentTelemetryCaptureContext,
  resetTelemetryIdentity,
  setTelemetryActor,
  setTelemetryCaptureContext,
  setTelemetryIdentity,
  stampPostHogEvent,
  telemetryNamesAllowed,
} from "../telemetry-context";
import { setSessionPrivacy } from "../session-privacy";
import {
  decodeCaptureContext,
  TELEMETRY_CONTEXT_PROPERTY,
} from "@/shared/telemetry-privacy";

afterEach(() => {
  setTelemetryActor(null);
  setTelemetryCaptureContext({ projectIds: [], organizationIds: [] });
  setSessionPrivacy("pending");
});

describe("the identity grant", () => {
  beforeEach(() => setTelemetryActor("user_A"));

  it("is withheld until the backend answers full for the current actor", () => {
    expect(telemetryNamesAllowed()).toBe(false);
    setTelemetryIdentity("user_A", "id_only");
    expect(telemetryNamesAllowed()).toBe(false);
    setTelemetryIdentity("user_A", "full");
    expect(telemetryNamesAllowed()).toBe(true);
    expect(telemetryNamesAllowed("user_B")).toBe(false);
  });

  it("is cleared by an actor change and never granted by a stale answer", () => {
    setTelemetryIdentity("user_A", "full");
    setTelemetryActor("user_B");
    expect(telemetryNamesAllowed()).toBe(false);
    // user_A's answer arrives after the switch.
    setTelemetryIdentity("user_A", "full");
    expect(telemetryNamesAllowed()).toBe(false);
  });

  it("is cleared by a membership reload", () => {
    setTelemetryIdentity("user_A", "full");
    resetTelemetryIdentity();
    expect(telemetryNamesAllowed()).toBe(false);
  });

  it("is never granted to no one", () => {
    setTelemetryActor(null);
    setTelemetryIdentity(null, "full");
    expect(telemetryNamesAllowed()).toBe(false);
  });
});

describe("stampPostHogEvent", () => {
  it("stamps the contexts in view and the policy in effect at capture", () => {
    setTelemetryActor("user_A");
    setTelemetryIdentity("user_A", "full");
    setSessionPrivacy("full");
    setTelemetryCaptureContext({
      projectIds: ["proj_1", null],
      organizationIds: ["org_1", undefined, "org_1"],
    });
    const event = stampPostHogEvent({
      event: "$pageview",
      properties: { token: "t" },
    });
    expect(
      decodeCaptureContext(event.properties?.[TELEMETRY_CONTEXT_PROPERTY]),
    ).toEqual({
      projectIds: ["proj_1"],
      organizationIds: ["org_1"],
      policy: { recording: "full", identity: "full" },
    });
  });

  it("keeps an event's own capture-time context when the view changes later", () => {
    setSessionPrivacy("masked");
    setTelemetryCaptureContext({
      projectIds: [],
      organizationIds: ["org_private"],
    });
    const captured = stampPostHogEvent({ event: "x", properties: {} });
    setSessionPrivacy("full");
    setTelemetryCaptureContext({
      projectIds: [],
      organizationIds: ["org_public"],
    });
    expect(
      decodeCaptureContext(captured.properties?.[TELEMETRY_CONTEXT_PROPERTY]),
    ).toMatchObject({
      organizationIds: ["org_private"],
      policy: { recording: "masked" },
    });
  });

  it("labels pending as masked and an ungranted actor as id-only", () => {
    setSessionPrivacy("pending");
    const event = stampPostHogEvent({ event: "x", properties: {} });
    expect(event.properties?.[TELEMETRY_CONTEXT_PROPERTY]).toMatchObject({
      r: "masked",
      i: "id_only",
    });
  });

  it("keeps names off an event captured while id-only", () => {
    const event = stampPostHogEvent({
      event: "$identify",
      $set: { email: "e@example.com", name: "N", deployment: "hosted" },
      $set_once: { first_name: "F" },
      properties: { $set: { last_name: "L" }, $set_once: { occupation: "O" } },
    });
    expect(event.$set).toEqual({ deployment: "hosted" });
    expect(event.$set_once).toEqual({});
    expect(event.properties?.$set).toEqual({});
    expect(event.properties?.$set_once).toEqual({});
  });

  it("removes the relay bearer from the replay's $posthog_config", () => {
    const event = stampPostHogEvent({
      event: "$snapshot",
      properties: {
        $snapshot_data: [
          { type: 2, data: {} },
          {
            type: 5,
            data: {
              tag: "$posthog_config",
              payload: {
                config: {
                  api_host: "/tlm",
                  request_headers: { Authorization: "Bearer secret" },
                  xhr_headers: { Authorization: "Bearer secret" },
                },
              },
            },
          },
        ],
      },
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(
      (event.properties?.$snapshot_data as any[])[1].data.payload.config,
    ).toEqual({ api_host: "/tlm" });
  });

  it("passes a dropped event through", () => {
    expect(stampPostHogEvent(null)).toBeNull();
  });

  it("reports the policy in effect", () => {
    setSessionPrivacy("masked");
    expect(currentTelemetryCaptureContext().policy.recording).toBe("masked");
    setSessionPrivacy("pending");
    expect(currentTelemetryCaptureContext().policy.recording).toBe("masked");
    setSessionPrivacy("full");
    expect(currentTelemetryCaptureContext().policy.recording).toBe("full");
  });

  it("claims no restriction on an off surface, leaving it to the backend", () => {
    setSessionPrivacy("off");
    expect(currentTelemetryCaptureContext().policy.recording).toBe("full");
  });
});
