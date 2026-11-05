import { ELICITATION_POLL_INTERVAL_MS } from "../../config";
import { setTimeout as delay } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { mcpAppToolResultSchema as CallToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import { scrubMetaAndStructuredContentFromToolResult } from "@mcpjam/sdk";
import { jsonSchema, tool, type ToolSet, type UIMessageChunk } from "ai";
import {
  appToolInvocations,
  type AppToolCallScope,
} from "@/shared/app-tool-rendezvous";
import type { AppToolSnapshotEntry } from "@/shared/chat-v2";
import { logger } from "../logger";
import {
  waitForPluginOperation,
  withPluginDeadline,
} from "@/shared/plugin-operation";

export interface AppToolStore {
  create: (
    scope: AppToolCallScope & { inputJson: string },
  ) => Promise<{ id: string; expiresAt: number }>;
  read: (id: string) => Promise<{ state: string; resultJson?: string }>;
  finish: (id: string, consumed: boolean) => Promise<unknown>;
}
export function convexAppToolStore(authHeader: string): AppToolStore {
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("App tools require a configured backend.");
  const client = new ConvexHttpClient(url);
  client.setAuth(authHeader.replace(/^Bearer\s+/i, ""));
  return {
    create: (args) => client.mutation(appToolInvocations.create, args),
    read: (id) => client.query(appToolInvocations.read, { id }),
    finish: (id, consumed) =>
      client.mutation(appToolInvocations.finish, { id, consumed }),
  };
}
const failed = () => ({
  content: [
    {
      type: "text" as const,
      text: "The app tool could not finish. Reopen the app before trying again; its previous action may have run.",
    },
  ],
  isError: true,
});

async function finish(store: AppToolStore, id: string, consumed: boolean) {
  try {
    await withPluginDeadline(
      new AbortController().signal,
      3000,
      () => new Error("App tool cleanup timed out"),
      () => store.finish(id, consumed),
    );
  } catch {
    // Expiry remains authoritative if cleanup cannot reach the backend.
    logger.warn("App-tool receipt cleanup deferred to expiry", { consumed });
  }
}

/** Native tools use the same live browser instance as the chat's app snapshot. */
export function harnessAppTools(options: {
  entries: AppToolSnapshotEntry[];
  projectId: string;
  chatSessionId: string;
  turnId: string;
  authHeader: string;
  signal?: AbortSignal;
  writer: { write: (chunk: UIMessageChunk) => void };
  store?: AppToolStore;
}): ToolSet {
  const entries = options.entries.filter((entry) => !!entry.bridgeId);
  if (!entries.length) return {};
  const store = options.store ?? convexAppToolStore(options.authHeader);
  const tools: ToolSet = {};
  for (const entry of entries) {
    const bridgeId = entry.bridgeId;
    if (!bridgeId) continue;
    tools[entry.alias] = tool({
      description: `[${entry.appName}] ${entry.description ?? entry.rawName}`,
      inputSchema: jsonSchema<Record<string, unknown>>(
        entry.inputSchema ?? { type: "object", properties: {} },
      ),
      execute: async (input, { toolCallId }) => {
        let id: string | undefined;
        let consumed = false;
        try {
          return await withPluginDeadline(
            options.signal ?? new AbortController().signal,
            120_000,
            () => new Error("App tool timed out"),
            async (active) => {
              const row = await waitForPluginOperation(active, async () => {
                const created = await store.create({
                  projectId: options.projectId,
                  chatSessionId: options.chatSessionId,
                  turnId: options.turnId,
                  toolCallId,
                  alias: entry.alias,
                  bridgeId,
                  serverId: entry.serverId,
                  parentToolCallId: entry.parentToolCallId,
                  rawName: entry.rawName,
                  inputJson: JSON.stringify(input),
                });
                if (active.aborted) await finish(store, created.id, false);
                return created;
              });
              id = row.id;
              options.writer.write({
                type: "data-harness-app-tool",
                transient: true,
                data: {
                  id,
                  chatSessionId: options.chatSessionId,
                  alias: entry.alias,
                  bridgeId,
                  expiresAt: row.expiresAt,
                },
              });
              return withPluginDeadline(
                active,
                Math.max(1, row.expiresAt - Date.now()),
                () => new Error("App tool request expired"),
                async (pending) => {
                  while (!pending.aborted && Date.now() < row.expiresAt) {
                    const state = await waitForPluginOperation(pending, () =>
                      store.read(row.id),
                    );
                    if (
                      (state.state === "completed" ||
                        state.state === "consumed") &&
                      state.resultJson !== undefined
                    ) {
                      const raw = CallToolResultSchema.parse(
                        JSON.parse(state.resultJson),
                      );
                      const result =
                        scrubMetaAndStructuredContentFromToolResult(raw);
                      consumed = true;
                      return result;
                    }
                    if (state.state !== "pending" && state.state !== "claimed")
                      return failed();
                    await delay(ELICITATION_POLL_INTERVAL_MS, undefined, { signal: pending });
                  }
                  return failed();
                },
              );
            },
          );
        } catch {
          return failed();
        } finally {
          if (id) await finish(store, id, consumed);
        }
      },
    });
  }
  return tools;
}
