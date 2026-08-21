/**
 * The shared readiness runner, tested for what it must never do.
 *
 * The happy path is the SDK's and is covered there. What is this module's own
 * is the wiring around it, and every case below is a way that wiring could
 * quietly cost somebody a run or some money:
 *
 *   1. A RUN WITH NO REQUESTER CANNOT SPEND. Not "does not by default" —
 *      cannot, because there is nothing to call.
 *   2. EVERY BROKER FAILURE IS A GAP, NOT AN EXCEPTION. A paid, optional,
 *      non-dispositive feature must never fail a deterministic grade.
 *   3. THE PROMPT IS A DELIBERATE SUBSET. The evidence object carries auth
 *      challenges and metadata documents; none of it belongs in a provider
 *      prompt.
 *   4. CANCELLATION STOPS THE DIALLING, because the thing being stopped is
 *      traffic to somebody else's server.
 */

import { describe, expect, it, vi } from "vitest";
import { isOpenAIReadinessResult } from "@mcpjam/sdk";

import {
  ReadinessRunCancelledError,
  renderObservationEvidence,
  runDirectoryReadiness,
  type ObservationBrokerAnswer,
} from "../runner.js";

const TARGET = "https://connector.example.com/mcp";

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "demo", version: "1" },
};

const TOOL = {
  name: "search_docs",
  title: "Search docs",
  description: "Search the documentation corpus for a phrase.",
  inputSchema: { type: "object", properties: {} },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

/** A transport that answers the whole gather pass from a table. */
function wireFetch(rpc: Record<string, unknown>): typeof fetch {
  return (async (_url: any, init?: any) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answer = rpc[String(body.method)];
    if (answer === undefined) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unknown method" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return jsonRpc(body.id, answer);
  }) as unknown as typeof fetch;
}

const HEALTHY = {
  initialize: INITIALIZE,
  "tools/list": { tools: [TOOL] },
  "resources/list": { resources: [] },
};

function envelopeFor(publisher: "claude" | "openai") {
  return {
    readinessKind: `${publisher}-directory-readiness`,
    observationKind: "experience",
    observationSchemaVersion: "1",
    promptVersion: "1",
    modelId:
      publisher === "claude"
        ? "anthropic/claude-sonnet-4"
        : "openai/gpt-5.4-mini",
    observedAt: "2026-08-20T00:00:00.000Z",
    observations: [
      {
        id: `${publisher}.experience.tool-overlap`,
        summary: "search_docs and find_docs appear to cover the same job.",
        confidence: "medium",
        evidenceRefs: ["tools/search_docs"],
      },
    ],
  };
}

describe("a run with no observation requester", () => {
  it("reports not-requested and never asks anything", async () => {
    const { result, observations } = await runDirectoryReadiness({
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(HEALTHY),
    });
    expect(observations.status).toBe("not-requested");
    expect(observations.reason).toBe("not_requested");
    expect(result.llmObservations?.status).toBe("not-requested");
    expect(result.findings.some((f) => f.provenance === "llm")).toBe(false);
  });
});

describe("what the broker's answers become", () => {
  async function runWith(answer: ObservationBrokerAnswer | Error) {
    return runDirectoryReadiness({
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(HEALTHY),
      requestObservations: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
  }

  it("maps a validated envelope into the experience lane", async () => {
    const { result } = await runWith({
      status: "completed",
      envelope: envelopeFor("claude"),
    });
    const finding = result.findings.find(
      (entry) => entry.id === "claude.experience.tool-overlap",
    );
    expect(finding?.lane).toBe("experience-insights");
    expect(finding?.provenance).toBe("llm");
  });

  it("keeps a billing denial off the connector's verdict", async () => {
    const clean = await runDirectoryReadiness({
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(HEALTHY),
    });
    const { result } = await runWith({
      status: "billing-blocked",
      reason: "billing_limit_reached",
      detail: "out of credits",
    });
    // The account's problem, not the server's.
    expect(result.status).toBe(clean.result.status);
    expect(result.llmObservations?.reason).toBe("billing_limit_reached");
  });

  it("turns a thrown broker call into a gap rather than a failed run", async () => {
    const clean = await runDirectoryReadiness({
      publisher: "claude",
      target: TARGET,
      fetchFn: wireFetch(HEALTHY),
    });
    const { result } = await runWith(new Error("ECONNRESET"));
    expect(result.llmObservations?.status).toBe("provider-failed");
    // Compared against a run that never asked, because "a gap rather than a
    // failed run" is a claim about the VERDICT and `toBeDefined` cannot fail.
    expect(result.status).toBe(clean.result.status);
  });

  it("carries a RETURNED provider failure through as a gap", async () => {
    // The shape the client actually produces most often: an unreachable
    // broker, a refused request and an unreadable body all come back as a
    // value rather than a throw.
    const { result } = await runWith({
      status: "provider-failed",
      reason: "provider_error",
      detail: "the observation broker returned an unreadable body",
    });
    expect(result.llmObservations?.status).toBe("provider-failed");
    expect(result.llmObservations?.reason).toBe("provider_error");
    expect(result.findings.some((f) => f.provenance === "llm")).toBe(false);
  });

  it("re-validates the envelope against the SDK's own catalogue", async () => {
    // The backend validated against ITS mirror of the schema. The two drift —
    // a backend deployed ahead of an SDK build is the ordinary case — and the
    // SDK's catalogue is the one that decides what a finding may say.
    const { result } = await runWith({
      status: "completed",
      envelope: {
        ...envelopeFor("claude"),
        observations: [
          {
            id: "claude.experience.a-rule-the-backend-invented",
            summary: "x",
            confidence: "high",
            evidenceRefs: [],
          },
        ],
      },
    });
    expect(result.llmObservations?.status).toBe("invalid-output");
    expect(result.llmObservations?.reason).toBe("schema_invalid");
    expect(result.findings.some((f) => f.provenance === "llm")).toBe(false);
  });

  it("refuses the other publisher's envelope", async () => {
    const { result } = await runWith({
      status: "completed",
      envelope: envelopeFor("openai"),
    });
    expect(result.llmObservations?.status).toBe("invalid-output");
  });
});

describe("the observation prompt", () => {
  it("carries the tool surface and nothing else", () => {
    const rendered = renderObservationEvidence({
      target: TARGET,
      tools: [
        {
          ...TOOL,
          _meta: { "internal/secret": "do-not-send" },
        },
      ],
    });
    expect(rendered).toContain("search_docs");
    expect(rendered).toContain("readOnlyHint=true");
    // The evidence object carries auth challenges, PRM documents and raw
    // `_meta`. None of it belongs in a provider prompt, and the rendering is
    // what makes "we did not send that" a property of the code.
    expect(rendered).not.toContain("do-not-send");
    expect(rendered).not.toContain("WWW-Authenticate");
  });

  it("reports the origin rather than the full target URL", () => {
    const rendered = renderObservationEvidence({
      target: "https://connector.example.com/mcp?tenant=acme&token=sec",
      tools: [],
    });
    expect(rendered).toContain("https://connector.example.com");
    expect(rendered).not.toContain("token=sec");
  });

  it("marks a truncated view so the model does not report a partial surface as whole", () => {
    const many = Array.from({ length: 4000 }, (_, index) => ({
      name: `tool_${index}`,
      description: "x".repeat(300),
    }));
    const rendered = renderObservationEvidence({ target: TARGET, tools: many });
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(rendered).toContain("partial view");
  });

  it("says so plainly when a server advertises no tools", () => {
    expect(renderObservationEvidence({ target: TARGET, tools: [] })).toContain(
      "(none advertised)",
    );
  });
});

describe("cancellation", () => {
  it("stops before the observation call once the signal aborts", async () => {
    const controller = new AbortController();
    const requestObservations = vi.fn(async () => {
      throw new Error("should not be reached");
    });
    const fetchFn = vi.fn(async (...args: any[]) => {
      // Abort as soon as the run starts dialling, so the gather completes and
      // the observation step is the next thing that would happen.
      controller.abort();
      return (wireFetch(HEALTHY) as any)(...args);
    }) as unknown as typeof fetch;

    await expect(
      runDirectoryReadiness({
        publisher: "claude",
        target: TARGET,
        fetchFn,
        signal: controller.signal,
        requestObservations,
      }),
    ).rejects.toBeInstanceOf(ReadinessRunCancelledError);
    expect(requestObservations).not.toHaveBeenCalled();
  });

  it("refuses to start at all when the signal is already aborted", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(
      runDirectoryReadiness({
        publisher: "claude",
        target: TARGET,
        fetchFn,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(ReadinessRunCancelledError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("the OpenAI submission mode", () => {
  it("is required, and is never inferred", async () => {
    // Inference reads a forgotten package as "MCP-only", which reports the
    // package lane `not-applicable` — a missing input becoming a clean bill of
    // health.
    await expect(
      runDirectoryReadiness({
        publisher: "openai",
        target: TARGET,
        fetchFn: wireFetch(HEALTHY),
      }),
    ).rejects.toThrow(/submission mode/i);
  });

  it("grades the declared shape", async () => {
    const { result } = await runDirectoryReadiness({
      publisher: "openai",
      target: TARGET,
      submissionMode: "mcp-only",
      fetchFn: wireFetch(HEALTHY),
    });
    // Narrowed on the discriminator the OpenAI result carries and Claude's
    // does not — which is the whole reason it exists.
    if (!isOpenAIReadinessResult(result)) {
      throw new Error("an OpenAI run should produce an OpenAI result");
    }
    expect(result.readinessKind).toBe("openai-directory-readiness");
    expect(result.context.mode).toBe("mcp-only");
  });
});
