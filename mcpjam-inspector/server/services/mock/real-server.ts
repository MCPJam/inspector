/**
 * The real server of a mock, reached as a client through a manager:
 * the tested reference in `sdk/src/mocks/__tests__/real-fixture.ts`, on a
 * connection `createAuthorizedManager` opened with the caller's credentials.
 *
 * It is only the transport: whether a call may be dispatched is decided by
 * `forwarding.ts`, which wraps this and answers `authorizeForward`.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import { z } from "zod";
import type { MockListChangedKind, MockRealServer } from "@mcpjam/sdk/mocks";
import { logger } from "../../utils/logger.js";

/** The skills extension's methods are not spec methods, so they go through the client's schema-checked request. */
const LOOSE_RESULT = z.looseObject({});

const LIST_CHANGED: Array<[string, MockListChangedKind]> = [
  ["notifications/tools/list_changed", "tools"],
  ["notifications/prompts/list_changed", "prompts"],
  ["notifications/resources/list_changed", "resources"],
];

/** The connection's calls, without the policy check the mock adds in front of them. */
export type LiveRealServer = Omit<MockRealServer, "authorizeForward">;

export function realServerOn(manager: MCPClientManager, id: string): LiveRealServer {
  return {
    describe: async (options) => {
      // A failure to connect here becomes `mock_real_unreachable`.
      await manager.ensureManagedClient(id, { signal: options?.signal });
      const info = manager.getInitializationInfo(id);
      return {
        capabilities: info?.serverCapabilities ?? {},
        ...(info?.serverVersion && {
          serverInfo: { name: info.serverVersion.name, version: info.serverVersion.version },
        }),
        ...(info?.instructions !== undefined && { instructions: info.instructions }),
      };
    },
    listTools: async (options) => {
      const tools = [];
      let cursor: string | undefined;
      do {
        const page = await manager.listTools(id, cursor ? { cursor } : undefined, {
          signal: options?.signal,
          cacheMode: "bypass",
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools as never;
    },
    callTool: async ({ name, arguments: args, signal, logLevel, onProgress, onLog }) => {
      if (logLevel) await askForLogs(manager, id, logLevel);
      const logHandler = (n: { params?: Record<string, unknown> }) =>
        onLog?.({
          level: n.params?.level as never,
          data: n.params?.data,
          logger: n.params?.logger as string | undefined,
        });
      if (onLog) manager.addNotificationHandler(id, "notifications/message", logHandler as never);
      try {
        return (await manager.executeTool(id, name, args, {
          signal,
          ...(onProgress && { onprogress: onProgress }),
        })) as never;
      } finally {
        if (onLog) manager.removeNotificationHandler(id, "notifications/message", logHandler as never);
      }
    },
    request: async (request, options) => {
      const client = manager.getManagedClient(id);
      if (!client) throw new Error("The real server is not connected.");
      if (request.method.startsWith("skills/")) {
        return (await client.requestWithSchema(
          { method: request.method, params: request.params } as never,
          LOOSE_RESULT,
          options,
        )) as Record<string, unknown>;
      }
      return (await client.request(
        { method: request.method, params: request.params } as never,
        options,
      )) as Record<string, unknown>;
    },
    onListChanged: (handler) => {
      const removers = LIST_CHANGED.map(([method, kind]) => {
        const fn = () => handler(kind);
        manager.addNotificationHandler(id, method as never, fn as never);
        return () => manager.removeNotificationHandler(id, method as never, fn as never);
      });
      return () => removers.forEach((remove) => remove());
    },
  };
}

type LogLevel = NonNullable<Parameters<MockRealServer["callTool"]>[0]["logLevel"]>;

/**
 * Asks the real server for log records at the caller's level, the way its
 * connection takes one: per request on 2026-07-28, `logging/setLevel` before
 * it, and nothing when it does not log. A level only adds logs, so a server
 * that refuses one must not fail the call it rode on: the refusal is logged
 * and the call goes on. (Callers send a level on every turn since the
 * Playground and evals show a tool call's logs; a 2026-07-28 server refuses
 * `logging/setLevel`, and that refusal used to fail every call through a mock.)
 */
async function askForLogs(manager: MCPClientManager, id: string, level: LogLevel): Promise<void> {
  const mechanism = manager.getLoggingMechanism(id);
  if (mechanism === "per-request-meta") {
    manager.setPerRequestLogLevel(id, level);
    return;
  }
  if (mechanism !== "setLevel") return;
  try {
    await manager.setLoggingLevel(id, level);
  } catch (error) {
    logger.warn("[mock-route] the real server refused a log level; the call goes on without its logs", {
      serverId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
