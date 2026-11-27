/**
 * Tool Output Schema Conformant on the 2025 revisions.
 *
 * "If an output schema is provided: Servers **MUST** provide structured results
 * that conform to this schema" is in 2025-06-18 (server/tools.mdx:312-314) and
 * 2025-11-25 (:338-340), not only in 2026-07-28. The check ran on 2026-07-28
 * alone, so on those two revisions a tool whose result broke its own schema was
 * never caught.
 *
 * This is the 2025 probe: a hand-built session (`initialize`, `initialized`),
 * the tool listing, the calls the operator named, and the DELETE that ends the
 * session. What a result has to look like is graded by the same code as on
 * 2026-07-28 (`tool-output-schema.ts`).
 *
 * 2025-03-26 has no `outputSchema` and no `structuredContent`, so the rule does
 * not exist there and nothing is sent.
 */

import {
  badToolArgsMessage,
  checkToolArgs,
} from "../../conformance-tool-args.js";
import { needsSetupDetails } from "../../conformance-input.js";
import { legacyInitialize } from "../legacy-handshake.js";
import {
  DEFAULT_LEGACY_PROTOCOL_VERSION,
  jsonRpcResult,
  legacyHeaders,
  rawRequest,
  resumePolledStream,
  walkToolsList,
  type RawHttpResult,
} from "../raw-http.js";
import {
  CHECK_FIRST_PROTOCOL_VERSION,
  type MCPCheckResult,
  type RawHttpCheckContext,
} from "../types.js";
import {
  couldNotRunResult,
  errorMessage,
  notApplicableResult,
} from "./helpers.js";
import { gradeToolOutputSchemas } from "./tool-output-schema.js";
import { terminateSession } from "./transport.js";

type CheckMeta = Pick<MCPCheckResult, "id" | "category" | "title" | "description">;

/** The first revision whose tools can declare an `outputSchema`. */
export const FIRST_OUTPUT_SCHEMA_VERSION =
  CHECK_FIRST_PROTOCOL_VERSION["modern-tool-output-schema-conformant"]!;

/**
 * Whether a 2025 revision has the output schema rule. Revisions are dates, so
 * they order as strings.
 */
export function hasOutputSchemaRule(protocolVersion: string): boolean {
  return protocolVersion >= FIRST_OUTPUT_SCHEMA_VERSION;
}

export async function runLegacyToolOutputSchemaCheck(
  ctx: RawHttpCheckContext,
  meta: CheckMeta
): Promise<MCPCheckResult> {
  const startedAt = Date.now();
  const protocolVersion =
    ctx.config.protocolVersion ?? DEFAULT_LEGACY_PROTOCOL_VERSION;
  if (!hasOutputSchemaRule(protocolVersion)) {
    return notApplicableResult(
      meta,
      `${protocolVersion} has no outputSchema: tools can declare one from ${FIRST_OUTPUT_SCHEMA_VERSION} on`
    );
  }

  // Known once the handshake has answered; the session is closed with them.
  let sessionId: string | undefined;
  let negotiatedVersion: string | undefined;
  try {
    const handshake = await legacyInitialize(ctx);
    ({ sessionId, negotiatedVersion } = handshake);
    if (handshake.stop !== undefined) {
      return couldNotRunResult(
        meta,
        handshake.stop.message,
        handshake.stop.details
      );
    }
    // An unreadable initialize answer says nothing about the server's tools,
    // so it cannot make the check not applicable.
    const initialized = jsonRpcResult(handshake.result);
    if (initialized === undefined) {
      return couldNotRunResult(
        meta,
        `initialize did not return a usable result (HTTP ${handshake.result.status}), so whether any tool declares an outputSchema is unknown`,
        { httpStatus: handshake.result.status }
      );
    }
    const capabilities = initialized.capabilities;
    if (
      capabilities === null ||
      typeof capabilities !== "object" ||
      (capabilities as Record<string, unknown>).tools === undefined
    ) {
      return notApplicableResult(
        meta,
        "Server does not advertise the tools capability"
      );
    }

    /** One request on the session, the answer read even when it is polled. */
    const send = async (
      id: number,
      method: string,
      params?: Record<string, unknown>
    ): Promise<RawHttpResult> =>
      await resumePolledStream(
        ctx,
        await rawRequest(ctx, {
          headers: legacyHeaders({ protocolVersion, sessionId }),
          body: {
            jsonrpc: "2.0",
            id,
            method,
            ...(params === undefined ? {} : { params }),
          },
        }),
        { sessionId, protocolVersion }
      );

    // Read the declarations on the session that will make the calls. The
    // client's earlier listing can describe different schemas.
    const firstListId = 7960;
    const walk = await walkToolsList({
      startId: firstListId,
      request: ({ id, cursor }) =>
        send(id, "tools/list", cursor === undefined ? undefined : { cursor }),
    });
    const declared = new Map<string, unknown>();
    for (const tool of walk.tools) {
      if (typeof tool.name === "string" && tool.outputSchema !== undefined) {
        declared.set(tool.name, tool.outputSchema);
      }
    }
    let nextId = firstListId + walk.pagesRead;
    return await gradeToolOutputSchemas(meta, startedAt, {
      fixtures: ctx.config.fixtures.toolCalls,
      declared,
      complete: walk.termination === "complete" && !walk.malformedPage,
      callTool: (fixture) =>
        send(nextId++, "tools/call", {
          name: fixture.toolName,
          arguments: fixture.arguments ?? {},
        }),
      badArgs: async (toolName, args, httpStatus) => {
        // On a 401 the login is the gap to report, not the arguments.
        if (httpStatus === 401) return undefined;
        const tool = walk.tools.find((entry) => entry.name === toolName);
        const verdict = checkToolArgs(tool?.inputSchema, args ?? {});
        if (verdict.verdict !== "invalid") return undefined;
        const text = badToolArgsMessage(toolName, verdict.message);
        return couldNotRunResult(meta, text, {
          probedTool: toolName,
          argsProblem: verdict.message,
          ...needsSetupDetails("toolCallProbe", text),
        });
      },
    });
  } catch (error) {
    // A cancelled run is not a verdict.
    ctx.config.signal?.throwIfAborted();
    // A request that timed out or dropped produced no result to grade. That
    // is not a result that broke its schema, so the server is not failed.
    return couldNotRunResult(
      meta,
      `A request this check sent did not complete (${errorMessage(error)}), so no tool result could be checked against its outputSchema`
    );
  } finally {
    // The session was this check's own: it is ended whatever the verdict.
    await terminateSession(ctx, sessionId, negotiatedVersion);
  }
}
