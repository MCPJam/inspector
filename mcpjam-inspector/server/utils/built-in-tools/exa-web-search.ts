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
import { z } from "zod";

export const WEB_SEARCH_TOOL_NAME = "web_search";

export interface ExaWebSearchToolOptions {
  /** Bearer authorization header forwarded to Convex (already in scope). */
  authHeader: string;
  /** Current project — required by Convex for billing authorization. */
  projectId: string;
  /** Optional chat session, used by Convex for idempotency namespacing. */
  chatSessionId?: string;
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
    execute: async ({ query }, { toolCallId, abortSignal }) => {
      const convexUrl = process.env.CONVEX_HTTP_URL;
      if (!convexUrl) {
        return { error: "Web search is not configured." };
      }
      try {
        const res = await fetch(`${convexUrl}/tools/exa/search`, {
          method: "POST",
          headers: {
            Authorization: opts.authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectId: opts.projectId,
            chatSessionId: opts.chatSessionId,
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
