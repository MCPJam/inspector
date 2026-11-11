import { mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBridge } from "@ai-sdk/harness/bridge";
import {
  CopilotClient,
  RuntimeConnection,
  convertMcpCallToolResult,
} from "@github/copilot-sdk";
import { buildHostToolCatalog } from "../../codex-appserver/bridge/host-tool-catalog.js";
import { callHostTool } from "../../codex-appserver/bridge/host-tool-call.js";
import { toMcpToolResult } from "../../codex-appserver/bridge/host-tool-result.js";
import { sessionSkillsAndTools } from "./session-skills.js";

const { values } = parseArgs({
  options: {
    workdir: { type: "string" },
    "bridge-state-dir": { type: "string" },
    "session-data-dir": { type: "string" },
    "bootstrap-dir": { type: "string" },
  },
});
const workdir = values.workdir;
const sessionDataDir = values["session-data-dir"];
const bridgeStateDir = values["bridge-state-dir"];
const bootstrap = values["bootstrap-dir"];
if (!workdir || !sessionDataDir || !bridgeStateDir || !bootstrap)
  throw new Error("Missing Copilot bridge directories.");
const baseUrl = process.env.OPENAI_BASE_URL;
const apiKey = process.env.COPILOT_MODEL_PROXY_PLACEHOLDER;
if (!baseUrl || !apiKey)
  throw new Error("Missing Copilot model proxy configuration.");
const home = join(sessionDataDir, "copilot-home");
await mkdir(home, { recursive: true });
const client = new CopilotClient({
  workingDirectory: workdir,
  baseDirectory: home,
  useLoggedInUser: false,
  mode: "empty",
  connection: RuntimeConnection.forStdio({
    path: createRequire(
      await realpath(
        join(bootstrap, "node_modules/@github/copilot/npm-loader.js"),
      ),
    ).resolve(`@github/copilot-linux-${process.arch}`),
    args: ["--disable-builtin-mcps"],
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
  }),
});

type Start = {
  type: "start";
  model: string;
  prompt: string;
  instructions?: string;
  tools?: Parameters<typeof buildHostToolCatalog>[0];
  resumeThreadId?: string;
};
let threadId: string | undefined;
await runBridge<Start>({
  bridgeType: "copilot-cli",
  bridgeStateDir,
  onStart: async (start, turn) => {
    await client.start();
    turn.abortSignal.throwIfAborted();
    const { descriptors, aliasToCanonical } = buildHostToolCatalog(
      start.tools ?? [],
    );
    const tools = descriptors.map(({ name, description, inputSchema }) => ({
      name,
      description,
      parameters: inputSchema,
      defer: "never" as const,
      // The host's needsApproval gate owns dispatch. All other CLI permission
      // requests are denied, and the only built-in tool exposed is `skill`.
      skipPermission: true,
      handler: async (input: unknown) => {
        turn.abortSignal.throwIfAborted();
        const result = await callHostTool(
          { turn, aliasToCanonical },
          { toolName: name, input },
        );
        return convertMcpCallToolResult(toMcpToolResult(result));
      },
    }));
    const config = {
      workingDirectory: workdir,
      streaming: true,
      model: start.model,
      tools,
      // This process keeps the box's home; the runtime's is `copilot-home`.
      ...sessionSkillsAndTools(
        homedir(),
        tools.map(({ name }) => name),
      ),
      ...(start.instructions
        ? {
            systemMessage: {
              mode: "append" as const,
              content: start.instructions,
            },
          }
        : {}),
      provider: {
        type: "openai" as const,
        wireApi: "responses" as const,
        transport: "http" as const,
        baseUrl,
        apiKey,
      },
      onPermissionRequest: () => ({
        kind: "denied-interactively-by-user" as const,
      }),
    };
    const resume = threadId ?? start.resumeThreadId;
    const session = resume
      ? await client.resumeSession(resume, config)
      : await client.createSession(config);
    threadId = session.sessionId;
    turn.emit({ type: "bridge-thread", threadId });
    turn.emit({ type: "stream-start", modelId: start.model });
    const openText = new Set<string>();
    const streamedText = new Set<string>();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const closeText = (id: string) => {
      if (openText.delete(id)) turn.emit({ type: "text-end", id });
    };
    // A retained turn can wait for a human longer than the SDK sendAndWait timeout.
    let finishTurn!: () => void;
    let failTurn!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => {
      finishTurn = resolve;
      failTurn = reject;
    });
    let reply: { messageId: string; content: string } | undefined;
    const unlisten = session.on((event) => {
      if (turn.abortSignal.aborted) return;
      if (event.type === "assistant.message_delta" && event.data.deltaContent) {
        const id = event.data.messageId;
        if (!openText.has(id)) {
          openText.add(id);
          streamedText.add(id);
          turn.emit({ type: "text-start", id });
        }
        turn.emit({ type: "text-delta", id, delta: event.data.deltaContent });
      } else if (event.type === "assistant.message") {
        reply = event.data;
        closeText(event.data.messageId);
      } else if (event.type === "session.idle") {
        finishTurn();
      } else if (event.type === "session.error") {
        failTurn(new Error(event.data.message));
      } else if (event.type === "assistant.usage") {
        const data = event.data;
        if (data.inputTokens !== undefined)
          inputTokens = (inputTokens ?? 0) + data.inputTokens;
        if (data.outputTokens !== undefined)
          outputTokens = (outputTokens ?? 0) + data.outputTokens;
      }
    });
    const abort = () => {
      void session.abort().then(finishTurn, failTurn);
    };
    turn.abortSignal.addEventListener("abort", abort, { once: true });
    try {
      turn.abortSignal.throwIfAborted();
      await Promise.all([completed, session.send(start.prompt)]);
      if (
        reply?.content &&
        !turn.abortSignal.aborted &&
        !streamedText.has(reply.messageId)
      ) {
        const id = reply.messageId;
        turn.emit({ type: "text-start", id });
        turn.emit({ type: "text-delta", id, delta: reply.content });
        turn.emit({ type: "text-end", id });
      }
      const finishReason = {
        unified: turn.abortSignal.aborted ? "other" : "stop",
        raw: turn.abortSignal.aborted ? "aborted" : "idle",
      };
      for (const id of openText) closeText(id);
      const usage = {
        inputTokens: { total: inputTokens },
        outputTokens: { total: outputTokens },
      };
      turn.emit({ type: "finish-step", finishReason, usage });
      turn.emit({ type: "finish", finishReason, totalUsage: usage });
    } finally {
      unlisten();
      turn.abortSignal.removeEventListener("abort", abort);
      await session.disconnect();
    }
  },
  onStop: async () => {
    await client.stop();
    return { threadId };
  },
  onDestroy: async () => {
    await client.stop();
  },
});
