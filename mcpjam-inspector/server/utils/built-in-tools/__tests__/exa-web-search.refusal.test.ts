/**
 * While an organization requires its own AI provider keys, Convex refuses a
 * web search with `{ ok: false, code, error, remediation }` before anything
 * is sent to the search provider. The tool keeps the code so the tool card
 * can say why search is off; every other failure reads as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExaWebSearchTool,
  webSearchRefusalMessage,
} from "../exa-web-search";

type SearchResult = {
  error?: string;
  code?: string;
  remediation?: string;
  results?: unknown[];
  answer?: string;
};

function runSearch(opts: { billingFeature?: string } = {}) {
  const tool = buildExaWebSearchTool({
    authHeader: "Bearer user-token",
    projectId: "project-1",
    chatSessionId: "session-1",
    ...(opts.billingFeature ? { billingFeature: opts.billingFeature } : {}),
  }) as unknown as {
    execute: (
      input: { query: string },
      ctx: { toolCallId: string; abortSignal?: AbortSignal },
    ) => Promise<SearchResult>;
  };
  return tool.execute({ query: "what changed in MCP" }, { toolCallId: "tc_1" });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("exa web search — organization AI key policy refusals", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("keeps the code when search can't run on the organization's providers", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      json(422, {
        ok: false,
        code: "org_runtime_unsupported",
        error: "This feature can't run on the organization's providers yet.",
        isRetryable: false,
        remediation: "unsupported",
      }),
    );
    expect(await runSearch()).toEqual({
      error: webSearchRefusalMessage("org_runtime_unsupported"),
      code: "org_runtime_unsupported",
      remediation: "unsupported",
    });
  });

  it("refuses Ask MCPJam's platform route the same way", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        json(422, { ok: false, code: "org_runtime_unsupported", error: "x" }),
      );
    const result = await runSearch({ billingFeature: "mcpjam_agent" });
    expect(result.code).toBe("org_runtime_unsupported");
    expect(result.error).toBe(
      webSearchRefusalMessage("org_runtime_unsupported"),
    );
  });

  it("names the backend's reason for any other policy refusal", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      json(503, {
        ok: false,
        code: "ai_key_policy_unavailable",
        error: "MCPJam could not read the organization's AI settings.",
        remediation: "retry_later",
      }),
    );
    expect(await runSearch()).toEqual({
      error:
        "Web search is unavailable for this organization. MCPJam could not read the organization's AI settings.",
      code: "ai_key_policy_unavailable",
      remediation: "retry_later",
    });
  });

  it("reads an unknown code, or a body without ok: false, as a plain failure", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(json(422, { ok: false, code: "something_new" }))
      .mockResolvedValueOnce(json(403, { code: "org_runtime_unsupported" }))
      .mockResolvedValueOnce(new Response("not json", { status: 500 }));
    expect(await runSearch()).toEqual({ error: "Web search failed (422)." });
    expect(await runSearch()).toEqual({ error: "Web search failed (403)." });
    expect(await runSearch()).toEqual({ error: "Web search failed (500)." });
  });

  it("passes on the short answer a search on the organization's own search model returns", async () => {
    const results = [
      {
        title: "MCP",
        url: "https://modelcontextprotocol.io",
        content: "",
        publishedDate: null,
      },
    ];
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { results, answer: "  MCP is an open protocol.  " }),
      )
      .mockResolvedValueOnce(json(200, { results }));
    expect(await runSearch()).toEqual({
      results,
      answer: "MCP is an open protocol.",
    });
    // A search on Exa has no answer, and the result has no answer field.
    expect(await runSearch()).toEqual({ results });
  });

  it("uses plain-neutral copy for a 402 without a recovery (no 'top up', wrong for Free)", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        json(402, { ok: false, code: "insufficient_credits" }),
      );
    const result = await runSearch();
    expect(result).toEqual({
      error:
        "Out of MCPJam credits for web search. Add credits or upgrade your plan in MCPJam to keep using it.",
    });
    // A Free account cannot buy credits, so the old "Top up" line is gone.
    expect(result.error).not.toMatch(/top up/i);
    expect(result.error).not.toMatch(/BYOK|try again|wait/i);
  });

  it("sends a locked wallet to support rather than to buying credits", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      json(402, {
        error: "Web search unavailable: wallet locked.",
        code: "WALLET_LOCKED",
      }),
    );
    const result = await runSearch();
    expect(result.error).toBe(
      "Web search is unavailable because this organization's MCPJam wallet is locked. Contact MCPJam support to resolve it.",
    );
    expect(result.error).not.toMatch(/add credits|buy credits|upgrade/i);
  });

  it("renders the refusal's recovery step and link when the 402 carries one", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      json(402, {
        ok: false,
        code: "user_rate_limit",
        error: "Out of MCPJam credits.",
        recovery: {
          version: 1,
          reason: "out_of_credits",
          action: "buy_credits",
          actor: "caller",
          url: "https://app.mcpjam.com/billing",
        },
      }),
    );
    const result = await runSearch();
    expect(result.error).toBe(
      "Out of MCPJam credits. Buy credits to keep going: https://app.mcpjam.com/billing",
    );
    expect(result.error).not.toMatch(/BYOK|try again|wait/i);
  });

  it.each([
    [
      "Free",
      {
        reason: "out_of_credits",
        action: "upgrade_plan",
        actor: "caller",
        plan: "pro",
        url: "https://app.mcpjam.com/billing",
      },
      "Upgrade to Pro to keep going: https://app.mcpjam.com/billing",
    ],
    [
      "paid",
      {
        reason: "out_of_credits",
        action: "buy_credits",
        actor: "caller",
        url: "https://app.mcpjam.com/billing",
      },
      "Buy credits to keep going: https://app.mcpjam.com/billing",
    ],
    [
      "budget",
      {
        reason: "budget_reached",
        action: "raise_budget",
        actor: "owner_or_admin",
        url: "https://app.mcpjam.com/budget",
      },
      "Only an organization owner or admin can raise the spend budget. Send them this link: https://app.mcpjam.com/budget",
    ],
    [
      "hold",
      { reason: "holds_committed", action: "wait", actor: "caller" },
      "Retry once the MCPJam allowance resets.",
    ],
    [
      "locked-wallet",
      { reason: "wallet_locked", action: "contact_support", actor: "support" },
      "Contact MCPJam support to arrange more credits.",
    ],
  ])(
    "renders a %s admission refusal's recovery on HTTP 429",
    async (_name, recovery, step) => {
      global.fetch = vi.fn().mockResolvedValue(
        json(429, {
          ok: false,
          code: "user_rate_limit",
          error: "Refused.",
          recovery: { version: 1, ...recovery },
        }),
      );
      expect((await runSearch()).error).toBe(
        `MCPJam refused this web search. ${step}`,
      );
    },
  );

  it("keeps the generic failure for a 429 without a recovery", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: "Too many requests" }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    expect(await runSearch()).toEqual({ error: "Web search failed (429)." });
    expect(await runSearch()).toEqual({ error: "Web search failed (429)." });
  });

  it("upgrades a Free refusal rather than telling it to buy credits", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      json(402, {
        ok: false,
        code: "user_rate_limit",
        error: "Out of MCPJam credits.",
        recovery: {
          version: 1,
          reason: "out_of_credits",
          action: "upgrade_plan",
          actor: "caller",
          plan: "pro",
          url: "https://app.mcpjam.com/billing",
        },
      }),
    );
    expect((await runSearch()).error).toBe(
      "Out of MCPJam credits. Upgrade to Pro to keep going: https://app.mcpjam.com/billing",
    );
  });
});
