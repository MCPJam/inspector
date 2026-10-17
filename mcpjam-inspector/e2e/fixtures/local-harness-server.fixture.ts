import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { it } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import {
  localApprovalFixture as state,
  localApprovalOptions,
} from "../../server/utils/harness/__tests__/local-approval-runtime.fixture";
import { runHarnessTurn } from "../../server/utils/harness/run-harness-turn";
import {
  describeParkedLocalSession,
  resetApprovalParkForTests,
} from "../../server/utils/harness/local/approval-park";
import {
  listLocalHarnessSessions,
  stopAllLocalHarnessSessions,
} from "../../server/utils/harness/local/session-registry";
import type { ModelMessage } from "@ai-sdk/provider-utils";

let transcript: ModelMessage[] = [];
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<string> {
  let value = "";
  for await (const chunk of request) value += chunk;
  return value;
}
async function handle(request: IncomingMessage, response: ServerResponse) {
  if (request.url === "/health") return json(response, { ok: true });
  if (request.url === "/stats")
    return json(response, {
      executions: state.executions,
      resumed: state.resumed,
      active: listLocalHarnessSessions().length,
    });
  if (request.url === "/reset") {
    const input = JSON.parse(await body(request)) as {
      harness?: string;
      count?: number;
    };
    await stopAllLocalHarnessSessions();
    resetApprovalParkForTests();
    state.saved = null;
    state.sessionId = "";
    state.alive = false;
    state.executions = 0;
    state.resumed = 0;
    state.currentApproval = 1;
    state.maxApprovals = input.count === 1 ? 1 : 2;
    state.harnessId = input.harness === "codex" ? "codex" : "claude-code";
    transcript = [];
    return json(response, { ok: true });
  }
  if (request.url === "/stop") {
    await stopAllLocalHarnessSessions();
    return json(response, { ok: true });
  }
  if (request.url === "/history")
    return json(response, {
      transcript,
      pending: (describeParkedLocalSession(state.sessionId)?.state ===
      "awaiting-approval"
        ? (describeParkedLocalSession(state.sessionId)?.pendingApprovalIds ??
          [])
        : []
      ).map((id) => ({
        approvalId: id,
        toolCallId: `call-${id.slice(1)}`,
        providerExecuted: true,
      })),
    });
  if (request.url !== "/chat") {
    response.writeHead(404).end();
    return;
  }
  return chat(request, response);
}
async function chat(request: IncomingMessage, response: ServerResponse) {
  const input = JSON.parse(await body(request)) as { messages: UIMessage[] };
  const stop = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) stop.abort();
  });
  const result = await runHarnessTurn(
    localApprovalOptions({
      messages: await convertToModelMessages(input.messages),
      abortSignal: stop.signal,
      harness: state.harnessId,
      modelId:
        state.harnessId === "codex"
          ? "openai/gpt-5.5"
          : "anthropic/claude-haiku-4.5",
      onConversationComplete: async (messages) => {
        transcript = messages;
        return { outcome: "saved" };
      },
    }),
    "ui",
  );
  if (!result.response) throw new Error("expected a streamed response");
  response.writeHead(
    result.response.status,
    Object.fromEntries(result.response.headers),
  );
  const reader = result.response.body?.getReader();
  if (reader)
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(chunk.value);
    }
  response.end();
}

it.skipIf(process.env.LOCAL_HARNESS_BROWSER_SERVER !== "1")(
  "serves the local approval browser fixture",
  async () => {
    const server = createServer((request, response) => {
      void handle(request, response).catch((error) => {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    server.listen(6315, "127.0.0.1");
    await once(server, "listening");
    try {
      await new Promise<void>((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      });
    } finally {
      await stopAllLocalHarnessSessions();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  900_000,
);
