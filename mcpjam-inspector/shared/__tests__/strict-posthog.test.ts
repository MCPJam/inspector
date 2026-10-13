import { describe, expect, it } from "vitest";
import {
  rebuildStrictPostHogEvent,
  telemetryRouteTemplate,
} from "../strict-posthog";
const secret = "customer.example/PROJECT_SENTINEL?token=TOKEN_SENTINEL";
const product = {
  event: "send_message",
  timestamp: secret,
  $set: { name: secret },
  properties: {
    location: "chat_tab",
    multi_model_count: 2,
    multi_model_enabled: true,
    distinct_id: secret,
    model_name: secret,
    custom: { [secret]: secret },
    $exception_list: [{ value: secret }],
    $current_url: secret,
    $device_id: secret,
    $session_id: secret,
    $set: { name: secret },
    $ip: secret,
  },
};

describe("strict PostHog reconstruction", () => {
  it("retains an approved product signal and drops unknown envelope and SDK fields", () => {
    const result = rebuildStrictPostHogEvent(product);
    expect(result).toEqual({
      event: "send_message",
      properties: {
        token: expect.stringMatching(/^phc_/),
        app_version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        distinct_id: "strict",
        $process_person_profile: false,
        $geoip_disable: true,
        location: "chat_tab",
        multi_model_count: 2,
        multi_model_enabled: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(product.properties.model_name).toBe(secret);
  });

  it.each([
    "$snapshot",
    "$exception",
    "$autocapture",
    "$rageclick",
    "$survey_sent",
    "$identify",
    "$groupidentify",
    "unknown",
    "toString",
  ])("drops %s", (event) => {
    expect(rebuildStrictPostHogEvent({ ...product, event })).toBeNull();
  });

  it.each([NaN, Infinity, -1, 1.5, 1_000_001, secret])(
    "drops invalid numeric measurements %s",
    (multi_model_count) => {
      const result = rebuildStrictPostHogEvent({
        event: "send_message",
        properties: { multi_model_count, location: secret },
      });
      expect(result?.properties).not.toHaveProperty("multi_model_count");
      expect(result?.properties).not.toHaveProperty("location");
    },
  );

  it("templates routes while dropping hosts, titles and referrers", () => {
    expect(telemetryRouteTemplate(`https://${secret}`)).toBe("/:path");
    const result = rebuildStrictPostHogEvent({
      event: "$pageview",
      properties: {
        $current_url: `https://customer.example/projects/${secret}`,
        $referrer: secret,
        $title: secret,
      },
    });
    expect(result?.properties).toMatchObject({
      $pathname: "/projects/:projectId",
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

});
