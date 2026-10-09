import { describe, expect, it, vi } from "vitest";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../../../utils/hosted-egress-guard.js";
import { attachAuthChallenge, parseChallengeHeader } from "@mcpjam/sdk";
import {
  annotateToolAuthChallenge,
  buildToolAuthChallengeMetadata,
  capSetupAuditMetadata,
  classifySetupAttribution,
  classifyToolAuthChallenge,
  collectToolAuthChallenges,
  connectSpanId,
  createRunSetupObserver,
  describeSetupFailure,
  MAX_SETUP_FAILURE_LINE_CHARS,
  SETUP_AUDIT_METADATA_KEY,
  TOOL_AUTH_CHALLENGES_METADATA_KEY,
  toolAuthChallengeOf,
  toolsListSpanId,
  type SetupAuditRecord,
} from "../run-setup-signals.js";

function nodeError(code: string, message = code): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

function httpError(status: number, message = `HTTP ${status}`): Error {
  const error = new Error(message);
  (error as Error & { status: number }).status = status;
  return error;
}

describe("classifySetupAttribution", () => {
  it("classifies DNS / blocked egress as ours", () => {
    expect(classifySetupAttribution(new EgressResolutionError("no such host"))).toBe(
      "ours"
    );
    expect(
      classifySetupAttribution(new BlockedEgressTargetError("169.254.169.254"))
    ).toBe("ours");
    expect(classifySetupAttribution(nodeError("ENOTFOUND"))).toBe("ours");
  });

  it("classifies 401/403 and transport-local MCP codes as ours", () => {
    expect(classifySetupAttribution(httpError(401))).toBe("ours");
    expect(classifySetupAttribution(httpError(403))).toBe("ours");
    const mcp = new Error("request timeout");
    (mcp as Error & { mcpErrorCode: number }).mcpErrorCode = -32001;
    expect(classifySetupAttribution(mcp)).toBe("ours");
  });

  it("classifies refused / TLS / timeout / 5xx as theirs", () => {
    expect(classifySetupAttribution(nodeError("ECONNREFUSED"))).toBe("theirs");
    expect(classifySetupAttribution(nodeError("ETIMEDOUT"))).toBe("theirs");
    expect(classifySetupAttribution(httpError(502))).toBe("theirs");
    expect(
      classifySetupAttribution(new Error("unable to verify the first certificate"))
    ).toBe("theirs");
  });

  it("classifies everything else as unknown", () => {
    expect(classifySetupAttribution(new Error("something odd"))).toBe("unknown");
  });

  // A cancelled run says NOTHING about the target server. Without this arm
  // an abort classifies `unknown`, and an `unknown` tools/list failure on a
  // server whose initialize completed derives `discovery: failed` — the
  // user pressing stop, reported as the server's fault.
  it("classifies our own cancellation as ours, by name and by code", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifySetupAttribution(abort)).toBe("ours");
    expect(classifySetupAttribution(nodeError("ABORT_ERR"))).toBe("ours");
    expect(classifySetupAttribution(nodeError("ERR_CANCELED"))).toBe("ours");
    const canceled = new Error("canceled");
    canceled.name = "CanceledError";
    expect(classifySetupAttribution(canceled)).toBe("ours");
    expect(
      classifySetupAttribution(new Error("This operation was aborted"))
    ).toBe("ours");
  });

  // The guard on the cancellation heuristic: ECONNABORTED contains the word
  // "aborted" and is a real peer-side reset, so a loose /abort/i would flip
  // a measurable server failure into a setup abort.
  it("keeps ECONNABORTED as theirs — the word 'aborted' is not enough", () => {
    expect(classifySetupAttribution(nodeError("ECONNABORTED"))).toBe("theirs");
    expect(
      classifySetupAttribution(new Error("connect ECONNABORTED 10.0.0.1:443"))
    ).toBe("theirs");
  });
});

describe("createRunSetupObserver folding", () => {
  it("omits signals when no servers are configured", () => {
    const observer = createRunSetupObserver({ expectedServerIds: [] });
    observer.recordConnect("ghost", {
      outcome: "ok",
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()).toBeUndefined();
  });

  it("folds all-ok as outcome ok", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    for (const id of ["a", "b"]) {
      observer.recordConnect(id, { outcome: "ok", startedAt: 0, endedAt: 1 });
      observer.recordToolsList(id, { outcome: "ok", startedAt: 1, endedAt: 2 });
    }
    expect(observer.buildSignals()).toEqual({
      connection: { outcome: "ok", durationMs: 1 },
      discovery: { outcome: "ok", durationMs: 1 },
    });
  });

  it("lets ours dominate a mixed bag so it cannot earn connection:failed", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    observer.recordConnect("a", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    observer.recordConnect("b", {
      outcome: "failed",
      error: nodeError("ENOTFOUND"),
      startedAt: 0,
      endedAt: 1,
    });
    const signals = observer.buildSignals();
    expect(signals?.connection).toMatchObject({
      outcome: "failed",
      attribution: "ours",
      spanIds: [connectSpanId("a"), connectSpanId("b")],
    });
  });

  it("lets unknown dominate verified-theirs", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    observer.recordConnect("a", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    observer.recordConnect("b", {
      outcome: "failed",
      error: new Error("something odd"),
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()?.connection?.attribution).toBe("unknown");
  });

  it("folds an unobserved target as unknown", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
    });
    observer.recordConnect("a", {
      outcome: "ok",
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()?.connection).toMatchObject({
      outcome: "failed",
      attribution: "unknown",
    });
    expect(observer.buildSignals()?.connection?.durationMs).toBeUndefined();
  });

  it("emits the settled-target wall envelope for a complete phase", () => {
    const observer = createRunSetupObserver({ expectedServerIds: ["a", "b"] });
    observer.recordConnect("a", { outcome: "ok", startedAt: 10, endedAt: 25 });
    observer.recordConnect("b", { outcome: "ok", startedAt: 20, endedAt: 50 });
    expect(observer.buildSignals()?.connection?.durationMs).toBe(40);
  });

  it("omits the duration when any settled target has an inverted interval", () => {
    const observer = createRunSetupObserver({ expectedServerIds: ["a", "b"] });
    observer.recordConnect("a", { outcome: "ok", startedAt: 10, endedAt: 25 });
    observer.recordConnect("b", { outcome: "ok", startedAt: 40, endedAt: 20 });
    expect(observer.buildSignals()?.connection).toEqual({ outcome: "ok" });
  });

  // Absence of evidence, not evidence of failure: when connect fails for
  // every target, tools/list never runs, so the phase reports nothing and
  // the stage falls through to `notReached` behind the connection failure.
  it("emits no signal for a phase that never ran for any target", () => {
    const observer = createRunSetupObserver({ expectedServerIds: ["a"] });
    observer.recordConnect("a", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    const signals = observer.buildSignals();
    expect(signals?.connection).toMatchObject({ outcome: "failed" });
    expect(signals?.discovery).toBeUndefined();
  });

  it("caps culprit span ids at 5", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const observer = createRunSetupObserver({ expectedServerIds: ids });
    for (const id of ids) {
      observer.recordConnect(id, {
        outcome: "failed",
        error: nodeError("ECONNREFUSED"),
        startedAt: 0,
        endedAt: 1,
      });
    }
    expect(observer.buildSignals()?.connection?.spanIds).toHaveLength(5);
  });
});

describe("createRunSetupObserver canary + spans", () => {
  it("never runs the canary for an ours failure", async () => {
    const canary = vi.fn(async () => true);
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ENOTFOUND"),
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()?.connection).toMatchObject({
      outcome: "failed",
      attribution: "ours",
    });
    expect(observer.buildSignals()?.connection?.egressVerified).toBeUndefined();
    expect(canary).not.toHaveBeenCalled();
  });

  it("runs the canary once per run, only when asked, on theirs", async () => {
    const canary = vi.fn(async () => true);
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    expect(canary).not.toHaveBeenCalled();
    await expect(observer.ensureEgressCanary()).resolves.toBe(true);
    await expect(observer.ensureEgressCanary()).resolves.toBe(true);
    expect(canary).toHaveBeenCalledTimes(1);
    expect(observer.buildSignals()?.connection).toMatchObject({
      outcome: "failed",
      attribution: "theirs",
      egressVerified: true,
    });
  });

  it("clamps synthetic span position to offset 0 and keeps duration", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 1_000,
      endedAt: 1_042,
    });
    observer.recordToolsList("srv", {
      outcome: "ok",
      startedAt: 1_042,
      endedAt: 1_050,
    });
    const spans = observer.buildSyntheticSpans(500);
    expect(spans).toEqual([
      {
        id: connectSpanId("srv"),
        name: "connect",
        category: "connection",
        status: "error",
        serverId: "srv",
        startMs: 0,
        endMs: 42,
      },
      {
        id: toolsListSpanId("srv"),
        name: "tools/list",
        category: "discovery",
        status: "ok",
        serverId: "srv",
        startMs: 0,
        endMs: 8,
      },
    ]);
  });

  it("persists a bounded audit record with the folded signals", async () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary: async () => true,
      now: () => 99,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    await observer.ensureEgressCanary();
    const audit = observer.buildAuditMetadata();
    // ONE top-level metadata key. Iteration metadata is a flat open record
    // shared by every producer, so the audit record nests rather than
    // scattering generic words like `egressCanary` across it.
    expect(Object.keys(audit ?? {})).toEqual([SETUP_AUDIT_METADATA_KEY]);
    const record = audit?.[SETUP_AUDIT_METADATA_KEY] as SetupAuditRecord;
    expect(record.signals).toMatchObject({
      connection: {
        outcome: "failed",
        attribution: "theirs",
        egressVerified: true,
      },
    });
    expect(record.egressCanary).toEqual({ ran: true, ok: true, at: 99 });
    expect(JSON.stringify(audit).length).toBeLessThanOrEqual(2048);
  });

  it("does not attach a failed canary to a theirs discovery after connect ok", async () => {
    const canary = vi.fn(async () => false);
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    observer.recordConnect("srv", {
      outcome: "ok",
      startedAt: 0,
      endedAt: 1,
    });
    observer.recordToolsList("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 1,
      endedAt: 2,
    });
    expect(observer.buildSignals()).toMatchObject({
      connection: { outcome: "ok" },
      discovery: { outcome: "failed", attribution: "theirs" },
    });
    expect(observer.buildSignals()?.discovery?.egressVerified).toBeUndefined();
    expect(canary).not.toHaveBeenCalled();
  });

  // "we did not check" and "we checked and our egress is down" are
  // different states. Only an explicit `true` may ever earn
  // `connection: failed`, so an unrun canary leaves the field absent
  // rather than stamping a false.
  it("omits egressVerified entirely when the canary never ran", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary: async () => true,
    });
    observer.recordConnect("srv", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    const connection = observer.buildSignals()?.connection;
    expect(connection).toMatchObject({
      outcome: "failed",
      attribution: "theirs",
    });
    expect(connection && "egressVerified" in connection).toBe(false);
  });

  it("shares one canary promise instead of polling", async () => {
    let resolveCanary!: (ok: boolean) => void;
    const canary = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCanary = resolve;
        })
    );
    const observer = createRunSetupObserver({
      expectedServerIds: ["srv"],
      canary,
    });
    const first = observer.ensureEgressCanary();
    const second = observer.ensureEgressCanary();
    expect(canary).toHaveBeenCalledTimes(1);
    resolveCanary(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await observer.ensureEgressCanary()).toBe(true);
    expect(canary).toHaveBeenCalledTimes(1);
  });

  it("sheds span ids when the audit blob exceeds the cap", () => {
    const raw = {
      signals: {
        connection: {
          outcome: "failed" as const,
          attribution: "theirs" as const,
          spanIds: ["run-connect-aaaaaaaaaaaaaaaa"],
        },
      },
      egressCanary: { ran: true, ok: true, at: 1 },
    };
    const capped = capSetupAuditMetadata(raw, 10);
    expect(capped.truncated).toBe(true);
    expect(capped.signals.connection?.spanIds).toBeUndefined();
    expect(JSON.stringify(capped).length).toBeLessThan(JSON.stringify(raw).length);
  });
});

describe("describeSetupFailure", () => {
  const credentialError = (
    status: number,
    source: "oauth_refresh" | "xaa_mint" | "authorization_required",
    details = {},
  ) =>
    Object.assign(httpError(status), { setupFailureSource: source, details });

  it("uses explicit provenance, not route-error shape or authored-looking messages", () => {
    const tagged = credentialError(503, "oauth_refresh", {
      authorizationServerUnreachable: true,
    });
    expect(classifySetupAttribution(tagged)).toBe("ours");
    expect(
      describeSetupFailure(tagged, { serverLabel: "Linear" }),
    ).toMatchObject({
      attribution: "ours",
      normalized: { slug: "auth/authorization_server_unreachable" },
    });
    for (const error of [
      Object.assign(httpError(503), {
        name: "WebRouteError",
        code: "X",
        details: {},
      }),
      Object.assign(new Error("Could not reach the authorization server"), {
        status: 502,
      }),
    ]) {
      expect(classifySetupAttribution(error)).toBe("theirs");
    }
    expect(
      classifySetupAttribution(new Error("wrapped", { cause: tagged })),
    ).toBe("ours");
    expect(
      classifySetupAttribution({
        code: "ERA_NEGOTIATION_FAILED",
        data: { cause: tagged },
      }),
    ).toBe("ours");
  });

  it("preserves an existing normalized error and tagged authorization messages", async () => {
    const { describeError } = await import("@mcpjam/sdk");
    const normalized = describeError(
      new Error("The enterprise handshake needs to be repeated."),
    );
    const error = Object.assign(credentialError(502, "xaa_mint"), {
      normalized,
    });
    const detail = describeSetupFailure(error, { serverLabel: "Linear" });
    expect(detail.normalized).toBe(normalized);
    expect(detail.line).toContain("enterprise handshake");
    expect(detail.attribution).toBe("ours");
    expect(
      describeSetupFailure(credentialError(401, "authorization_required"), {
        challenge: { scheme: "none" },
      }).attribution,
    ).toBe("ours");
  });

  it("uses shared challenge diagnoses and conservative attribution", () => {
    expect(
      describeSetupFailure(httpError(401), { challenge: { scheme: "none" } }),
    ).toMatchObject({
      attribution: "unknown",
      normalized: { slug: "oauth/no_bearer_challenge" },
    });
    expect(
      describeSetupFailure(httpError(401), {
        challenge: { scheme: "bearer", error: "invalid_token" },
      }).line,
    ).toContain("invalid_token");
    expect(
      describeSetupFailure(httpError(403), {
        challenge: {
          scheme: "bearer",
          error: "insufficient_scope",
          scopes: ["read"],
        },
      }).line,
    ).toContain("Required scopes: read");
    expect(
      describeSetupFailure(httpError(403), {
        challenge: { scheme: "none", bodyKind: "html" },
      }),
    ).toMatchObject({
      attribution: "unknown",
      normalized: { slug: "auth/proxy_rejected" },
    });
  });

  it("redacts and bounds reasons including server labels", () => {
    const detail = describeSetupFailure(
      new Error("Authorization: Bearer secret-token"),
      { serverLabel: "Bearer label-secret" },
    );
    expect(detail.line).not.toContain("secret-token");
    expect(detail.line).not.toContain("label-secret");
    expect(
      describeSetupFailure(httpError(500), { serverLabel: "x".repeat(500) })
        .line.length,
    ).toBeLessThanOrEqual(240);
  });
});

describe("reason folding and audit limits", () => {
  it("keeps reasons on signals without another persisted failure schema", () => {
    const observer = createRunSetupObserver({
      expectedServerIds: ["a", "b"],
      context: (serverId) => ({ serverLabel: serverId.toUpperCase() }),
    });
    observer.recordConnect("b", {
      outcome: "failed",
      error: nodeError("ECONNREFUSED"),
      startedAt: 0,
      endedAt: 1,
    });
    observer.recordConnect("a", {
      outcome: "failed",
      error: httpError(401),
      startedAt: 0,
      endedAt: 1,
    });
    expect(observer.buildSignals()?.connection?.reasons?.[0]).toContain('"A"');
    expect(observer.buildSignals()?.connection?.reasons).toHaveLength(2);
    const audit = observer.buildAuditMetadata()?.[
      SETUP_AUDIT_METADATA_KEY
    ] as SetupAuditRecord;
    expect(Object.keys(audit).sort()).toEqual(["egressCanary", "signals"]);
    expect(audit.signals.connection?.reasons).toEqual(
      observer.buildSignals()?.connection?.reasons,
    );
  });

  it("sheds Unicode reasons before span ids using serialized bytes", () => {
    const raw: SetupAuditRecord = {
      signals: {
        connection: {
          outcome: "failed",
          attribution: "ours",
          spanIds: ["run-connect-a"],
          reasons: ["界".repeat(240)],
        },
      },
      egressCanary: { ran: false },
    };
    expect(JSON.stringify(raw).length).toBeLessThan(500);
    const capped = capSetupAuditMetadata(raw, 500);
    expect(capped.signals.connection?.reasons).toBeUndefined();
    expect(capped.signals.connection?.spanIds).toEqual(["run-connect-a"]);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(500);
    expect(raw.signals.connection?.reasons).toHaveLength(1);
  });
});

describe("classifyToolAuthChallenge (mid-run sign-in)", () => {
  const HEADER =
    'Bearer error="invalid_token", resource_metadata="https://x.example/.well-known/oauth-protected-resource", scope="orders:read"';

  /** A thrown 401 as the SDK raises it: the parsed challenge attached. */
  function challenged401(): Error {
    const error = httpError(401, "Error POSTing to endpoint (HTTP 401)");
    attachAuthChallenge(error, parseChallengeHeader(HEADER));
    return error;
  }

  it("classifies a thrown 401 as authorization_required (ours), with the parsed challenge and a remediation", () => {
    const finding = classifyToolAuthChallenge(
      { error: challenged401() },
      { serverLabel: "Orders", toolName: "list_orders" },
    );
    expect(finding).toMatchObject({
      setupFailureSource: "authorization_required",
      attribution: "ours",
      authChallenge: {
        source: "http_401",
        error: "invalid_token",
        requiredScope: "orders:read",
        resourceMetadataUrl:
          "https://x.example/.well-known/oauth-protected-resource",
        facets: { challengeHeader: "bearer", hasScope: true },
      },
    });
    expect(finding!.line).toBe(
      '"Orders": asked for sign-in when "list_orders" was called (invalid_token; scope "orders:read")',
    );
    expect(finding!.remediation).toMatch(
      /^Connect this server with OAuth in the eval environment/,
    );
    expect(finding!.remediation).toContain("never sign in");
  });

  it("reads the hosted route error's stamped challenge (403 UPSTREAM_AUTH_FAILED)", () => {
    const hosted = Object.assign(
      new Error('Server "orders" asked for sign-in to complete this request.'),
      {
        name: "WebRouteError",
        status: 403,
        code: "UPSTREAM_AUTH_FAILED",
        details: {
          upstreamAuthRequired: true,
          authChallenge: {
            ...parseChallengeHeader(HEADER),
            effectiveAuth: "discover",
          },
        },
      },
    );
    expect(
      classifyToolAuthChallenge(
        { error: new Error("tool failed", { cause: hosted }) },
        { serverId: "orders" },
      ),
    ).toMatchObject({
      attribution: "ours",
      authChallenge: {
        source: "http_401",
        effectiveAuth: "discover",
        requiredScope: "orders:read",
      },
    });
  });

  it('classifies a completed isError result carrying _meta["mcp/www_authenticate"]', () => {
    const finding = classifyToolAuthChallenge(
      {
        result: {
          isError: true,
          content: [{ type: "text", text: "Sign in required." }],
          _meta: { "mcp/www_authenticate": [HEADER] },
        },
      },
      { serverId: "orders", toolName: "list_orders" },
    );
    expect(finding).toMatchObject({
      setupFailureSource: "authorization_required",
      attribution: "ours",
      authChallenge: { source: "tool_result_meta", error: "invalid_token" },
    });
    expect(finding!.line).toContain('"orders": asked for sign-in');
  });

  it("gives a step-up remediation for a 403 insufficient_scope", () => {
    const error = httpError(403, "insufficient scope");
    attachAuthChallenge(
      error,
      parseChallengeHeader(
        'Bearer error="insufficient_scope", scope="orders:write"',
        "http_403_insufficient_scope",
      ),
    );
    const finding = classifyToolAuthChallenge({ error });
    expect(finding?.authChallenge.source).toBe("http_403_insufficient_scope");
    expect(finding?.remediation).toMatch(/^Reconnect this server with OAuth/);
  });

  it("returns undefined for ordinary failures, so they keep their own classification", () => {
    expect(
      classifyToolAuthChallenge({ error: httpError(500) }),
    ).toBeUndefined();
    expect(
      classifyToolAuthChallenge({ error: httpError(401) }),
    ).toBeUndefined();
    expect(
      classifyToolAuthChallenge({
        result: { isError: true, content: [{ type: "text", text: "nope" }] },
      }),
    ).toBeUndefined();
    // `_meta` without `isError` is not a challenge.
    expect(
      classifyToolAuthChallenge({
        result: { content: [], _meta: { "mcp/www_authenticate": HEADER } },
      }),
    ).toBeUndefined();
  });

  it("caps what it keeps: every challenge field as the SDK parser caps it", () => {
    const long = "x".repeat(5_000);
    const finding = classifyToolAuthChallenge({
      result: {
        isError: true,
        _meta: {
          "mcp/www_authenticate": `Bearer error="invalid_token", error_description="${long}"`,
        },
      },
    });
    expect(finding!.authChallenge.errorDescription!.length).toBeLessThanOrEqual(
      512,
    );
    expect(finding!.authChallenge.raw!.length).toBeLessThanOrEqual(2048);
    expect(finding!.line.length).toBeLessThanOrEqual(
      MAX_SETUP_FAILURE_LINE_CHARS,
    );
  });

  it("annotates a tool step in memory only: never serialized, kept by copies, collected once per call", () => {
    const finding = classifyToolAuthChallenge({ error: challenged401() })!;
    const span = { id: "tool-c1", toolCallId: "c1" };
    annotateToolAuthChallenge(span, {
      ...finding,
      toolCallId: "c1",
      spanId: "tool-c1",
    });
    expect(JSON.parse(JSON.stringify(span))).toEqual({
      id: "tool-c1",
      toolCallId: "c1",
    });
    expect(toolAuthChallengeOf({ ...span })?.spanId).toBe("tool-c1");
    const records = collectToolAuthChallenges([span, { ...span }, {}]);
    expect(records).toHaveLength(1);
    expect(buildToolAuthChallengeMetadata(records)).toEqual({
      [TOOL_AUTH_CHALLENGES_METADATA_KEY]: [
        expect.objectContaining({
          toolCallId: "c1",
          spanId: "tool-c1",
          setupFailureSource: "authorization_required",
          authChallenge: expect.objectContaining({ source: "http_401" }),
        }),
      ],
    });
    expect(buildToolAuthChallengeMetadata([])).toEqual({});
  });
});
