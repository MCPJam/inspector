import { describe, expect, it } from "vitest";
import {
  BROWSER_IGNORE_ERRORS,
  buildClientSentryConfig,
  buildElectronSentryConfig,
  buildSentryConfig,
  buildServerSentryConfig,
  CLIENT_BUILD_SURFACES,
  electronBuildSurface,
  isSentryBuildSurface,
  resolveClientBuildSurface,
  SENTRY_BUILD_SURFACES,
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

  it("omits dist entirely when none is given", () => {
    const config = buildSentryConfig({
      dsn: "dsn",
      environment: "dev",
      deployment: "hosted",
    });
    expect("dist" in config).toBe(false);
  });

  it("keeps dist when provided", () => {
    // `dist` is what separates the builds that share one release name. A
    // config that drops it silently puts the npm bundle's events on the
    // desktop bundle's artifacts, which is how every frame in 2.47.0 came
    // back naming an unrelated file.
    expect(
      buildSentryConfig({
        dsn: "dsn",
        environment: "prod",
        deployment: "self_hosted",
        dist: "npm",
      }).dist,
    ).toBe("npm");
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

describe("build surfaces", () => {
  it("names every surface exactly once", () => {
    // Two builds sharing a `dist` is the same defect as two builds sharing a
    // `release`: Sentry cannot tell their artifacts apart and symbolicates
    // one against the other.
    expect(new Set(SENTRY_BUILD_SURFACES).size).toBe(
      SENTRY_BUILD_SURFACES.length,
    );
  });

  it("gives mac and Windows Electron builds separate surfaces", () => {
    // Both desktop jobs compile and upload their own `.vite/renderer` and
    // `.vite/build` under the same release. Collapsing them to one name
    // reintroduces the collision.
    expect(electronBuildSurface("darwin")).toBe("electron-mac");
    expect(electronBuildSurface("win32")).toBe("electron-win");
    expect(electronBuildSurface("darwin")).not.toBe(
      electronBuildSurface("win32"),
    );
  });

  it("falls back to local on a platform nothing uploads for", () => {
    // A Linux desktop build has no artifacts in Sentry. Reporting `local`
    // says so; borrowing `electron-mac` would claim maps that do not describe
    // this bundle.
    expect(electronBuildSurface("linux")).toBe("local");
  });

  it("rejects a surface name the upload sites do not use", () => {
    expect(isSentryBuildSurface("npm")).toBe(true);
    expect(isSentryBuildSurface("desktop")).toBe(false);
    expect(isSentryBuildSurface("")).toBe(false);
  });

  it("accepts every surface that builds dist/client", () => {
    for (const surface of CLIENT_BUILD_SURFACES) {
      expect(resolveClientBuildSurface(surface)).toBe(surface);
    }
  });

  it("resolves an unset build surface to local", () => {
    expect(resolveClientBuildSurface(undefined)).toBe("local");
    expect(resolveClientBuildSurface("")).toBe("local");
  });

  it("rejects the Electron surfaces the client build cannot produce", () => {
    // `vite.renderer.config.mts` stamps those from `process.platform` and
    // uploads `.vite/renderer`. A `dist/client` bundle claiming one would be
    // symbolicated against the renderer's artifacts.
    expect(() => resolveClientBuildSurface("electron-mac")).toThrow(
      /not a client build surface/,
    );
    expect(() => resolveClientBuildSurface("electron-win")).toThrow(
      /not a client build surface/,
    );
  });

  it("rejects a value no build surface list contains", () => {
    expect(() => resolveClientBuildSurface("desktop")).toThrow(
      /not a client build surface/,
    );
  });
});
