/**
 * The lifecycle fixture server behind a real socket, for integration tests.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createLifecycleServer,
  Unreachable,
  type LifecycleLog,
  type LifecycleServerOptions,
} from "./lifecycle-server.js";

export interface ServedLifecycle {
  url: string;
  /** One line per request that reached the server, in order. */
  log: LifecycleLog;
  close: () => Promise<void>;
}

export async function serveLifecycle(
  options: LifecycleServerOptions
): Promise<ServedLifecycle> {
  const log: LifecycleLog = [];
  const answerFor = createLifecycleServer(options, log);
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text
      ? (JSON.parse(text) as {
          id?: unknown;
          method?: string;
          params?: { protocolVersion?: string };
        })
      : undefined;
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    let answer;
    try {
      answer = answerFor({
        httpMethod: req.method ?? "GET",
        method: body?.method,
        id: body?.id,
        sessionId: header("mcp-session-id"),
        protocolVersion:
          body?.method === "initialize"
            ? body.params?.protocolVersion
            : header("mcp-protocol-version"),
      });
    } catch (error) {
      if (!(error instanceof Unreachable)) throw error;
      // No answer at all: drop the connection, as a dead server would.
      req.socket.destroy();
      return;
    }

    if (answer.body === undefined) {
      res.writeHead(answer.status, answer.headers).end();
    } else if (answer.sse) {
      res
        .writeHead(answer.status, {
          "Content-Type": "text/event-stream",
          ...answer.headers,
        })
        .end(`data: ${JSON.stringify(answer.body)}\n\n`);
    } else {
      res
        .writeHead(answer.status, {
          "Content-Type": "application/json",
          ...answer.headers,
        })
        .end(JSON.stringify(answer.body));
    }
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    log,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
