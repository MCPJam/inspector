/**
 * Exa `web_search` built-in tool.
 *
 * Server-side tool the MCPJam agent exposes so the model can answer questions
 * that aren't in the docs. Inspector defines the tool *shape* (so the model
 * sees it like any other tool) but holds no Exa key: `execute` proxies to the
 * Convex HTTP action at `/tools/exa/search`, which owns the key, billing, and
 * the external call. The bearer token, current `projectId`, and `chatSessionId`
 * are threaded through so Convex can authorize the call and meter MCPJam
 * credits against the project's organization.
 *
 * `execute` returns a structured `{ error }` string instead of throwing so the
 * model can relay the problem to the user instead of breaking the turn.
 */
import { tool, type ToolSet } from "ai";
import { needsApprovalFor } from "@/shared/tool-approval";
import { z } from "zod";

export const WEB_SEARCH_TOOL_NAME = "web_search";

export interface ExaWebSearchToolOptions {
  /** Bearer authorization header forwarded to Convex (already in scope). */
  authHeader: string;
  /** Current project — required by Convex for billing authorization. */
  projectId: string;
  /** Optional chat session, used by Convex for idempotency namespacing. */
  chatSessionId?: string;
  /**
   * Set when the search happens inside a shared scenario. A redeemed link grant
   * on it makes the scenario OWNER the payer — without it a visitor on a shared
   * link cannot search at all: an anonymous one is told to sign in, and a
   * signed-in one is told they are not a member of the owner's organization.
   */
  scenarioId?: string;
  /** Mirrors the host's requireToolApproval. See the floor note on the tool. */
  requireToolApproval?: boolean;
  /**
   * Ask MCPJam only: asks Convex to bill this search to MCPJam instead of the
   * customer's credits. Honoured only alongside `x-inspector-service-token`
   * and only for a signed-in member, so on its own this is a request, not a
   * decision; Convex refuses rather than silently charging when it does not
   * hold. Absent everywhere else, which keeps the Playground's search exactly
   * as it was.
   */
  billingFeature?: string;
}

interface ExaWebSearchResult {
  title: string | null;
  url: string;
  content: string;
  publishedDate: string | null;
}

export function buildExaWebSearchTool(
  opts: ExaWebSearchToolOptions
): ToolSet[string] {
  return tool({
    description:
      "Search the web for current information. Use this for questions outside " +
      "the MCPJam docs — recent news, current library/package versions, dev " +
      "tooling, or anything that may have changed recently. Returns up to 5 " +
      "results, each with a title, URL, and content excerpt.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(400)
        .describe("Natural-language web search query"),
    }),
    // Floor: setting, like every other built-in that reaches outside this
    // process. "A read of the public web" understates it in both directions:
    // the SEARCH TEXT is the user's, and it leaves for a third party (Exa)
    // the moment the model decides to call — a host that turned approval on
    // asked to see calls like that before they happen. It also spends MCPJam
    // credits against the project's org, which is the same reason the
    // connection-opening workspace ops follow the switch rather than sitting
    // at `never` for being "just a read".
    needsApproval: needsApprovalFor(
      "setting",
      opts.requireToolApproval === true,
    ),
    execute: async ({ query }, { toolCallId, abortSignal }) => {
      const convexUrl = process.env.CONVEX_HTTP_URL;
      if (!convexUrl) {
        return { error: "Web search is not configured." };
      }
      // Only ever sent with the claim below: the claim is meaningless without
      // it, and Convex refuses a bare one.
      const serviceToken = opts.billingFeature
        ? process.env.INSPECTOR_SERVICE_TOKEN?.trim()
        : undefined;
      // FAIL CLOSED. Sending the search without the token would not "degrade
      // gracefully" — it would go through as an ordinary CUSTOMER-PAID search
      // and quietly bill a signed-in user's organization for a feature the
      // product calls free. That is the single outcome this whole change
      // exists to prevent, and it is what the backend refuses by design
      // rather than demoting to the customer's wallet. A missing token is a
      // misconfigured deployment; the honest answer is to say so.
      if (opts.billingFeature && !serviceToken) {
        return { error: "Web search is temporarily unavailable." };
      }
      try {
        const res = await fetch(`${convexUrl}/tools/exa/search`, {
          method: "POST",
          headers: {
            Authorization: opts.authHeader,
            "Content-Type": "application/json",
            ...(serviceToken
              ? { "x-inspector-service-token": serviceToken }
              : {}),
          },
          body: JSON.stringify({
            projectId: opts.projectId,
            chatSessionId: opts.chatSessionId,
            ...(opts.scenarioId ? { scenarioId: opts.scenarioId } : {}),
            ...(serviceToken && opts.billingFeature
              ? { billingFeature: opts.billingFeature }
              : {}),
            toolCallId,
            query,
          }),
          signal: abortSignal,
        });
        if (res.status === 402) {
          return { error: "Out of MCPJam credits. Top up to use web search." };
        }
        if (!res.ok) {
          return { error: `Web search failed (${res.status}).` };
        }
        // A claimed search must come back CONFIRMED platform-paid.
        //
        // Refusing before `fetch` on a missing token (above) only covers OUR
        // half. A deployment that does not know `billingFeature` ignores it,
        // runs the search on the CUSTOMER's allowance and answers an ordinary
        // 200 with results — so without this check the model would get its
        // answer and the organization would get the bill, for a feature the
        // product calls free. Same contract the model call enforces via the
        // same header.
        //
        // This cannot un-charge THIS search: by the time a response exists,
        // the backend has already run and billed it. What it does is stop the
        // NEXT one and surface the mismatch instead of hiding it, turning an
        // unbounded silent spend into one search and a visible refusal.
        if (
          opts.billingFeature &&
          res.headers?.get("x-mcpjam-platform-paid") !== opts.billingFeature
        ) {
          return { error: "Web search is temporarily unavailable." };
        }
        const data = (await res.json()) as {
          results?: ExaWebSearchResult[];
        };
        return { results: data.results ?? [] };
      } catch (error) {
        if (abortSignal?.aborted) {
          return { error: "Web search was cancelled." };
        }
        return { error: "Web search failed. Please try again." };
      }
    },
  });
}
