import { z } from "zod";
import { isRequestTimeoutError } from "../../conformance-timeout.js";
import type { MCPClientCheckContext } from "../types.js";
import { errorMessage } from "./helpers.js";

/**
 * The listings `capabilities-consistent` compares with the declaration. Every
 * revision: "Servers that support tools MUST declare the tools capability"
 * (2025-03-26 server/tools.mdx:36, 2025-11-25 :38, 2026-07-28 :47), and the
 * same for prompts and resources.
 */
const LISTINGS = [
  { capability: "tools", method: "tools/list", key: "tools" },
  { capability: "prompts", method: "prompts/list", key: "prompts" },
  { capability: "resources", method: "resources/list", key: "resources" },
  {
    capability: "resources",
    method: "resources/templates/list",
    key: "resourceTemplates",
  },
] as const;

type Capability = (typeof LISTINGS)[number]["capability"];

/** What one listing request got back. */
export type ListingAnswer =
  | { outcome: "listed"; count: number }
  /**
   * The server answered with a result the client could not read (a missing
   * `cacheScope` or `resultType` on 2026-07-28, a listing that is not an
   * array). It answered, so this check has its answer; the shape is the list
   * checks' and `wire-schema-valid`'s to grade.
   */
  | { outcome: "unreadable"; message: string }
  | { outcome: "refused"; code?: number; httpStatus?: number; message: string }
  | { outcome: "no-answer"; message: string };

const ANY_RESULT = z.looseObject({});

/**
 * HTTP statuses that come from what sits in front of the server, or that ask
 * for something first: none of them says whether the server serves the
 * listing. Any other HTTP error is the server turning the method down.
 */
function isNoVerdictStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

/** `SdkErrorCode.InvalidResult`, matched by its string value. */
const INVALID_RESULT_CODE = "INVALID_RESULT";

function classify(error: unknown): ListingAnswer {
  const message = errorMessage(error);
  if (isRequestTimeoutError(error)) return { outcome: "no-answer", message };
  if ((error as { code?: unknown } | null)?.code === INVALID_RESULT_CODE) {
    return { outcome: "unreadable", message };
  }
  const status = (error as { data?: { status?: unknown } } | null)?.data
    ?.status;
  if (typeof status === "number") {
    return isNoVerdictStatus(status)
      ? { outcome: "no-answer", message }
      : { outcome: "refused", httpStatus: status, message };
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number"
    ? { outcome: "refused", code, message }
    : { outcome: "no-answer", message };
}

async function ask(
  ctx: MCPClientCheckContext,
  method: string,
  key: string
): Promise<ListingAnswer> {
  ctx.config.signal?.throwIfAborted();
  try {
    // The client's own list methods return an empty list for a capability the
    // server did not declare, without sending anything. This asks anyway.
    const result = await ctx.client.requestWithSchema(
      { method, params: {} } as never,
      ANY_RESULT,
      { timeout: ctx.config.checkTimeout, signal: ctx.config.signal } as never
    );
    const items = (result as Record<string, unknown>)[key];
    return { outcome: "listed", count: Array.isArray(items) ? items.length : 0 };
  } catch (error) {
    ctx.config.signal?.throwIfAborted();
    return classify(error);
  }
}

function declares(caps: Record<string, unknown>, capability: Capability) {
  return caps[capability] !== undefined && caps[capability] !== null;
}

/**
 * Ask for every listing the server did not declare. One that comes back with
 * items is a feature served without its declaration (catalog 5.F1).
 */
export async function askUndeclaredListings(
  ctx: MCPClientCheckContext,
  caps: Record<string, unknown>
): Promise<{
  answers: Record<string, ListingAnswer>;
  mismatches: string[];
}> {
  const answers: Record<string, ListingAnswer> = {};
  const mismatches: string[] = [];
  for (const { capability, method, key } of LISTINGS) {
    if (declares(caps, capability)) continue;
    const answer = await ask(ctx, method, key);
    answers[method] = answer;
    if (answer.outcome === "listed" && answer.count > 0) {
      mismatches.push(
        `${method} returned ${answer.count} item(s) but the server does not advertise capabilities.${capability}`
      );
    }
  }
  return { answers, mismatches };
}

/**
 * 2026-07-28 only: a server that declares a capability MUST answer its
 * listing (server/tools.mdx:62, catalog 5.F2). The run's own listing does not
 * say why it came back empty: the client turns Method not found into an empty
 * list, and any other error into a failed listing. So a declared listing that
 * failed or came back empty is asked once more, to see the answer.
 */
export async function askEmptyDeclaredListings(
  ctx: MCPClientCheckContext,
  caps: Record<string, unknown>
): Promise<{
  answers: Record<string, ListingAnswer>;
  mismatches: string[];
}> {
  const answers: Record<string, ListingAnswer> = {};
  const mismatches: string[] = [];
  const listed: Record<Capability, number> = {
    tools: ctx.availableTools.length,
    prompts: ctx.availablePrompts.length,
    resources: ctx.availableResources.length,
  };
  for (const { capability, method, key } of LISTINGS) {
    if (method === "resources/templates/list") continue;
    if (!declares(caps, capability)) continue;
    const failed = ctx.unlisted?.includes(capability) ?? false;
    if (!failed && listed[capability] > 0) continue;
    const answer = await ask(ctx, method, key);
    answers[method] = answer;
    if (answer.outcome === "refused") {
      mismatches.push(
        `the server advertises capabilities.${capability} but ${method} answered with ${
          answer.code !== undefined
            ? `error ${answer.code}`
            : `HTTP ${answer.httpStatus}`
        }`
      );
    }
  }
  return { answers, mismatches };
}

/** The first listing that got no answer, for a could-not-run message. */
export function firstUnanswered(
  answers: Record<string, ListingAnswer>
): { method: string; message: string } | undefined {
  for (const [method, answer] of Object.entries(answers)) {
    if (answer.outcome === "no-answer") {
      return { method, message: answer.message };
    }
  }
  return undefined;
}
