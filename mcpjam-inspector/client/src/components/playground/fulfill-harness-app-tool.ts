import { withPluginDeadline } from "@/shared/plugin-operation";
import {
  dispatchAppToolCall,
  type AppToolsRegistryState,
} from "@mcpjam/widget-react";
import type { StoreApi } from "zustand";
import type {
  AppToolInvocationEvent,
  ClaimedAppTool,
} from "@/shared/app-tool-rendezvous";
import { scrubAppToolResultForModel } from "../chat-v2/thread/mcp-apps/app-tools-sanitizer";

async function deliver<T>(
  expiresAt: number,
  send: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3 && Date.now() < expiresAt; attempt++) {
    try {
      return await withPluginDeadline(
        new AbortController().signal,
        Math.min(5000, expiresAt - Date.now()),
        () => new Error("App response timed out"),
        send,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("App request expired");
}

/** Claim before dispatch. A duplicate event never repeats an accepted action. */
export async function fulfillHarnessAppTool(
  event: AppToolInvocationEvent,
  deps: {
    registry: StoreApi<AppToolsRegistryState>;
    chatSessionId: () => string | undefined;
    claim: (args: {
      id: string;
      bridgeId: string;
      claim: string;
    }) => Promise<ClaimedAppTool | null>;
    complete: (args: {
      id: string;
      claim: string;
      resultJson: string;
    }) => Promise<unknown>;
  },
): Promise<void> {
  if (
    deps.chatSessionId() !== event.chatSessionId ||
    Date.now() >= event.expiresAt
  )
    return;
  const claim = crypto.randomUUID();
  const row = await deliver(
    Math.min(event.expiresAt, Date.now() + 120_000),
    () =>
      deps.claim({
        id: event.id,
        bridgeId: event.bridgeId,
        claim,
      }),
  );
  if (!row) return;
  const registry = deps.registry.getState();
  const entry = registry.resolve(row.alias, row.chatSessionId);
  let result: ReturnType<typeof scrubAppToolResultForModel>;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, row.expiresAt - Date.now()),
  );
  try {
    if (
      !entry ||
      row.alias !== event.alias ||
      row.chatSessionId !== event.chatSessionId ||
      row.chatSessionId !== deps.chatSessionId() ||
      entry.instance.bridgeId !== row.bridgeId ||
      row.bridgeId !== event.bridgeId ||
      entry.instance.serverId !== row.serverId ||
      entry.rawName !== row.rawName ||
      entry.instance.parentToolCallId !== row.parentToolCallId
    ) {
      throw new Error("App instance unavailable");
    }
    registry.registerPendingCall(row.bridgeId, controller);
    const input: unknown = JSON.parse(row.inputJson);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid app tool input");
    result = scrubAppToolResultForModel(
      await dispatchAppToolCall(entry, input as Record<string, unknown>, {
        signal: controller.signal,
      }),
    );
  } catch {
    result = {
      content: [
        {
          type: "text",
          text: "The app tool did not finish. Its action may have run. Reopen the app before trying again.",
        },
      ],
      isError: true,
    };
  } finally {
    clearTimeout(timer);
    registry.unregisterPendingCall(row.bridgeId, controller);
  }
  let resultJson = JSON.stringify(result);
  if (new TextEncoder().encode(resultJson).length > 128 * 1024) {
    resultJson = JSON.stringify({
      content: [
        { type: "text", text: "The app tool result exceeded the size limit." },
      ],
      isError: true,
    });
  }
  const response = { id: event.id, claim, resultJson };
  await deliver(row.expiresAt, () => deps.complete(response));
}
