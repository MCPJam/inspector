import { afterEach, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
vi.mock("../../utils/request-logger.js", () => ({
  getSystemLogger: () => ({ event: vi.fn() }),
}));
import relayRoutes, { relayBodyLimit } from "../relay";
import { setTelemetryPolicyQueryForTests } from "../../services/telemetry-privacy-policy";
import {
  CONSERVATIVE_TELEMETRY_POLICY,
  encodeCaptureContext,
  TELEMETRY_CONTEXT_PROPERTY,
} from "../../../shared/telemetry-privacy";
const token = "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
afterEach(() => {
  vi.unstubAllGlobals();
  setTelemetryPolicyQueryForTests(null);
});
it("forwards approved counters with authoritative identity, rebuilding batch and URL envelopes", async () => {
  setTelemetryPolicyQueryForTests(async () => ({
    ...CONSERVATIVE_TELEMETRY_POLICY,
    telemetryActorId: "user_from_backend",
  }));
  const upstream = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", upstream);
  const app = new Hono();
  app.use("/tlm/*", relayBodyLimit());
  app.route("/tlm", relayRoutes);
  const stamp = encodeCaptureContext({
    projectIds: [],
    organizationIds: ["org_test"],
    policy: CONSERVATIVE_TELEMETRY_POLICY,
  });
  const properties = {
    token,
    distinct_id: "SENTINEL",
    location: "chat_tab",
    multi_model_count: 2,
    prompt: "SENTINEL",
    [TELEMETRY_CONTEXT_PROPERTY]: stamp,
  };
  const response = await app.request(
    "http://localhost/tlm/e/?secret=SENTINEL",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: token,
        metadata: "SENTINEL",
        batch: [
          { event: "send_message", properties },
          { event: "$snapshot", properties },
          { event: "$exception", properties },
          { event: "$autocapture", properties },
        ],
      }),
    },
  );
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledOnce();
  const [url, init] = upstream.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  const body = gunzipSync(Buffer.from(init.body as Uint8Array)).toString();
  expect(body + url).not.toContain("SENTINEL");
  expect(JSON.parse(body)).toEqual({
    api_key: token,
    batch: [
      {
        event: "send_message",
        properties: {
          token,
          app_version: expect.stringMatching(/^\d+\.\d+\.\d+/),
          distinct_id: "user_from_backend",
          $process_person_profile: false,
          $geoip_disable: true,
          location: "chat_tab",
          multi_model_count: 2,
        },
      },
    ],
  });
});
