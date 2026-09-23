import { describe, expect, it } from "vitest";
import {
  BROWSER_IGNORE_ERRORS,
  buildClientSentryConfig,
  buildElectronSentryConfig,
  buildSentryConfig,
  buildServerSentryConfig,
  CLIENT_BUILD_SURFACES,
  electronBuildSurface,
  type FingerprintableEvent,
  groupDomMutationConflicts,
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
    const base = {
      dsn: "dsn",
      environment: "dev",
      deployment: "hosted" as const,
    };
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

  it("propagates traces to the first-party Convex custom domains, exactly", () => {
    // Production is served on rt.mcpjam.com (Convex API) and
    // rt-http.mcpjam.com (HTTP actions) through our own Cloudflare zone. The
    // host must match exactly — no suffix look-alikes, subdomains or userinfo.
    const patterns = buildSentryConfig({
      dsn: "dsn",
      environment: "prod",
      deployment: "hosted",
    }).tracePropagationTargets.filter((t): t is RegExp => t instanceof RegExp);

    const customPattern = patterns.find((p) => p.source.includes("mcpjam"))!;
    expect(customPattern.test("https://rt.mcpjam.com/api/1.29.0/sync")).toBe(
      true,
    );
    expect(customPattern.test("https://rt-http.mcpjam.com/stream")).toBe(true);
    expect(customPattern.test("https://rt.mcpjam.com:443/x")).toBe(true);
    expect(customPattern.test("https://rt.mcpjam.com")).toBe(true);
    expect(customPattern.test("https://rt.mcpjam.com.evil/api")).toBe(false);
    expect(customPattern.test("https://x.rt.mcpjam.com/")).toBe(false);
    expect(customPattern.test("https://rt-https.mcpjam.com/")).toBe(false);
    expect(customPattern.test("https://app.mcpjam.com/")).toBe(false);
    expect(customPattern.test("https://rt.mcpjam.com@evil.test/")).toBe(false);
    expect(customPattern.test("https://u:p@rt.mcpjam.com/")).toBe(false);
  });

  it("defaults tracesSampleRate to 0.1 and honors an override", () => {
    const base = {
      dsn: "dsn",
      environment: "prod",
      deployment: "hosted" as const,
    };
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
    expect(
      (abort as RegExp).test("AbortError: The user aborted a request"),
    ).toBe(true);
  });

  it("groups DOM mutation conflicts on the browser client only", () => {
    const ctx = { environment: "prod", deployment: "hosted" as const };
    const event = {
      environment: "prod",
      exception: {
        values: [
          {
            type: "NotFoundError",
            value: "Failed to execute 'removeChild' on 'Node': oops",
          },
        ],
      },
    };
    expect(buildClientSentryConfig(ctx).beforeSend(event)).toEqual(
      groupDomMutationConflicts({ ...event }),
    );
    // A server-side NotFoundError is an upstream or storage failure, so
    // collapsing those by message would merge unrelated defects.
    expect(buildElectronSentryConfig(ctx)).not.toHaveProperty("beforeSend");
    expect(buildServerSentryConfig(ctx)).not.toHaveProperty("beforeSend");
  });

  // Sentry keeps its own window.onerror handler, so filtering PostHog alone
  // left it opening issues for the same injected-script crash.
  it("drops an injected-script crash on the browser client", () => {
    const origin = "https://app.mcpjam.com";
    const beforeSend = buildClientSentryConfig({
      environment: "prod",
      deployment: "hosted" as const,
      documentOrigin: origin,
    }).beforeSend;

    const injected = {
      exception: {
        values: [
          {
            type: "RangeError",
            value: "Maximum call stack size exceeded.",
            stacktrace: {
              frames: [{ filename: `${origin}/p/v97d1szz/playground` }],
            },
          },
        ],
      },
    };
    expect(beforeSend(injected)).toBeNull();

    const ours = {
      exception: {
        values: [
          {
            type: "RangeError",
            value: "Maximum call stack size exceeded.",
            stacktrace: {
              frames: [{ filename: `${origin}/assets/index-Ct2CwjTH.js` }],
            },
          },
        ],
      },
    };
    expect(beforeSend(ours)).toBe(ours);
  });

  // Sentry's globalHandlersIntegration invents a frame when the parsed stack
  // is empty, stamped with the document URL. Counting it as attribution would
  // invert the rule: the frameless exceptions it spares elsewhere would be the
  // only ones it dropped here.
  it("spares an exception whose only frame Sentry synthesised", () => {
    const origin = "https://app.mcpjam.com";
    const beforeSend = buildClientSentryConfig({
      environment: "prod",
      deployment: "hosted" as const,
      documentOrigin: origin,
    }).beforeSend;

    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "Script error.",
            stacktrace: {
              // What _enhanceEventWithInitialFrame pushes: UNKNOWN_FUNCTION,
              // and the document URL when window.onerror gave no usable one.
              frames: [
                { filename: `${origin}/p/v97d1szz/home`, function: "?" },
              ],
            },
          },
        ],
      },
    };
    expect(beforeSend(event)).toBe(event);
  });

  // The same lone document frame, but from a real parsed stack, still drops.
  it("still drops a lone document frame that Sentry did not synthesise", () => {
    const origin = "https://app.mcpjam.com";
    const beforeSend = buildClientSentryConfig({
      environment: "prod",
      deployment: "hosted" as const,
      documentOrigin: origin,
    }).beforeSend;

    expect(
      beforeSend({
        exception: {
          values: [
            {
              type: "RangeError",
              value: "Maximum call stack size exceeded.",
              stacktrace: {
                frames: [
                  {
                    filename: `${origin}/p/v97d1szz/playground`,
                    function: "Tk",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBeNull();
  });

  // Without an origin there is nothing to compare against, so the filter is
  // inert and only the fingerprint pass runs.
  it("drops nothing when no document origin is supplied", () => {
    const beforeSend = buildClientSentryConfig({
      environment: "prod",
      deployment: "hosted" as const,
    }).beforeSend;
    const event = {
      exception: {
        values: [
          {
            type: "RangeError",
            value: "Maximum call stack size exceeded.",
            stacktrace: {
              frames: [{ filename: "https://app.mcpjam.com/p/x/tasks" }],
            },
          },
        ],
      },
    };
    expect(beforeSend(event)).toBe(event);
  });
});

describe("groupDomMutationConflicts", () => {
  function domMutationEvent(
    value: string,
    environment = "prod",
  ): FingerprintableEvent {
    return {
      environment,
      exception: { values: [{ type: "NotFoundError", value }] },
    };
  }

  // Blink names the mutating method, so both wordings are the same defect.
  it.each([
    "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
  ])("collapses %j into one fingerprint", (value) => {
    expect(
      groupDomMutationConflicts(domMutationEvent(value)).fingerprint,
    ).toEqual(["dom-mutation-conflict", "prod"]);
  });

  it("leaves the ambiguous WebKit wording ungrouped", () => {
    // WebKit uses this sentence for the whole NotFoundError class, so a match
    // cannot prove a DOM mutation. Grouping on it would fold an IndexedDB
    // failure into this issue; those keep their frame-based grouping.
    expect(
      groupDomMutationConflicts(
        domMutationEvent("The object can not be found here."),
      ).fingerprint,
    ).toBeUndefined();
  });

  it("keeps dev out of the production group", () => {
    // An issue spans environments in Sentry, and dev is the larger share of
    // this project's volume — one group for both would bury production again.
    expect(
      groupDomMutationConflicts(
        domMutationEvent(
          "Failed to execute 'removeChild' on 'Node': gone.",
          "dev",
        ),
      ).fingerprint,
    ).toEqual(["dom-mutation-conflict", "dev"]);
  });

  it("leaves an unrelated NotFoundError alone", () => {
    // Same DOMException name, different defect: IndexedDB raises NotFoundError
    // too, and merging those into the DOM group would hide a storage bug.
    const event: FingerprintableEvent = {
      environment: "prod",
      exception: {
        values: [
          { type: "NotFoundError", value: "The named object was not found." },
        ],
      },
    };
    expect(groupDomMutationConflicts(event).fingerprint).toBeUndefined();
  });

  it("leaves other exception types alone even on a matching message", () => {
    const event: FingerprintableEvent = {
      environment: "prod",
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Failed to execute 'removeChild' on 'Node': nope",
          },
        ],
      },
    };
    expect(groupDomMutationConflicts(event).fingerprint).toBeUndefined();
  });

  it("passes through an event carrying no exception", () => {
    // Message events and transactions reach beforeSend too; reading through a
    // missing `exception` must not throw on the reporting path.
    const event: FingerprintableEvent = { environment: "prod" };
    expect(groupDomMutationConflicts(event)).toBe(event);
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
