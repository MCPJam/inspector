import { describe, expect, it } from "vitest";
import { rebuildStrictPostHogEvent } from "../strict-posthog";
import { applyEventPolicy } from "../../server/routes/relay-privacy";
import { CONSERVATIVE_TELEMETRY_POLICY } from "../telemetry-privacy";

const secret = "customer.example/PROJECT_SENTINEL?token=TOKEN_SENTINEL";
const outcome = {
  location: "host_workspace",
  operation: "form_response",
  host_profile: "chatgpt",
  outcome: "failure",
  error_code: "PLUGIN_FORM_SUBMIT_FAILED",
  deployment: "hosted",
  source: "client",
};

describe("strict relay: extension operation outcomes", () => {
  it.each(["form_response", "settings_save", "app_message"])(
    "keeps the closed %s outcome and drops content",
    (operation) => {
      const result = applyEventPolicy(
        {
          event: "extension_operation_completed",
          properties: {
            ...outcome,
            operation,
            serverName: secret,
            values: { answer: secret },
            message: secret,
            $current_url: secret,
          },
        },
        CONSERVATIVE_TELEMETRY_POLICY,
        null,
      );
      expect(result).toMatchObject({ event: "extension_operation_completed" });
      expect((result as { properties: unknown }).properties).toEqual({
        token: expect.stringMatching(/^phc_/),
        app_version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        distinct_id: "strict",
        $process_person_profile: false,
        $geoip_disable: true,
        ...outcome,
        operation,
      });
      expect(JSON.stringify(result)).not.toContain("SENTINEL");
    },
  );

  it("drops an outcome with a free-form, unknown or missing value", () => {
    for (const properties of [
      { ...outcome, error_code: secret },
      { ...outcome, outcome: "invented" },
      { ...outcome, operation: secret },
      { ...outcome, deployment: undefined },
    ])
      expect(
        rebuildStrictPostHogEvent({
          event: "extension_operation_completed",
          properties,
        }),
      ).toBeNull();
  });
});
