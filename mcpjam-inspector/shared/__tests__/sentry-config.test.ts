import { describe, expect, it } from "vitest";
import { stepFailureFindingKey } from "@mcpjam/sdk/browser";
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
  groupOAuthDebuggerStepFailures,
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

  // Behaviour, not identity: `beforeSend` is a composition now, so asserting
  // it IS one of the rules would pass only while there is exactly one.
  it("applies both fingerprinting rules on the browser client only", () => {
    const ctx = { environment: "prod", deployment: "hosted" as const };
    const beforeSend = buildClientSentryConfig(ctx).beforeSend;

    const dom = beforeSend<FingerprintableEvent>({
      environment: "prod",
      exception: {
        values: [
          {
            type: "NotFoundError",
            value:
              "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
          },
        ],
      },
    });
    expect(dom.fingerprint).toEqual(["dom-mutation-conflict", "prod"]);

    const step = beforeSend<FingerprintableEvent>({
      environment: "prod",
      tags: { source: "oauth_debugger_step" },
      extra: { step: "request_client_registration" },
      exception: {
        values: [
          { type: "Error", value: "Dynamic Client Registration failed (400)." },
        ],
      },
    });
    expect(step.fingerprint?.[0]).toBe("oauth-debugger-step");

    // A server-side NotFoundError is an upstream or storage failure, so
    // collapsing those by message would merge unrelated defects — and the
    // OAuth debugger never runs off the browser client.
    expect(buildElectronSentryConfig(ctx)).not.toHaveProperty("beforeSend");
    expect(buildServerSentryConfig(ctx)).not.toHaveProperty("beforeSend");
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

describe("groupOAuthDebuggerStepFailures", () => {
  // Built the way the reporting adapter builds them: `extra.finding` from the
  // real SDK key. So these exercise the composition that ships — SDK key plus
  // this rule — not the rule against hand-picked keys.
  function stepEvent(
    value: string,
    {
      step = "request_client_registration",
      environment = "prod",
      source = "oauth_debugger_step",
      withFinding = true,
    }: {
      step?: string;
      environment?: string;
      source?: string;
      withFinding?: boolean;
    } = {},
  ): FingerprintableEvent {
    return {
      environment,
      tags: { source },
      extra: {
        step,
        ...(withFinding ? { finding: stepFailureFindingKey(value) } : {}),
      },
      exception: { values: [{ type: "Error", value }] },
    };
  }

  const fingerprint = (event: FingerprintableEvent) =>
    groupOAuthDebuggerStepFailures(event).fingerprint;

  // INSPECTOR-CLIENT-2FE: nine events titled "Dynamic Client Registration
  // failed (400)" that were five unrelated findings, one stack between them.
  it("splits the findings that shared one stack", () => {
    const findings = [
      stepEvent("Dynamic Client Registration failed (400)."),
      stepEvent("Dynamic Client Registration failed (401)."),
      stepEvent("Token request failed: 400: invalid_client: invalid_client_secret", {
        step: "token_request",
      }),
      stepEvent(
        "MCP server returned HTTP 404 Not Found where MCP requires 401 Unauthorized (or 200, if the server allows anonymous access).",
        { step: "request_unauthenticated" },
      ),
      stepEvent(
        "Failed to request resource metadata: Resource server does not implement OAuth 2.0 Protected Resource Metadata.",
        { step: "request_resource_metadata" },
      ),
    ].map((event) => JSON.stringify(fingerprint(event)));

    expect(new Set(findings).size).toBe(5);
  });

  it("keeps a registration failure together with and without the advisory", () => {
    const withHint = fingerprint(
      stepEvent(
        "Dynamic Client Registration failed (401). Configure a pre-registered client or enable DCR on the authorization server.",
      ),
    );
    // Pinned to a value, not only to its twin: two absent fingerprints would
    // compare equal too.
    expect(withHint).toEqual([
      "oauth-debugger-step",
      "request_client_registration",
      "Dynamic Client Registration failed (401)",
      "prod",
    ]);
    expect(withHint).toEqual(
      fingerprint(stepEvent("Dynamic Client Registration failed (401).")),
    );
  });

  // Review of #5473: the cause of a discovery failure comes after the first
  // period. The first version cut there and merged all of these.
  it("keeps discovery failures with different causes apart", () => {
    const prefix = "Could not discover authorization server metadata. Last error:";
    const keys = [
      `${prefix} undefined`,
      `${prefix} HTTP 500 from https://auth.example.com/.well-known/oauth-authorization-server`,
      `${prefix} Failed to fetch`,
    ].map((value) =>
      JSON.stringify(fingerprint(stepEvent(value, { step: "request_authorization_server_metadata" }))),
    );
    expect(new Set(keys).size).toBe(3);
  });

  // Review of #5473: the server writes part of a token failure, so keyed on
  // the whole text one finding opened an issue per server wording.
  it("keeps one token failure together across servers' wording", () => {
    const keys = [
      "Token request failed: 400 Bad Request: invalid_grant: Authorization code not found or expired",
      "Token request failed: 400: invalid_grant: code already used",
      "Token request failed: 400 Client Error: invalid_grant",
    ].map((value) => JSON.stringify(fingerprint(stepEvent(value, { step: "token_request" }))));
    expect(new Set(keys).size).toBe(1);
  });

  it("separates the same finding on different steps", () => {
    expect(fingerprint(stepEvent("boom", { step: "a" }))).not.toEqual(
      fingerprint(stepEvent("boom", { step: "b" })),
    );
  });

  it("keeps environments apart", () => {
    expect(fingerprint(stepEvent("boom", { environment: "prod" }))).not.toEqual(
      fingerprint(stepEvent("boom", { environment: "dev" })),
    );
  });

  it("files a report with no step under a stable bucket", () => {
    const event: FingerprintableEvent = {
      environment: "prod",
      tags: { source: "oauth_debugger_step" },
      extra: { finding: "boom" },
      exception: { values: [{ type: "Error", value: "boom" }] },
    };
    expect(groupOAuthDebuggerStepFailures(event).fingerprint).toEqual([
      "oauth-debugger-step",
      "unknown",
      "boom",
      "prod",
    ]);
  });

  it("falls back to the capped message, never a first-sentence cut", () => {
    // No `finding` should reach here — the adapter and this rule ship
    // together — but if one does, it must split rather than merge.
    const value = `Could not discover authorization server metadata. Last error: ${"x".repeat(300)}`;
    const [, , finding] = fingerprint(stepEvent(value, { withFinding: false }))!;
    expect(finding).toBe(value.slice(0, 160));
    expect(finding).toContain("Last error:");
  });

  it.each(["oauth_debugger_advance", "react_boundary", undefined])(
    "leaves source %j on default grouping",
    (source) => {
      const event: FingerprintableEvent = {
        environment: "prod",
        ...(source ? { tags: { source } } : {}),
        exception: { values: [{ type: "Error", value: "boom" }] },
      };
      expect(groupOAuthDebuggerStepFailures(event).fingerprint).toBeUndefined();
    },
  );
});
