import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    setTelemetryActor("user_A");
    setSessionPrivacy("full");
  });

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
      decodeCaptureContext(
        (event.properties as Record<string, unknown>)?.[
          TELEMETRY_CONTEXT_PROPERTY
        ],
      ),
    ).toEqual({
      projectIds: ["proj_1"],
      organizationIds: ["org_1"],
      policy: { recording: "full", identity: "full", content: "full" },
    });
  });

  it("keeps an event's own capture-time context when the view changes later", () => {
    setSessionPrivacy("masked");
    setTelemetryCaptureContext({
      projectIds: [],
      organizationIds: ["org_private"],
    });
    const captured = stampPostHogEvent({
      event: "send_message",
      properties: {},
    });
    setSessionPrivacy("full");
    setTelemetryCaptureContext({
      projectIds: [],
      organizationIds: ["org_public"],
    });
    expect(
      decodeCaptureContext(
        (captured.properties as Record<string, unknown>)?.[
          TELEMETRY_CONTEXT_PROPERTY
        ],
      ),
    ).toMatchObject({
      organizationIds: ["org_private"],
      policy: { recording: "off", content: "strict" },
    });
  });

  it("labels pending as off and an ungranted actor as id-only", () => {
    setSessionPrivacy("pending");
    const event = stampPostHogEvent({ event: "send_message", properties: {} });
    expect(
      (event.properties as Record<string, unknown>)?.[
        TELEMETRY_CONTEXT_PROPERTY
      ],
    ).toMatchObject({
      r: "off",
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
    expect(event).toBeNull();
  });

  it("removes the relay bearer from the replay's $posthog_config", () => {
    setTelemetryActor("user_A");
    setSessionPrivacy("full");
    setTelemetryCaptureContext({
      projectIds: ["project_1"],
      organizationIds: [],
    });
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

  it("drops a $snapshot whose frames it cannot vouch for", () => {
    // `replayFramesToSend` (session-privacy) decides which frames may leave;
    // an event it refuses is dropped rather than sent under a label.
    expect(
      stampPostHogEvent({
        event: "$snapshot",
        properties: { $snapshot_data: "not frames" },
      }),
    ).toBeNull();
  });

  it("rebuilds pending captures before SDK extras can leave and keeps the strict stamp when the view relaxes", () => {
    setSessionPrivacy("pending");
    const event = stampPostHogEvent({
      event: "send_message",
      properties: {
        location: "chat_tab",
        multi_model_count: 2,
        prompt: "SENTINEL",
        $device_id: "SENTINEL",
      },
    });
    expect(event).toMatchObject({
      event: "send_message",
      properties: { multi_model_count: 2 },
    });
    expect(JSON.stringify(event)).not.toContain("SENTINEL");
    setSessionPrivacy("full");
    expect(
      decodeCaptureContext(
        (event?.properties as Record<string, unknown>)?.[
          TELEMETRY_CONTEXT_PROPERTY
        ],
      )?.policy.content,
    ).toBe("strict");
    expect(
      stampPostHogEvent({ event: "$snapshot", properties: {} }),
    ).toBeNull();
  });

  it("passes a dropped event through", () => {
    expect(stampPostHogEvent(null)).toBeNull();
  });

  it("keeps unresolved, empty, anonymous and share contexts strict", () => {
    for (const level of ["masked", "pending", "off", "full"] as const) {
      setSessionPrivacy(level);
      expect(currentTelemetryCaptureContext().policy).toMatchObject({
        recording: "off",
        content: "strict",
      });
    }
    setTelemetryActor("user_A");
    setTelemetryCaptureContext({
      projectIds: ["project_1"],
      organizationIds: [],
    });
    expect(currentTelemetryCaptureContext().policy.content).toBe("full");
    setTelemetryCaptureContext({
      projectIds: ["project_1"],
      organizationIds: [],
      sharedLink: true,
    });
    expect(currentTelemetryCaptureContext().policy.content).toBe("strict");
  });

  it("labels replay off as off on a recording surface", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    try {
      const privacy = await import("../session-privacy");
      const context = await import("../telemetry-context");
      privacy.setSessionPrivacy("off");
      expect(context.currentTelemetryCaptureContext().policy.recording).toBe(
        "off",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
