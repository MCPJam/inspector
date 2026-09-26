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
import {
  EXA_SEARCH_PATH,
  PLATFORM_EXA_SEARCH_PATH,
} from "@/shared/mcpjam-agent-model";

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

type ExaWebSearchToolResult =
  { error: string } | { results: ExaWebSearchResult[] };

/** The one sentence every platform-billing refusal shows. */
const UNAVAILABLE = {
  error: "Web search is temporarily unavailable.",
} as const;

/**
 * Signals that the gate opened while this call was queued, so it should run
 * OUTSIDE the mutex. A symbol rather than `null`, which a tool result could
 * legitimately be.
 */
const RUN_UNGATED = Symbol("exa-search-run-ungated");

export function buildExaWebSearchTool(
  opts: ExaWebSearchToolOptions,
): ToolSet[string] {
  // Both latched for the life of this tool instance, which `resolveHostTools`
  // builds once per turn.
  //
  // The header check runs AFTER `fetch`, so a per-CALL refusal is no bound at
  // all: every later search in the same answer would go out, be billed to the
  // customer, and only then be refused. One turn can make many.
  //
  // A flag alone is not enough either, and the earlier version of this comment
  // claimed a bound it did not have. `executeToolCallsFromMessages` runs
  // sibling tool calls CONCURRENTLY, so three searches in one step all read an
  // unset flag before any response arrives and all three dispatch. "We lose at
  // most one search" was false for exactly the case the model produces most
  // often.
  //
  // So the unproven phase is SERIALIZED (see `runExclusive`): until one
  // claimed search has come back confirmed, at most one is ever in flight.
  // Once confirmed, the gate opens and siblings run concurrently again — the
  // cost is paid once per turn, not per search.
  let platformBillingUnconfirmed = false;
  let platformBillingConfirmed = false;

  /**
   * FIFO mutex over the unproven phase.
   *
   * Each caller takes the tail of the chain, installs its own link, then waits
   * for the previous one. Replacing the tail BEFORE awaiting is what makes it
   * a queue rather than a stampede: two callers arriving in the same tick do
   * not both see the same predecessor.
   */
  let admissionChain: Promise<void> = Promise.resolve();
  const runExclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = admissionChain;
    let release!: () => void;
    admissionChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

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
      // A claim already went out unhonoured on this turn. Every further
      // search would be charged to the customer before we could refuse it,
      // so stop before `fetch` rather than paying to learn the same thing.
      if (opts.billingFeature && platformBillingUnconfirmed) {
        return UNAVAILABLE;
      }
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
        return UNAVAILABLE;
      }

      const search = async (): Promise<ExaWebSearchToolResult> => {
        try {
          // A claimed search goes to the PLATFORM route and NEVER falls back
          // to the ordinary one. The ordinary route bills the customer, and on a
          // backend that ignores `billingFeature` it does so while answering an
          // ordinary 200 — so a fallback is the silent charge this is preventing.
          const searchPath = opts.billingFeature
            ? PLATFORM_EXA_SEARCH_PATH
            : EXA_SEARCH_PATH;
          const res = await fetch(`${convexUrl}${searchPath}`, {
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
          // The backend does not serve the platform search route: older than it,
          // or a rollback mid-session. A 404/405 is the ROUTER refusing, so Exa
          // was never called and nobody was charged — the one case where that can
          // actually be promised. Latched like a failed attestation so the rest of
          // the turn's searches stop instead of each learning it again.
          if (
            opts.billingFeature &&
            (res.status === 404 || res.status === 405)
          ) {
            platformBillingUnconfirmed = true;
            return UNAVAILABLE;
          }
          if (res.status === 402) {
            return {
              error: "Out of MCPJam credits. Top up to use web search.",
            };
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
          //
          // "One search" is true only because the unproven phase is serialized
          // by the gate at the bottom of `execute`. Without it, concurrent
          // siblings all dispatch before this line runs on any of them, and the
          // bound is however many searches the model asked for at once.
          if (
            opts.billingFeature &&
            res.headers?.get("x-mcpjam-platform-paid") !== opts.billingFeature
          ) {
            platformBillingUnconfirmed = true;
            return UNAVAILABLE;
          }
          // Proven: this backend honours the claim. Later siblings skip the
          // queue entirely.
          if (opts.billingFeature) platformBillingConfirmed = true;
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
      };

      // Nothing to establish: an unclaimed search is customer-paid by design,
      // and a claim already proven needs no gate.
      if (!opts.billingFeature || platformBillingConfirmed) return search();

      // Unproven. Take a turn, and re-read both flags inside the section — a
      // caller ahead in the queue may have settled the question while we
      // waited, in which case this call must not probe again.
      const gated = await runExclusive(
        async (): Promise<ExaWebSearchToolResult | typeof RUN_UNGATED> => {
          if (platformBillingUnconfirmed) return UNAVAILABLE;
          if (platformBillingConfirmed) return RUN_UNGATED;
          return search();
        },
      );
      // Confirmed while we queued: run outside the section so a healthy turn's
      // backlog goes out concurrently rather than one at a time.
      return gated === RUN_UNGATED ? search() : gated;
    },
  });
}
