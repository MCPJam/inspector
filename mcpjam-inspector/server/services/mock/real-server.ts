/**
 * The real server of a mock, reached as a client through a pooled manager:
 * the tested reference in `sdk/src/mocks/__tests__/real-fixture.ts`, on a
 * connection `createAuthorizedManager` opened with the caller's credentials.
 * It keeps the hash of the last tool listing it served, because the mock lists
 * tools through this object and the hash is of that same listing.
 */
import type { MCPClientManager } from "@mcpjam/sdk";
import { z } from "zod";
import {
  hashRealToolListing,
  type MockListChangedKind,
  type MockRealServer,
} from "@mcpjam/sdk/mocks";

/** The skills extension's methods are not spec methods, so they go through the client's schema-checked request. */
const LOOSE_RESULT = z.looseObject({});

const LIST_CHANGED: Array<[string, MockListChangedKind]> = [
  ["notifications/tools/list_changed", "tools"],
  ["notifications/prompts/list_changed", "prompts"],
  ["notifications/resources/list_changed", "resources"],
];

export interface PooledRealServer extends MockRealServer {
  /** Hash of the last listing this request read, or undefined if it read none. */
  listingHash(): string | undefined;
}

export function realServerOn(manager: MCPClientManager, id: string): PooledRealServer {
  let lastHash: string | undefined;
  return {
    listingHash: () => lastHash,
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
      lastHash = hashRealToolListing(tools);
      return tools as never;
    },
    callTool: async ({ name, arguments: args, signal, logLevel, onProgress, onLog }) => {
      if (logLevel) {
        // One level per connection: per request on 2026-07-28, once per session before it.
        if (manager.getLoggingMechanism(id) === "per-request-meta") {
          manager.setPerRequestLogLevel(id, logLevel);
        } else {
          await manager.setLoggingLevel(id, logLevel);
        }
      }
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
