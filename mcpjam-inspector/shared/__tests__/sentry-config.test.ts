import { describe, expect, it } from "vitest";
import {
  BROWSER_IGNORE_ERRORS,
  buildClientSentryConfig,
  buildElectronSentryConfig,
  buildSentryConfig,
  buildServerSentryConfig,
  SENTRY_DSN,
} from "../sentry-config";

describe("buildSentryConfig", () => {
  it("never opts into default PII", () => {
    const config = buildSentryConfig({
      dsn: "dsn",
      environment: "prod",
      deployment: "hosted",
    });
    expect(config.sendDefaultPii).toBe(false);
  });

  it("tags every event with the deployment shape", () => {
    expect(
      buildSentryConfig({
        dsn: "dsn",
        environment: "prod",
        deployment: "self_hosted",
      }).initialScope,
    ).toEqual({ tags: { deployment: "self_hosted" } });
  });

  it("defaults enabled to true and honors an explicit false", () => {
    const base = { dsn: "dsn", environment: "dev", deployment: "hosted" as const };
    expect(buildSentryConfig(base).enabled).toBe(true);
    expect(buildSentryConfig({ ...base, enabled: false }).enabled).toBe(false);
  });

  it("omits release entirely when none is resolvable", () => {
    const config = buildSentryConfig({
      dsn: "dsn",
      environment: "dev",
      deployment: "hosted",
    });
    expect("release" in config).toBe(false);
  });

  it("keeps release when provided", () => {
    expect(
      buildSentryConfig({
        dsn: "dsn",
        environment: "prod",
        release: "2.34.0",
        deployment: "hosted",
      }).release,
    ).toBe("2.34.0");
  });

  it("propagates traces to relative URLs, localhost and Convex", () => {
    const targets = buildSentryConfig({
      dsn: "dsn",
      environment: "prod",
      deployment: "hosted",
    }).tracePropagationTargets;
    expect(targets).toContain("localhost");
    const patterns = targets.filter((t): t is RegExp => t instanceof RegExp);
    expect(patterns.some((p) => p.test("/api/mcp/connect"))).toBe(true);
    expect(
      patterns.some((p) => p.test("https://example.convex.cloud/api")),
    ).toBe(true);
  });

  it("does not propagate traces to convex suffix look-alikes", () => {
    // `...convex.cloud.evil/` must NOT match, or Sentry would attach trace and
    // baggage headers to an attacker-controlled origin.
    const patterns = buildSentryConfig({
      dsn: "dsn",
      environment: "prod",
      deployment: "hosted",
    }).tracePropagationTargets.filter((t): t is RegExp => t instanceof RegExp);

    const convexPattern = patterns.find((p) => p.source.includes("convex"))!;
    expect(convexPattern.test("https://example.convex.cloud/api")).toBe(true);
    expect(convexPattern.test("https://example.convex.site")).toBe(true);
    expect(convexPattern.test("https://example.convex.cloud:443/x")).toBe(true);
    expect(convexPattern.test("https://example.convex.cloud.evil/api")).toBe(
      false,
    );
    expect(convexPattern.test("https://evil.convex.cloudx/")).toBe(false);
    // Userinfo must not smuggle a non-Convex host past the check either —
    // `[^/]*` before the suffix used to allow arbitrary authority text.
    expect(convexPattern.test("https://x.convex.cloud@evil.test/")).toBe(false);
    expect(convexPattern.test("https://u:p@x.convex.cloud/")).toBe(false);
  });

  it("defaults tracesSampleRate to 0.1 and honors an override", () => {
    const base = { dsn: "dsn", environment: "prod", deployment: "hosted" as const };
    expect(buildSentryConfig(base).tracesSampleRate).toBe(0.1);
    expect(
      buildSentryConfig({ ...base, tracesSampleRate: 0 }).tracesSampleRate,
    ).toBe(0);
  });
});

describe("surface builders", () => {
  it("wires each surface to its own project DSN", () => {
    const ctx = { environment: "prod", deployment: "hosted" as const };
    expect(buildClientSentryConfig(ctx).dsn).toBe(SENTRY_DSN.client);
    expect(buildElectronSentryConfig(ctx).dsn).toBe(SENTRY_DSN.electron);
    expect(buildServerSentryConfig(ctx).dsn).toBe(SENTRY_DSN.server);
  });

  it("carries replay sample rates on the client only", () => {
    const client = buildClientSentryConfig({
      environment: "prod",
      deployment: "hosted",
      replayEnabled: true,
    });
    expect(client.replaysSessionSampleRate).toBe(0.1);
    expect(client.replaysOnErrorSampleRate).toBe(1.0);
    expect(
      buildServerSentryConfig({ environment: "prod", deployment: "hosted" }),
    ).not.toHaveProperty("replaysSessionSampleRate");
  });

  it("zeroes replay sampling when the surface may not record", () => {
    // Sentry Replay records DOM+text exactly like rrweb; a self-hosted
    // npx/Docker browser session must be recorded by neither.
    const selfHosted = buildClientSentryConfig({
      environment: "prod",
      deployment: "self_hosted",
    });
    expect(selfHosted.replaysSessionSampleRate).toBe(0);
    expect(selfHosted.replaysOnErrorSampleRate).toBe(0);
  });

  it("defaults replay to OFF when eligibility is not stated", () => {
    // Opt-in, so a new caller cannot accidentally start recording.
    const config = buildClientSentryConfig({
      environment: "prod",
      deployment: "hosted",
    });
    expect(config.replaysSessionSampleRate).toBe(0);
  });

  it("filters browser noise on the browser client only", () => {
    const ctx = { environment: "prod", deployment: "hosted" as const };
    expect(buildClientSentryConfig(ctx).ignoreErrors).toBe(
      BROWSER_IGNORE_ERRORS,
    );
    // NOT on the Electron MAIN process (Node) or the server: "Failed to
    // fetch" / "Load failed" there are real updater and startup network
    // failures, and filtering them would hide the crashes we are here to see.
    expect(buildElectronSentryConfig(ctx)).not.toHaveProperty("ignoreErrors");
    expect(buildServerSentryConfig(ctx)).not.toHaveProperty("ignoreErrors");
  });

  it("ignores the ResizeObserver and offline-network noise baseline", () => {
    expect(BROWSER_IGNORE_ERRORS).toContain(
      "ResizeObserver loop limit exceeded",
    );
    expect(BROWSER_IGNORE_ERRORS).toContain(
      "ResizeObserver loop completed with undelivered notifications",
    );
    expect(BROWSER_IGNORE_ERRORS).toContain("Failed to fetch");
    expect(BROWSER_IGNORE_ERRORS).toContain("Load failed");
    const abort = BROWSER_IGNORE_ERRORS.find((e) => e instanceof RegExp);
    expect((abort as RegExp).test("AbortError: The user aborted a request")).toBe(
      true,
    );
  });
});
