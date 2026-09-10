import { createHash, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { chatSessionClient, resolveScopedSession } from "./chat-sessions";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token";
import {
  BrowserSessionService,
  BrowserSessionServiceError,
} from "../../services/browserd/session-service";
import {
  getConversationBrowser,
  openConversationBrowser,
  provisionConversationBrowser,
  resolveTurnBrowserPolicy,
  SessionBrowserError,
} from "./chat-session-browser";
import {
  browserSessionPolicySchema,
  browserPolicyAllowsTool,
  browserPolicyAllowsOrigin,
} from "../../../shared/browser-session-policy";
import { commandSchema } from "./chat-session-browser-command-schema";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config";
import { resolveHostTools } from "../../utils/built-in-tools/registry";
import {
  toDaemonAction,
  refusedResult,
  unknownResult,
} from "../../services/browserd/agent-contract-mapper";
import { toContractResult } from "../../services/browserd/local/agent-door";
import type {
  BrowserAgentCommand,
  BrowserAgentResult,
} from "../../../shared/browser-agent-contract";
import { createBrowserArtifactOutbox } from "../../services/browser-artifact-outbox";
import {
  wrapBrowserToolsForEvidence,
  redactBrowserScreenshots,
  type BrowserScreenshotEvidence,
} from "../../services/browser-tool-evidence";
import { v1Error, v1Resource } from "./envelope";

const openSchema = z.strictObject({
  projectId: z.string().min(1),
  policy: browserSessionPolicySchema,
  profileId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200),
});
function browserError(c: Context, error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return v1Error(c, "VALIDATION_ERROR", error.message);
  if (error instanceof SessionBrowserError)
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryAfterMs: error.retryAfterMs,
          limit: error.limit,
        },
      },
      error.status,
    );
  if (error instanceof BrowserSessionServiceError) {
    if (error.status === 404)
      return v1Error(c, "NOT_FOUND", "Browser session not found");
    if (error.status === 409) return v1Error(c, "CONFLICT", error.detail);
    if (error.status === 403)
      return v1Error(c, "FORBIDDEN", "Browser access refused");
    return c.json(
      { error: { code: "BROWSER_NOT_AVAILABLE", message: error.detail } },
      422,
    );
  }
  throw error;
}
async function boundedBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (Buffer.byteLength(text) > 64_000)
    throw new SessionBrowserError("VALIDATION_ERROR", 400, "Request too large");
  return z.record(z.string(), z.unknown()).parse(text ? JSON.parse(text) : {});
}
export function registerChatSessionBrowserRoutes(router: Hono) {
  router.post("/chat-sessions/browser", async (c) => {
    try {
      const parsed = openSchema.safeParse(await boundedBody(c));
      if (!parsed.success)
        return v1Error(c, "VALIDATION_ERROR", parsed.error.message);
      const body = parsed.data;
      const client = await chatSessionClient(c);
      const bearer = `Bearer ${await getConvexBearerForRequest(c)}`;
      const lease = (await client.mutation(
        "chatSessions:claimTurnLease" as never,
        {
          newSession: { projectId: body.projectId },
          idempotencyKey: body.idempotencyKey,
          requestFingerprint: createHash("sha256")
            .update(JSON.stringify(body))
            .digest("hex"),
        } as never,
      )) as {
        status: string;
        turnId?: string;
        executionOwnerToken?: string;
        sessionId?: string;
      };
      if (lease.status !== "claimed" || !lease.executionOwnerToken)
        return v1Error(
          c,
          "CONFLICT",
          "Browser open is already running or this key has a different outcome.",
          { sessionId: lease.sessionId },
        );
      try {
        const shell = await new BrowserSessionService().agentRequest<{
          sessionId: string;
          chatSessionId: string;
        }>("create_shell", {
          bearer,
          projectId: body.projectId,
          body: {
            turnId: lease.turnId,
            executionOwnerToken: lease.executionOwnerToken,
          },
          signal: c.req.raw.signal,
        });
        const browser = await openConversationBrowser({
          bearer,
          projectId: body.projectId,
          wireUuid: shell.chatSessionId,
          policy: body.policy,
          profileId: body.profileId,
          signal: c.req.raw.signal,
        });
        let reason: string | undefined;
        const tools = resolveHostTools(
          { builtInToolIds: ["browser"] },
          {
            authHeader: bearer,
            projectId: body.projectId,
            browserApprovalDelivery: {
              kind: "session-policy",
              policy: body.policy,
            },
            browserSessionScope: {
              kind: "conversation",
              sessionId: shell.chatSessionId,
            },
            onToolSuppressed: (item) => {
              reason = item.reason;
            },
          },
        );
        if (!tools || !Object.keys(tools).length)
          return v1Error(
            c,
            "FEATURE_NOT_SUPPORTED",
            reason ?? "Browser unavailable",
          );
        const handle = await provisionConversationBrowser({
          bearer,
          projectId: body.projectId,
          wireUuid: shell.chatSessionId,
          profileId: body.profileId,
          signal: c.req.raw.signal,
        });
        return v1Resource(c, {
          ...shell,
          projectId: body.projectId,
          browser: { ...browser, state: "active", bootId: handle.bootId },
        });
      } finally {
        await client.mutation(
          "chatSessions:releaseTurnLease" as never,
          {
            turnId: lease.turnId,
            executionOwnerToken: lease.executionOwnerToken,
          } as never,
        );
      }
    } catch (error) {
      return browserError(c, error);
    }
  });

  for (const op of [
    "open",
    "command",
    "note",
    "trace",
    "artifact",
    "close",
  ] as const)
    router.post(`/chat-sessions/:sessionId/browser/${op}`, async (c) => {
      const client = await chatSessionClient(c);
      const session = await resolveScopedSession(
        client,
        c.req.param("sessionId"),
        undefined,
      );
      if (
        session.origin !== "api" ||
        !session.projectId ||
        !session.chatSessionId
      )
        return v1Error(c, "NOT_FOUND", "API session not found");
      const bearer = `Bearer ${await getConvexBearerForRequest(c)}`;
      const projectId = session.projectId;
      const resource = (value: unknown) =>
        v1Resource(c, {
          ...(value as Record<string, unknown>),
          sessionId: session._id,
          chatSessionId: session.chatSessionId,
          projectId,
        });
      const control = <T>(
        operation: Parameters<BrowserSessionService["agentRequest"]>[0],
        body: Record<string, unknown>,
      ) =>
        new BrowserSessionService().agentRequest<T>(operation, {
          bearer,
          projectId,
          body,
          signal: AbortSignal.any([
            c.req.raw.signal,
            AbortSignal.timeout(150_000),
          ]),
        });
      try {
        const input = await boundedBody(c);
        const stored = await getConversationBrowser({
          bearer,
          projectId,
          wireUuid: session.chatSessionId,
          signal: c.req.raw.signal,
        });
        const ids = { sessionId: stored?.browserSessionId };
        const evidence = async () =>
          (await client.query(
            "chatSessions:getBrowserArtifacts" as never,
            { sessionId: session._id } as never,
          )) as {
            browserInteractionSteps?: Array<{
              toolCallId: string;
              turnId?: string;
              screenshotUrl?: string;
            }>;
          };
        if (op !== "open" && !stored)
          return v1Error(c, "NOT_FOUND", "Session has no browser");
        if (op === "close")
          return resource(
            await control("close", {
              ...ids,
              expectedBootId: stored?.lastBootId,
            }),
          );
        if (op === "trace") {
          const data = await control<{
            entries?: Array<Record<string, unknown>>;
          }>("trace", {
            ...ids,
            ...z
              .object({
                afterSeq: z.number().int().nonnegative().optional(),
                limit: z.number().int().min(1).max(100).optional(),
              })
              .parse(input),
          });
          return resource({
            ...data,
            screenshots: ((await evidence()).browserInteractionSteps ?? []).map(
              (step) => ({
                ...step,
                url: step.screenshotUrl,
                status: step.screenshotUrl ? "ready" : "not_captured",
              }),
            ),
            sessionId: session._id,
            chatSessionId: session.chatSessionId,
          });
        }
        if (op === "artifact") {
          const commandId = z.string().min(1).parse(input.commandId);
          const item = (await evidence()).browserInteractionSteps?.find(
            (step) =>
              step.turnId === `command:${commandId}` &&
              step.toolCallId === commandId,
          );
          if (!item?.screenshotUrl)
            return v1Error(c, "NOT_FOUND", "Screenshot unavailable");
          return resource({ url: item.screenshotUrl });
        }
        const host = stored?.hostId
          ? await fetchHostRuntimeConfig({
              hostId: stored.hostId,
              bearer,
              signal: c.req.raw.signal,
            })
          : undefined;
        if (host && !host.ok)
          return v1Error(c, "FORBIDDEN", "Browser host unavailable");
        const resolved = resolveTurnBrowserPolicy({
          body:
            op === "open"
              ? z
                  .strictObject({
                    policy: browserSessionPolicySchema.optional(),
                    profileId: z.string().optional(),
                  })
                  .parse(input)
              : {},
          stored,
          hostId: stored?.hostId,
          hostRuntimeConfig: host?.ok ? host.config : undefined,
          toolMode: session.resumeConfig?.toolMode,
        });
        let reason: string | undefined;
        const tools = resolveHostTools(
          { builtInToolIds: ["browser"] },
          {
            authHeader: bearer,
            projectId,
            browserApprovalDelivery: { kind: "session-policy", ...resolved },
            browserSessionScope: {
              kind: "conversation",
              sessionId: session.chatSessionId,
            },
            onToolSuppressed: (item) => {
              reason = item.reason;
            },
          },
        );
        if (!tools || !Object.keys(tools).length)
          return v1Error(
            c,
            "FEATURE_NOT_SUPPORTED",
            reason ?? "Browser unavailable",
          );
        const browser =
          op === "note"
            ? stored!
            : await openConversationBrowser({
                bearer,
                projectId,
                wireUuid: session.chatSessionId,
                policy: resolved.policy,
                profileId: resolved.profileId,
                hostId: stored?.hostId,
                signal: c.req.raw.signal,
              });
        if (op === "open") {
          const commandId = `open:${randomUUID()}`;
          await control("claim", {
            sessionId: browser.browserSessionId,
            commandId,
            fingerprint: "open",
          });
          try {
            const handle = await provisionConversationBrowser({
              bearer,
              projectId,
              wireUuid: session.chatSessionId,
              hostId: stored?.hostId,
              profileId: resolved.profileId,
              signal: c.req.raw.signal,
            });
            await control("finish", {
              sessionId: browser.browserSessionId,
              commandId,
              result: { status: "executed", ok: true, commandId },
            });
            return resource({
              browser: { ...browser, state: "active", bootId: handle.bootId },
            });
          } catch (error) {
            await control("finish", {
              sessionId: browser.browserSessionId,
              commandId,
              result: { status: "unknown", ok: false, commandId },
            });
            throw error;
          }
        }
        const command =
          op === "command"
            ? (commandSchema.parse(input.command) as BrowserAgentCommand)
            : undefined;
        const note =
          op === "note"
            ? z.string().min(1).max(4096).parse(input.text)
            : undefined;
        const commandId = z
          .string()
          .min(1)
          .max(128)
          .parse(input.commandId ?? randomUUID());
        const tabId =
          input.tabId === undefined
            ? undefined
            : z.string().min(1).max(128).parse(input.tabId);
        const claim = await control<{
          claimed: boolean;
          seq: number;
          result: BrowserAgentResult | null;
        }>("claim", {
          sessionId: browser.browserSessionId,
          commandId,
          fingerprint: createHash("sha256")
            .update(JSON.stringify({ command, note, tabId }))
            .digest("hex"),
        });
        if (!claim.claimed)
          return resource(
            claim.result ?? unknownResult({ commandId, reason: "transport" }),
          );
        const ledger = { sessionId: browser.browserSessionId, seq: claim.seq };
        let result:
          BrowserAgentResult | (BrowserAgentResult & { note: string });
        if (note !== undefined)
          result = { status: "executed", ok: true, commandId, ledger, note };
        else {
          const toolName =
            command!.op === "observe"
              ? "browser_observe"
              : command!.op === "act"
                ? ["close_tab", "activate_tab"].includes(command!.verb)
                  ? "browser_tabs"
                  : "browser_act"
                : command!.op === "invoke_page_tool"
                  ? `webmcp:${command!.toolKey}`
                  : command!.op === "cancel_page_tool"
                    ? "browser_webmcp_invoke"
                    : "browser_navigate";
          const mapped = toDaemonAction(command!);
          if (!browserPolicyAllowsTool(resolved.effectivePolicy, toolName))
            result = refusedResult({
              commandId,
              ledger,
              code: "tool_not_allowed",
              message: "The session policy does not permit this command",
            });
          else if (
            command!.op === "navigate" &&
            !browserPolicyAllowsOrigin(resolved.effectivePolicy, command!.url)
          )
            result = refusedResult({
              commandId,
              ledger,
              code: "origin_not_allowed",
              message: "The session policy does not permit this origin",
            });
          else if (!mapped.ok)
            result = refusedResult({ commandId, ledger, ...mapped.refusal });
          else {
            let dispatched = false;
            try {
              const handle = await provisionConversationBrowser({
                bearer,
                projectId,
                wireUuid: session.chatSessionId,
                hostId: stored?.hostId,
                profileId: resolved.profileId,
                signal: c.req.raw.signal,
              });
              const outbox = createBrowserArtifactOutbox({
                chatSessionId: session.chatSessionId,
                convexAuthToken: bearer.replace(/^Bearer /, ""),
                logScope: "session-browser-command",
              });
              const screenshots: BrowserScreenshotEvidence[] = [];
              const wrapped = wrapBrowserToolsForEvidence(
                {
                  [toolName]: {
                    execute: async () => {
                      if (
                        command!.op !== "navigate" &&
                        command!.op !== "observe" &&
                        resolved.effectivePolicy.origins !== null
                      ) {
                        const before = await handle.client.sendCommand(
                          {
                            commandId: `${commandId}:origin`,
                            source: "agent",
                            sessionId: browser.browserSessionId,
                            actor: { kind: "agent", id: "session-api" },
                            ...(tabId ? { tabId } : {}),
                            action: { kind: "observe", mode: "url" },
                          },
                          handle.bootId,
                        );
                        const url =
                          before.status === "ok"
                            ? (
                                before.result?.output as
                                  { url?: string } | undefined
                              )?.url
                            : undefined;
                        if (
                          !url ||
                          !browserPolicyAllowsOrigin(
                            resolved.effectivePolicy,
                            url,
                          )
                        )
                          throw new Error(
                            "origin_not_allowed: observe an allowed page before acting",
                          );
                      }
                      dispatched = true;
                      const response = await handle.client.sendCommand(
                        {
                          commandId,
                          source: "agent",
                          sessionId: browser.browserSessionId,
                          actor: { kind: "agent", id: "session-api" },
                          ...(tabId ? { tabId } : {}),
                          action: mapped.action!,
                        },
                        handle.bootId,
                      );
                      const raw =
                        response.status === "ok"
                          ? (response.result?.output as
                              { url?: string } | undefined)
                          : undefined;
                      const mayCapture =
                        resolved.effectivePolicy.origins === null ||
                        (raw?.url !== undefined &&
                          browserPolicyAllowsOrigin(
                            resolved.effectivePolicy,
                            raw.url,
                          ));
                      return {
                        response,
                        output: mayCapture ? raw : undefined,
                        ok:
                          response.status === "ok" &&
                          response.result?.ok !== false,
                      };
                    },
                  },
                } as never,
                {
                  turnId: `command:${commandId}`,
                  promptIndex: 0,
                  evidence: screenshots,
                  persist: async (step) => {
                    outbox.enqueueSteps([step], 0);
                    await Promise.race([
                      outbox.flush(),
                      new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, 10_000);
                        timer.unref?.();
                      }),
                    ]);
                    return undefined;
                  },
                },
              );
              const value = (await wrapped[toolName]!.execute!(
                {},
                { toolCallId: commandId, messages: [] },
              )) as {
                response: Parameters<typeof toContractResult>[0]["response"];
              };
              const resultUrl =
                value.response.status === "ok"
                  ? (
                      value.response.result?.output as
                        { url?: string } | undefined
                    )?.url
                  : undefined;
              result =
                resolved.effectivePolicy.origins !== null &&
                value.response.status === "ok" &&
                (!resultUrl ||
                  !browserPolicyAllowsOrigin(
                    resolved.effectivePolicy,
                    resultUrl,
                  ))
                  ? refusedResult({
                      commandId,
                      ledger,
                      code: "origin_not_allowed",
                      message:
                        "The result origin is unavailable or outside the session policy",
                    })
                  : toContractResult({
                      response: value.response,
                      commandId,
                      policy: {
                        mode: "allow_all",
                        ...(resolved.effectivePolicy.origins
                          ? {
                              originAllowlist: resolved.effectivePolicy.origins,
                            }
                          : {}),
                      },
                      ledger,
                    }).result;
              result = redactBrowserScreenshots(result, {
                turnId: `command:${commandId}`,
                toolCallId: commandId,
                stepIndex: 0,
              }) as BrowserAgentResult;
            } catch (error) {
              result = dispatched
                ? unknownResult({ commandId, reason: "transport" })
                : refusedResult({
                    commandId,
                    ledger,
                    code: "browser_unavailable",
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
            }
          }
        }
        await control("finish", {
          sessionId: browser.browserSessionId,
          commandId,
          result,
        });
        const shots =
          (await evidence()).browserInteractionSteps
            ?.filter((step) => step.turnId === `command:${commandId}`)
            .map((step) => ({
              ...step,
              url: step.screenshotUrl,
              status: step.screenshotUrl ? "ready" : "not_captured",
            })) ?? [];
        return resource({ ...result, screenshots: shots });
      } catch (error) {
        return browserError(c, error);
      }
    });
}
