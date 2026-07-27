/**
 * A raw 2025-11-25 in-core tasks fixture server.
 *
 * `@modelcontextprotocol/server` beta.4 does not implement the 2025-11-25
 * in-core tasks utility, so this fixture answers JSON-RPC by hand: it
 * negotiates `2025-11-25`, advertises `capabilities.tasks`, exposes one tool
 * with `execution.taskSupport: "required"`, and answers a task-augmented
 * `tools/call` with a `CreateTaskResult` plus `tasks/get|result`.
 *
 * Its purpose is to prove, against the REAL beta.4 client, that the unknown
 * `params.task` key survives the client's request pipeline onto the wire (the
 * regression that broke task creation in the first place).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export const LEGACY_TASK_TOOL_NAME = "long_running";
export const LEGACY_TASK_ID = "legacy-task-1";

export interface ReceivedRequest {
  method: string;
  params: Record<string, unknown> | undefined;
}

export interface ServedLegacyTasksFixture {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

function resultFor(
  method: string,
  params: Record<string, unknown> | undefined
): Record<string, unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: { listChanged: false },
          tasks: {
            list: {},
            cancel: {},
            requests: { tools: { call: {} } },
          },
        },
        serverInfo: { name: "legacy-tasks-fixture", version: "1.0.0" },
      };
    case "tools/list":
      return {
        tools: [
          {
            name: LEGACY_TASK_TOOL_NAME,
            description: "A tool that only runs as a task.",
            inputSchema: { type: "object", properties: {} },
            execution: { taskSupport: "required" },
          },
        ],
      };
    case "tools/call":
      // The whole point of the fixture: only answer with a CreateTaskResult
      // when the client actually delivered `params.task`.
      if (params && typeof params.task === "object" && params.task !== null) {
        return {
          task: {
            taskId: LEGACY_TASK_ID,
            status: "working",
            createdAt: "2026-07-27T00:00:00Z",
            ttl: (params.task as { ttl?: number }).ttl ?? 60_000,
            pollInterval: 500,
          },
        };
      }
      return { content: [{ type: "text", text: "plain call" }] };
    case "tasks/get":
      return {
        taskId: LEGACY_TASK_ID,
        status: "completed",
        createdAt: "2026-07-27T00:00:00Z",
        ttl: 60_000,
      };
    case "tasks/result":
      return { content: [{ type: "text", text: "task done" }] };
    case "tasks/list":
      return { tasks: [] };
    default:
      return {};
  }
}

export async function serveLegacyTasksFixture(): Promise<ServedLegacyTasksFixture> {
  const received: ReceivedRequest[] = [];

  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let message: {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof message.method === "string") {
        received.push({ method: message.method, params: message.params });
      }
      if (message.id === undefined) {
        // A notification (e.g. notifications/initialized).
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: resultFor(message.method as string, message.params),
        })
      );
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    received,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
