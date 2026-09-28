/**
 * The MCPJam-hosted rail and the no-upload guarantee, through the PRODUCTION
 * model factory: `runSuiteFile` itself, no injected model.
 *
 * Only the platform is stubbed — lease mint/revoke and the model proxy
 * answer from canned responses — while MCP traffic reaches a real loopback
 * server. What is asserted is what left the process: which endpoints were
 * called, with which credentials and headers, and that nothing ever reached
 * an eval-results or artifact-ingestion endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSuiteFile } from "../src/suite-file-run/run-suite-file.js";
import { SuiteFileRunError } from "../src/suite-file-run/errors.js";
import {
  servePolicyTargetFixture,
  type PolicyTargetFixture,
} from "./support/policy-target-fixture.js";

const PLATFORM = "https://platform.example.com";
const PROXY = "https://proxy.example.com/web/harness/model-proxy/anthropic";

let fixture: PolicyTargetFixture;
const realFetch = globalThis.fetch;

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

function stubPlatform(
  options: { refuseMint?: { status: number; body: unknown } } = {}
): Sent[] {
  const sent: Sent[] = [];
  let mints = 0;
  let generations = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? request?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const body =
        typeof init?.body === "string"
          ? init.body
          : request
            ? await request.clone().text()
            : "";
      sent.push({
        url,
        method: init?.method ?? request?.method ?? "GET",
        headers,
        body,
      });
      if (url.endsWith("/model-leases")) {
        if (options.refuseMint) {
          return Response.json(options.refuseMint.body, {
            status: options.refuseMint.status,
          });
        }
        mints += 1;
        return Response.json({
          lease: `lease_${mints}`,
          protocol: "anthropic",
          proxyBaseUrl: PROXY,
          expiresAt: Date.now() + 30 * 60_000,
          runId: `run_${mints}`,
        });
      }
      if (url.endsWith("/model-leases/revoke"))
        return Response.json({ ok: true, revoked: 1 });
      if (url.startsWith(PROXY)) {
        generations += 1;
        const toolTurn = !body.includes("tool_result");
        return Response.json({
          id: `msg_${generations}`,
          type: "message",
          role: "assistant",
          model: "anthropic/claude-haiku-4.5",
          content: toolTurn
            ? [
                {
                  type: "tool_use",
                  id: `toolu_${generations}`,
                  name: "read_note",
                  input: { id: "7" },
                },
              ]
            : [{ type: "text", text: "The note says buy milk." }],
          stop_reason: toolTurn ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 4 },
        });
      }
      return new Response("unexpected endpoint", { status: 599 });
    })
  );
  return sent;
}

const SUITE = `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_platform
  name: platform rail
target:
  servers:
    - name: notes
defaults:
  judge:
    enabled: false
  model: anthropic/claude-haiku-4.5
  iterations: 2
  passThreshold: 1
  validity: {}
cases:
  - id: c_read
    title: reads the note
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: read_note
`;

beforeEach(async () => {
  fixture = await servePolicyTargetFixture();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fixture.close();
});

describe("MCPJam-hosted inference", () => {
  it("pre-mints one lease, sends the refreshed bearer and headers to the platform only, and revokes", async () => {
    const sent = stubPlatform();
    let reads = 0;
    const result = await runSuiteFile(SUITE, {
      servers: { notes: { config: { url: fixture.url } } },
      inference: {
        mode: "auto",
        resolveMcpjam: async () => ({
          baseUrl: PLATFORM,
          projectId: "proj_123",
          getAuth: async () => `tok_${++reads}`,
          headers: { "x-mcpjam-client": "cli-test" },
        }),
      },
    });
    expect(result.verdict).toBe("passed");
    expect(result.cases[0]!.rail).toBe("mcpjam");
    expect(fixture.calls.read_note).toBe(2);

    const mints = sent.filter((entry) => entry.url.endsWith("/model-leases"));
    expect(mints).toHaveLength(1);
    expect(mints[0]!.url).toBe(
      `${PLATFORM}/api/v1/projects/proj_123/model-leases`
    );
    expect(mints[0]!.headers.authorization).toMatch(/^Bearer tok_\d+$/);
    expect(mints[0]!.headers["x-mcpjam-client"]).toBe("cli-test");

    const proxied = sent.filter((entry) => entry.url.startsWith(PROXY));
    expect(proxied.length).toBeGreaterThanOrEqual(4);
    for (const request of proxied) {
      expect(request.headers["x-mcpjam-harness-lease"]).toBe("lease_1");
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-mcpjam-client"]).toBeUndefined();
      expect(JSON.stringify(request)).not.toMatch(/tok_\d/);
    }
    expect(
      sent.filter((entry) => entry.url.endsWith("/model-leases/revoke"))
    ).toHaveLength(1);
    // Only the lease API and the proxy: nothing else left the process.
    for (const entry of sent) {
      expect(
        entry.url.startsWith(PROXY) ||
          entry.url === `${PLATFORM}/api/v1/projects/proj_123/model-leases` ||
          entry.url ===
            `${PLATFORM}/api/v1/projects/proj_123/model-leases/revoke`
      ).toBe(true);
    }
    // Nothing secret in the result.
    expect(JSON.stringify(result)).not.toMatch(/tok_\d|lease_\d|run_\d/);
  });

  it("refuses a billing refusal at mint — before any model or tool call — and releases resources", async () => {
    const sent = stubPlatform({
      refuseMint: {
        status: 403,
        body: {
          code: "FORBIDDEN",
          message: "Free tier",
          details: { code: "free_tier_model_restricted" },
        },
      },
    });
    const error = await runSuiteFile(SUITE, {
      servers: { notes: { config: { url: fixture.url } } },
      inference: {
        mode: "mcpjam",
        resolveMcpjam: async () => ({
          baseUrl: PLATFORM,
          projectId: "proj_123",
          getAuth: async () => "tok",
        }),
      },
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SuiteFileRunError);
    expect(error).toMatchObject({
      code: "BILLING_REFUSED",
      category: "billing",
      phase: "setup",
    });
    expect(fixture.calls.read_note).toBe(0);
    expect(sent.some((entry) => entry.url.startsWith(PROXY))).toBe(false);
  });

  it("refuses rejected platform credentials at mint as credentials", async () => {
    stubPlatform({
      refuseMint: {
        status: 401,
        body: { code: "UNAUTHORIZED", message: "bad token" },
      },
    });
    const error = await runSuiteFile(SUITE, {
      servers: { notes: { config: { url: fixture.url } } },
      inference: {
        mode: "mcpjam",
        resolveMcpjam: async () => ({
          baseUrl: PLATFORM,
          projectId: "proj_123",
          getAuth: async () => "tok",
        }),
      },
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      code: "CREDENTIALS_REJECTED",
      category: "credentials",
    });
  });

  it("refuses an API base that already carries /api/v1, and the default project sentinel", async () => {
    stubPlatform();
    for (const connection of [
      { baseUrl: `${PLATFORM}/api/v1`, projectId: "proj_123" },
      { baseUrl: PLATFORM, projectId: "default" },
    ]) {
      const error = await runSuiteFile(SUITE, {
        servers: { notes: { config: { url: fixture.url } } },
        inference: {
          mode: "mcpjam",
          resolveMcpjam: async () => ({
            ...connection,
            getAuth: async () => "tok",
          }),
        },
      }).catch((caught) => caught);
      expect(error).toMatchObject({
        code: "OPTIONS_INVALID",
        category: "usage",
      });
    }
  });

  it("never resolves the platform on a BYOK-only run", async () => {
    stubPlatform();
    const resolveMcpjam = vi.fn();
    const error = await runSuiteFile(SUITE, {
      servers: { notes: { config: { url: fixture.url } } },
      inference: { mode: "byok", providerKeys: {}, resolveMcpjam },
    }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "CREDENTIALS_MISSING" });
    expect(resolveMcpjam).not.toHaveBeenCalled();
  });
});

describe("no upload, ever", () => {
  it("sends nothing to eval-result or artifact endpoints even with MCPJAM_API_KEY set", async () => {
    vi.stubEnv("MCPJAM_API_KEY", "sk_mcpjam_should_never_be_used");
    vi.stubEnv("MCPJAM_BASE_URL", "https://platform.example.com");
    const sent = stubPlatform();
    const result = await runSuiteFile(SUITE, {
      servers: { notes: { config: { url: fixture.url } } },
      inference: {
        resolveMcpjam: async () => ({
          baseUrl: PLATFORM,
          projectId: "proj_123",
          getAuth: async () => "tok",
        }),
      },
    });
    expect(result.report.metadata.upload.requested).toBe(false);
    for (const entry of sent) {
      expect(entry.url).not.toMatch(
        /sdk-evals|eval-results|artifacts|evals\/runs|reportEval/i
      );
      expect(JSON.stringify(entry.headers)).not.toContain(
        "sk_mcpjam_should_never_be_used"
      );
    }
  });

  it("queues no upload when the run is cancelled", async () => {
    vi.stubEnv("MCPJAM_API_KEY", "sk_mcpjam_should_never_be_used");
    const sent = stubPlatform();
    const controller = new AbortController();
    const pending = runSuiteFile(SUITE, {
      servers: { notes: { config: { url: fixture.url } } },
      inference: {
        resolveMcpjam: async () => ({
          baseUrl: PLATFORM,
          projectId: "proj_123",
          getAuth: async () => "tok",
        }),
      },
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "caseStart") controller.abort(new Error("stop"));
      },
    });
    const result = await pending;
    expect(result.termination).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const entry of sent) {
      expect(entry.url).not.toMatch(
        /sdk-evals|eval-results|artifacts|evals\/runs/i
      );
    }
  });
});
