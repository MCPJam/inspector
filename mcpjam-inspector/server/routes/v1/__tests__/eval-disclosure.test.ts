import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The pre-run disclosure route (`eval-disclosure.ts`) — the inspector half of
 * G4b.
 *
 * This route's whole job is to tell a caller what happens to a run's content
 * BEFORE they consent to it, so the failure mode this file guards is the one
 * `sandboxesOf` on `capabilities.ts` deliberately does NOT have here: a
 * missing field must never quietly become a reassuring value. See the
 * `contract_unavailable` and "no reassuring default" cases below.
 */

const { queryMock, hostedModeMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  hostedModeMock: { value: false },
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

// `HOSTED_MODE` is a module-level constant read from `process.env` at import
// time, so a runtime `vi.stubEnv` cannot move it — mocked here the same way
// `local-oauth-refresh.test.ts` does.
vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedModeMock.value;
    },
  };
});

import evalDisclosure from "../eval-disclosure.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

const PROJECT = "proj_a";
const SUITE = "suite_a";

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", evalDisclosure);
  return app;
}

function get(query = "") {
  return makeApp().request(
    `/api/v1/projects/${PROJECT}/eval-suites/${SUITE}/run-disclosure${query}`
  );
}

function baseDisclosure(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    computedAt: 1_700_000_000_000,
    digest: "deadbeef",
    execution: {
      engine: "emulated",
      sandbox: { engaged: false, because: "no sandbox needed" },
      locus: { known: false, reason: "reserved for the inspector half" },
      models: [
        {
          modelId: "openai/gpt-5.4-mini",
          provider: "openai",
          tenantEgress: "mcpjam-hosted",
          rail: {
            managed: true,
            possibleDestinations: ["gateway", "openrouter"],
            outcomeIfRunNow: {
              destination: "gateway",
              observedAt: 1_700_000_000_000,
              volatile: true,
            },
            inputs: {
              mode: "auto",
              gatewayEligible: true,
              hasOpenRouterFallback: null,
            },
            ruleLocation: "convex/lib/chatProvider.ts#resolveChatProvider",
            authoritativePerRequestRecord: "llmUsageRecord",
          },
        },
      ],
    },
    analysis: [],
    capture: {
      captureLevel: "full",
      reportingMode: "standard",
      tiersImplemented: false,
      redaction: {
        kind: "credential-shaped",
        module: "convex/lib/evalIngestRedaction.ts",
        isDlp: false,
        limitation: "not DLP",
        appliesTo: [],
      },
      exportDefaults: {
        includeContent: false,
        ruleLocation: "convex/traceExport.ts",
        note: "redacted by default",
      },
    },
    retention: {
      planName: "free",
      policyDays: 30,
      source: "plan entitlements",
      enforced: true,
      enforcementBlockers: [],
      effectiveToday: "swept-after-policy-days",
      evidentiaryClasses: [],
      backupStatement: {
        vendor: "Convex",
        capturedAt: "2026-08-23",
        sourceUrl: "https://docs.convex.dev/database/backup-restore",
        statements: [],
      },
    },
    region: { stated: false, reason: "no deployment region is derivable" },
    subprocessors: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  hostedModeMock.value = false;
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /projects/:projectId/eval-suites/:suiteId/run-disclosure", () => {
  it("projects the composed contract, with execution.locus filled in", async () => {
    hostedModeMock.value = true;
    queryMock.mockResolvedValue(baseDisclosure());
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.contractVersion).toBe(1);
    expect(body.execution.locus).toEqual({ known: true, hosted: true });
    expect(body.execution.models[0].modelId).toBe("openai/gpt-5.4-mini");
  });

  it("reports locus.hosted === false off HOSTED_MODE", async () => {
    hostedModeMock.value = false;
    queryMock.mockResolvedValue(baseDisclosure());
    const body = (await (await get()).json()) as any;
    expect(body.execution.locus).toEqual({ known: true, hosted: false });
  });

  it("passes an unknown top-level section through structurally, unmodified", async () => {
    // A newer backend can add a section this route's hand-written contract
    // does not know about yet. It must reach the wire, not be dropped by a
    // projection that has not caught up — that is the whole point of the
    // shallow-spread pass-through.
    queryMock.mockResolvedValue(
      baseDisclosure({ futureSection: { brandNew: true, value: 42 } })
    );
    const body = (await (await get()).json()) as any;
    expect(body.futureSection).toEqual({ brandNew: true, value: 42 });
  });

  it("passes analysis through unmodified even when execution is absent", async () => {
    // `analysis` is ALWAYS present, even for an ingested run — stored
    // evidence still reaches the judges. This route must never hide it just
    // because there is no execution section.
    const disclosure = baseDisclosure({
      analysis: [
        {
          touchpoint: "goalCompletion",
          label: "Goal-completion judge",
          model: "openai/gpt-5.4-mini",
          rail: { fixed: "openrouter", because: "insightLlmCall is fixed" },
          destinations: ["OpenRouter (openrouter.ai)"],
          evidenceSent: ["case prompt"],
          fires: "explicit-request-only",
        },
      ],
    });
    delete (disclosure as Record<string, unknown>).execution;
    (disclosure as Record<string, unknown>).executionAbsence = {
      kind: "ingested-run",
      reason: "the SDK uploaded this run",
    };
    queryMock.mockResolvedValue(disclosure);
    const body = (await (await get()).json()) as any;
    expect(body.execution).toBeUndefined();
    expect(body.executionAbsence).toEqual({
      kind: "ingested-run",
      reason: "the SDK uploaded this run",
    });
    expect(body.analysis).toHaveLength(1);
    expect(body.analysis[0].touchpoint).toBe("goalCompletion");
  });

  it("answers FEATURE_NOT_SUPPORTED / contract_unavailable on a backend that predates the query", async () => {
    queryMock.mockRejectedValue(
      new Error(
        "Could not find public function for 'testSuites:getRunDisclosure'. Did you forget to run `npx convex dev`?"
      )
    );
    const res = await get();
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEATURE_NOT_SUPPORTED");
    expect(body.details?.reason).toBe("contract_unavailable");
  });

  it("also answers contract_unavailable when a missing-function failure arrives production-redacted", async () => {
    // Production Convex redacts a plain server-side Error to "Server
    // Error" — including a missing-function failure, which is exactly that
    // shape. `isMissingConvexFunctionError`'s message match cannot see it
    // once redacted, so this route must not fall through to the generic
    // upstream/502 incident path: this is exactly the state production is
    // in right now, before g4a's promote, and every request would otherwise
    // page Sentry.
    queryMock.mockRejectedValue(new Error("Server Error"));
    const res = await get();
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.code).toBe("FEATURE_NOT_SUPPORTED");
    expect(body.details?.reason).toBe("contract_unavailable");
  });

  it("still answers a genuine outage as an upstream incident, not contract_unavailable", async () => {
    // A network failure or timeout does not match the redaction shape — the
    // broadened contract_unavailable check must not swallow a real incident.
    queryMock.mockRejectedValue(new Error("fetch failed"));
    const res = await get();
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.code).toBe("SERVER_UNREACHABLE");
  });

  it("never defaults a missing field to a reassuring value (anti-sandboxesOf)", async () => {
    // `capabilities.ts`'s `sandboxesOf` hands back a permissive value when a
    // field is absent, because the write path re-enforces it regardless. That
    // is exactly wrong here: there is no downstream re-enforcement of a
    // consent read, so a lagging or malformed projection must surface as an
    // error, never as a quietly-substituted "safe" answer. `null` from the
    // query — the shape `authorizeForSuite` failing softly could produce — is
    // read as "not found", not coerced into a disclosure with defaults.
    queryMock.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    // Never a 200 with some invented `execution`/`retention` shape.
    expect(body.execution).toBeUndefined();
    expect(body.retention).toBeUndefined();
  });

  it("404s a project/suite the caller cannot see, never 403", async () => {
    queryMock.mockRejectedValue(new Error("Not a member of this project"));
    const res = await get();
    expect(res.status).toBe(404);
  });

  it("forwards caseIds/environmentId/environmentIds as the destination-affecting subset", async () => {
    queryMock.mockResolvedValue(baseDisclosure());
    await get("?caseIds=case_1,case_2&environmentIds=env_1,env_2");
    expect(queryMock).toHaveBeenCalledWith(
      "testSuites:getRunDisclosure",
      expect.objectContaining({
        suiteId: SUITE,
        caseIds: ["case_1", "case_2"],
        environmentIds: ["env_1", "env_2"],
      })
    );
  });

  it("rejects environmentId and environmentIds together with a clear 400, not a confusing 404", async () => {
    // Forwarding both to Convex would hit its ArgumentValidationError, which
    // `translateConvexReadError` reads as a bad-id 404 — correct for a stale
    // id, misleading for a well-formed-but-ambiguous request. Caught before
    // the query is ever called.
    const res = await get("?environmentId=env_1&environmentIds=env_2,env_3");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("is on the guest allowlist, GET-only", () => {
    // Guests can already POST /eval-suites/:id/runs, so denying them the
    // disclosure that describes what that run does is the one gap that would
    // actually matter — see the route's own header and guest-allowed-paths.ts.
    const path = `/api/v1/projects/${PROJECT}/eval-suites/${SUITE}/run-disclosure`;
    expect(isGuestAllowedV1Request("GET", path)).toBe(true);
    expect(isGuestAllowedV1Request("POST", path)).toBe(false);
    expect(isGuestAllowedV1Request("DELETE", path)).toBe(false);
  });
});
