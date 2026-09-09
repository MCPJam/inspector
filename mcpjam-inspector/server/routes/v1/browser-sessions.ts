/** Public coding-agent browser API. Identity, admission and history live in Convex. */
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ensureHostedConversationSession } from "../../utils/built-in-tools/browser.js";
import {
  BrowserSessionService,
  BrowserSessionServiceError,
} from "../../services/browserd/session-service.js";
import {
  parseSessionPolicy,
  policyRefusalFor,
  resolveAgentActor,
  toContractResult,
} from "../../services/browserd/local/agent-door.js";
import {
  toDaemonAction,
  refusedResult,
  unknownResult,
} from "../../services/browserd/agent-contract-mapper.js";
import type {
  BrowserAgentCommand,
  BrowserAgentSessionPolicy,
  BrowserAgentResult,
} from "../../../shared/browser-agent-contract.js";
import { v1Error, v1Resource } from "./envelope.js";

const router = new Hono();
const id = z.string().min(1).max(128);
const commandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("navigate"),
    url: z.string().url().max(8192),
    newTab: z.boolean().optional(),
    observeAfter: z.enum(["a11y", "screenshot", "none"]).optional(),
  }),
  z.object({
    op: z.literal("observe"),
    mode: z.enum([
      "a11y",
      "screenshot",
      "text",
      "dom",
      "console",
      "network",
      "dialog",
      "url",
      "page_tools",
    ]),
    requestId: id.optional(),
    rootRef: id.optional(),
    rootSelector: z.string().max(4096).optional(),
    filter: z.enum(["interactive", "all"]).optional(),
  }),
  z.object({
    op: z.literal("act"),
    verb: z.enum([
      "click",
      "type",
      "press",
      "scroll",
      "hover",
      "drag",
      "select",
      "close_tab",
      "activate_tab",
      "accept_dialog",
      "dismiss_dialog",
    ]),
    target: z
      .union([
        z.object({ ref: id }),
        z.object({ selector: z.string().max(4096) }),
        z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
      ])
      .optional(),
    value: z.string().max(16000).optional(),
    expectedState: z.string().max(4096).optional(),
    observeAfter: z.enum(["a11y", "screenshot", "none"]).optional(),
  }),
]);
type AgentSession = {
  ownerUserId: string;
  sessionId: string;
  owner: { kind: "conversation"; id: string };
  policy: BrowserAgentSessionPolicy;
  state?: string;
};

async function control<T>(
  bearer: string,
  op: Parameters<BrowserSessionService["agentRequest"]>[0],
  body: Record<string, unknown>,
): Promise<T> {
  return new BrowserSessionService().agentRequest<T>(op, {
    bearer,
    projectId: String(body.projectId),
    body,
    signal: AbortSignal.timeout(75_000),
  });
}

for (const op of [
  "session",
  "sessions",
  "command",
  "trace",
  "note",
  "artifact",
  "close",
] as const) {
  router.post(`/browser-sessions/${op}`, async (c) => {
    const text = await c.req.text();
    if (Buffer.byteLength(text) > 64000)
      return v1Error(c, "VALIDATION_ERROR", "Request too large");
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(text);
    } catch {
      return v1Error(c, "VALIDATION_ERROR", "Invalid JSON");
    }
    const parsed = z
      .object({ projectId: id, sessionId: id.optional() })
      .safeParse(input);
    if (!parsed.success)
      return v1Error(c, "VALIDATION_ERROR", "projectId is required");
    const { projectId, sessionId } = parsed.data;
    const bearer = await getConvexBearerForRequest(c);
    try {
      if (op === "sessions")
        return v1Resource(c, await control(bearer, "list", { projectId }));
      if (op === "session") {
        const policy = parseSessionPolicy(input.policy);
        if (!policy)
          return v1Error(
            c,
            "VALIDATION_ERROR",
            "Declare a browser session policy",
          );
        if (input.profile !== undefined && input.profile !== "persistent")
          return v1Error(
            c,
            "VALIDATION_ERROR",
            "Cloud agent sessions use an isolated persistent profile; omit --profile",
          );
        if (input.attach === "require")
          return v1Error(
            c,
            "VALIDATION_ERROR",
            "Use --session to address an existing cloud session",
          );
        if (
          input.observe !== undefined ||
          input.captureTypedText === true ||
          input.captureScreenshots === false
        )
          return v1Error(
            c,
            "VALIDATION_ERROR",
            "Use observe after open; cloud capture options are not supported",
          );
        const key =
          input.runKey === undefined ? randomUUID() : id.parse(input.runKey);
        const opened = await control<{ session: AgentSession }>(
          bearer,
          "open",
          { projectId, key, policy },
        );
        const handle = await ensureHostedConversationSession({
          bearer,
          projectId,
          contextMode: "persistent",
          logicalSessionId: opened.session.owner.id,
          ownerKind: "conversation",
        });
        return v1Resource(c, {
          session: {
            ...opened.session,
            engine: "hosted",
            bootId: handle.bootId,
          },
          runKey: key,
        });
      }
      if (!sessionId)
        return v1Error(c, "VALIDATION_ERROR", "sessionId is required");
      const ids = { projectId, sessionId };
      const { session } = await control<{ session: AgentSession }>(
        bearer,
        "get",
        ids,
      );
      if (op === "trace")
        return v1Resource(
          c,
          await control(bearer, "trace", {
            ...ids,
            ...z
              .object({
                afterSeq: z.number().int().nonnegative().optional(),
                limit: z.number().int().min(1).max(100).optional(),
                commandId: id.optional(),
              })
              .parse(input),
          }),
        );
      if (op === "artifact")
        return v1Resource(
          c,
          await control(bearer, "artifact", {
            ...ids,
            commandId: id.parse(input.artifactId),
          }),
        );
      if (op === "close")
        return v1Resource(c, await control(bearer, "close", ids));
      if (session.state === "closed")
        return v1Error(c, "CONFLICT", "Browser session closed");
      const command =
        op === "command"
          ? (commandSchema.parse(input.command) as BrowserAgentCommand)
          : undefined;
      const note =
        op === "note"
          ? z.string().min(1).max(4096).parse(input.text)
          : undefined;
      const commandId =
        input.commandId === undefined
          ? randomUUID()
          : id.parse(input.commandId);
      const tabId =
        input.tabId === undefined ? undefined : id.parse(input.tabId);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ command, note, tabId }))
        .digest("hex");
      const claim = await control<{
        claimed: boolean;
        seq: number;
        result: BrowserAgentResult | null;
      }>(bearer, "claim", { ...ids, commandId, fingerprint });
      // Never replay a pending claim: an earlier replica may still be executing it.
      if (!claim.claimed)
        return v1Resource(
          c,
          claim.result ?? unknownResult({ commandId, reason: "transport" }),
        );
      const ledger = { sessionId, seq: claim.seq };
      let result: BrowserAgentResult & { note?: string };
      let screenshot: string | undefined;
      if (note)
        result = { status: "executed", ok: true, commandId, ledger, note };
      else {
        const mapped = toDaemonAction(command!);
        const refusal =
          policyRefusalFor(session.policy, command!) ??
          (!mapped.ok ? mapped.refusal : undefined);
        if (refusal) result = refusedResult({ commandId, ledger, ...refusal });
        else {
          let sent = false;
          try {
            const handle = await ensureHostedConversationSession({
              bearer,
              projectId,
              contextMode: "persistent",
              logicalSessionId: session.owner.id,
              ownerKind: "conversation",
            });
            sent = true;
            const response = await handle.client.sendCommand(
              {
                commandId,
                source: "agent",
                sessionId,
                actor: resolveAgentActor({
                  userId: session.ownerUserId,
                  clientKind: input.client,
                  clientId: input.clientId,
                }),
                ...(tabId ? { tabId } : {}),
                action: mapped.action!,
              },
              handle.bootId,
            );
            const raw =
              response.status === "ok" ||
              response.status === "stale_observation"
                ? (response.result?.output as
                    { screenshot?: unknown } | undefined)
                : undefined;
            const candidate =
              typeof raw?.screenshot === "string" &&
              raw.screenshot.length <= 512000
                ? raw.screenshot
                : undefined;
            const artifacts = candidate
              ? {
                  screenshot: {
                    id: commandId,
                    mediaType: "image/jpeg",
                    bytes: Buffer.byteLength(candidate, "base64"),
                  },
                }
              : undefined;
            result = toContractResult({
              response,
              commandId,
              policy: session.policy,
              ledger,
              ...(artifacts ? { artifacts } : {}),
            }).result;
            // Only persist pixels the policy-filtered result actually exposes.
            if (
              (result.status === "executed" &&
                result.page?.artifacts?.screenshot) ||
              (result.status === "refused" &&
                result.refusal.page?.artifacts?.screenshot)
            )
              screenshot = candidate;
            if (typeof raw?.screenshot === "string" && !candidate)
              result = {
                ...result,
                historyWarning:
                  "Screenshot exceeded the cloud artifact limit; request a smaller observation.",
              };
          } catch (error) {
            result = sent
              ? unknownResult({ commandId, reason: "transport" })
              : refusedResult({
                  commandId,
                  ledger,
                  code: "browser_unavailable",
                  message:
                    error instanceof Error
                      ? error.message
                      : "The cloud browser could not be started",
                });
          }
        }
      }
      try {
        await control(bearer, "finish", {
          ...ids,
          commandId,
          result,
          ...(screenshot ? { screenshot } : {}),
        });
      } catch {
        result = {
          ...result,
          historyWarning:
            "The command outcome could not be saved; do not replay with a new command id.",
        };
      }
      return v1Resource(c, result);
    } catch (error) {
      if (error instanceof z.ZodError)
        return v1Error(c, "VALIDATION_ERROR", error.message);
      if (error instanceof BrowserSessionServiceError)
        return v1Error(
          c,
          error.status === 404
            ? "NOT_FOUND"
            : error.status === 401
              ? "UNAUTHORIZED"
              : error.status === 403
                ? "FORBIDDEN"
                : "CONFLICT",
          error.detail,
        );
      throw error;
    }
  });
}
export default router;
