import { afterEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type { Envelope } from "@sentry/core";
import { telemetryRecord } from "@mcpjam/sdk/internal/telemetry";
import { withSentryBoundary } from "../../../shared/strict-sentry.js";
import { strictServerSentryOptions } from "../strict-sentry-options.js";
import { logger } from "../logger.js";
import { runWithSentryIdentity } from "../sentry-request-identity.js";
import { reportServiceCredentialAtBoot } from "../../services/service-credential-boot.js";

afterEach(async () => {
  await Sentry.close(1000);
  vi.unstubAllEnvs();
});

it("groups real logger captures by approved messages while denying runtime prose", async () => {
  vi.stubEnv("AXIOM_TOKEN", "");
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ENVIRONMENT", "test");
  const events: Record<string, unknown>[] = [];
  Sentry.init({
    dsn: "https://public@example.invalid/1",
    defaultIntegrations: false,
    transport: () =>
      withSentryBoundary(
        {
          send: async (envelope: Envelope) => {
            for (const [header, payload] of envelope[1])
              if (header.type === "event")
                events.push(telemetryRecord(payload));
            return { statusCode: 200 };
          },
          flush: async () => true,
        },
        strictServerSentryOptions,
        () => false,
      ),
  });
  const first = "[host-runtime-config] network error";
  const second = "[computers] runtime-config bootstrap returned non-JSON";
  logger.error(first);
  logger.error(second);
  logger.error(`${first}: PRIVATE_SENTINEL`);
  await Sentry.flush(1000);

  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({ message: first });
  expect(events[1]).toMatchObject({ message: second });
  expect(events.map((event) => event.fingerprint)).toEqual([
    ["{{ default }}", "Error", first],
    ["{{ default }}", "Error", second],
    ["{{ default }}", "Error"],
  ]);
  for (const event of events)
    expect(JSON.stringify(event.exception)).toMatch(
      /"filename":"server\/utils\/logger.ts","in_app":true,"lineno":\d+/,
    );
  expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
});

it("keeps the caller's frame when a request identity scopes the capture", async () => {
  vi.stubEnv("AXIOM_TOKEN", "");
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ENVIRONMENT", "test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
  vi.stubEnv("MCPJAM_REQUIRE_SERVICE_CREDENTIAL", "");
  const events: Record<string, unknown>[] = [];
  Sentry.init({
    dsn: "https://public@example.invalid/1",
    defaultIntegrations: false,
    transport: () =>
      withSentryBoundary(
        {
          send: async (envelope: Envelope) => {
            for (const [header, payload] of envelope[1])
              if (header.type === "event")
                events.push(telemetryRecord(payload));
            return { statusCode: 200 };
          },
          flush: async () => true,
        },
        strictServerSentryOptions,
        () => false,
      ),
  });
  // A real cataloged caller whose message is a template literal, so the
  // boundary drops the message and only the caller frame can name the site.
  runWithSentryIdentity(
    () => ({ id: "user_01", kind: "signedIn" }),
    () => reportServiceCredentialAtBoot(true),
  );
  await Sentry.flush(1000);

  expect(events).toHaveLength(1);
  expect(events[0].message).toBeUndefined();
  expect(JSON.stringify(events[0].exception)).toMatch(
    /"filename":"server\/services\/service-credential-boot.ts","in_app":true,"lineno":\d+/,
  );
});
