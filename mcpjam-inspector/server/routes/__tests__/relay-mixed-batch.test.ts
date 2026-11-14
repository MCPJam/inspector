import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { gunzipSync } from "node:zlib";
import relayRoutes, { relayBodyLimit } from "../relay";
import { setTelemetryPolicyQueryForTests } from "../../services/telemetry-privacy-policy";
import { POSTHOG_PROJECT_KEY } from "../../utils/analytics";
import {
  encodeCaptureContext,
  FULL_TELEMETRY_POLICY,
  CONSERVATIVE_TELEMETRY_POLICY,
  TELEMETRY_CONTEXT_PROPERTY,
} from "../../../shared/telemetry-privacy";

afterEach(() => {
  setTelemetryPolicyQueryForTests(null);
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "reconciles mixed-batch metadata and GeoIP regardless of order (%s)",
  async (reverse) => {
    const actor = "user_01K00000000000000000000000";
    setTelemetryPolicyQueryForTests(async () => ({
      ...FULL_TELEMETRY_POLICY,
      telemetryActorId: actor,
    }));
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{"status":1}'),
    );
    vi.stubGlobal("fetch", fetch);
    const app = new Hono();
    app.use("/tlm/*", relayBodyLimit());
    app.route("/tlm", relayRoutes);
    const timestamp = new Date(Date.now() - 1000).toISOString();
    const events = [
      {
        event: "send_message",
        uuid: "019a0000-0000-7000-8000-000000000001",
        timestamp,
        properties: {
          token: POSTHOG_PROJECT_KEY,
          distinct_id: actor,
          location: "chat_tab",
          prompt: "SENTINEL",
          [TELEMETRY_CONTEXT_PROPERTY]: encodeCaptureContext({
            projectIds: ["project_test"],
            organizationIds: [],
            policy: CONSERVATIVE_TELEMETRY_POLICY,
          }),
        },
      },
      {
        event: "full_control",
        uuid: "019a0000-0000-7000-8000-000000000002",
        timestamp,
        properties: {
          token: POSTHOG_PROJECT_KEY,
          distinct_id: actor,
          detail: "full retained",
          $ip: "203.0.113.1",
          [TELEMETRY_CONTEXT_PROPERTY]: encodeCaptureContext({
            projectIds: ["project_test"],
            organizationIds: [],
            policy: FULL_TELEMETRY_POLICY,
          }),
        },
      },
    ];
    const request = () =>
      app.request("https://app.example/tlm/i/v0/e/?ip=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer fixture",
          "x-mcpjam-telemetry-policy": "full",
          "x-forwarded-for": "203.0.113.1",
        },
        body: JSON.stringify(reverse ? [...events].reverse() : events),
      });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    const output = fetch.mock.calls.map((args) => {
      const options = args[1] as RequestInit;
      expect(new Headers(options.headers).has("x-forwarded-for")).toBe(false);
      return JSON.parse(
        gunzipSync(Buffer.from(options.body as Uint8Array)).toString(),
      );
    });
    const rows = (
      Array.isArray(output[0]) ? output[0] : output[0].batch
    ) as Array<{
      event: string;
      uuid: string;
      timestamp: string;
      properties: Record<string, unknown>;
    }>;
    const repeated = (
      Array.isArray(output[1]) ? output[1] : output[1].batch
    ) as Array<{
      event: string;
      uuid: string;
      timestamp: string;
      properties: Record<string, unknown>;
    }>;
    expect(rows.every((row) => row.properties.$geoip_disable === true)).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain("SENTINEL");
    expect(JSON.stringify(rows)).not.toContain("203.0.113.1");
    const strict = rows.find((row) => row.event === "send_message");
    expect(strict?.uuid).not.toBe(events[0].uuid);
    expect(strict?.uuid).toBe(
      repeated.find((row) => row.event === "send_message")?.uuid,
    );
    expect(strict?.timestamp).toBe(timestamp);
    expect(
      rows.find((row) => row.event === "full_control")?.properties,
    ).toMatchObject({ detail: "full retained" });
  },
);
