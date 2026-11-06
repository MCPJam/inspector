// Runs on the measured sandbox. stdin accepts fixture messages only. stdout
// contains the qualifying event and timing, never the provider response.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareCodexHome } from "../../server/utils/harness/codex-appserver/bridge/codex-home.ts";
import { spawnAppServerClient } from "../../server/utils/harness/codex-appserver/bridge/app-server-client.ts";
import { waitForNativeMcpServers } from "../../server/utils/harness/codex-appserver/bridge/native-mcp-ready.ts";

import { nativeIdentity } from "./native-identity.mjs";
import { scrubLogText } from "../../shared/log-scrubber.ts";

function ack(input) {
  process.stdout.write(JSON.stringify(input) + "\n");
}
const directory = await mkdtemp(join(tmpdir(), "mcpjam-cli-benchmark-"));
let session, current, clientId, configuration;
const die = (error) => current?.complete(false);
const observe = (event, name) => {
  if (
    !current ||
    current.event ||
    current.workload !== (event === "stdout-text" ? "text" : "tool")
  )
    return;
  if (event === "stdout-tool-start" && name !== current.toolName) return;
  current.event = event;
  current.ms = performance.now() - current.since;
  current.visible();
};

async function startClaude(config) {
  const file = join(directory, "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: config.servers }), {
    mode: 0o600,
  });
  const args = [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--model",
    config.model,
    "--strict-mcp-config",
    "--mcp-config",
    file,
    "--settings",
    JSON.stringify(config.settings ?? {}),
  ];
  if (config.tools !== undefined) args.push("--tools", config.tools);
  if (config.effort) args.push("--effort", config.effort);
  if (config.systemPrompt)
    args.push("--append-system-prompt", config.systemPrompt);
  if (config.toolName) args.push("--allowedTools", config.toolName);
  const base = "/home/user/.harness-bootstrap/claude-code";
  let executable = config.executable;
  if (!executable) {
    const manifest = await realpath(
      join(base, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
    );
    const agentRequire = createRequire(manifest);
    executable = join(
      dirname(
        agentRequire.resolve(
          "@anthropic-ai/claude-agent-sdk-linux-x64/package.json",
        ),
      ),
      "claude",
    );
  }
  const child = spawn(executable, args, {
    cwd: directory,
    stdio: ["pipe", "pipe", "ignore"],
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(directory, "claude"),
      DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });
  child.on("error", die);
  child.on("exit", die);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return die();
    }
    if (current) {
      current.events.push({
        type: value.type,
        subtype: value.subtype,
        uuid: value.uuid,
        commandUuid: value.command_uuid,
        state: value.state,
        deltaType: value.event?.delta?.type,
        assistantTextLength: value.message?.content?.reduce?.(
          (n, b) => n + (b.type === "text" ? (b.text?.length ?? 0) : 0),
          0,
        ),
        resultTextLength:
          typeof value.result === "string" ? value.result.length : undefined,
      });
      if (current.events.length > 30) current.events.shift();
    }
    if (current && value.type === "result") {
      current.terminalStatus = value.is_error
        ? (value.subtype ?? "error")
        : "success";
      current.terminalSummary =
        typeof value.result === "string"
          ? scrubLogText(value.result, 200)
          : undefined;
      if (typeof value.result === "string")
        current.output = value.result.slice(0, 4096);
    }
    if (current && value.type === "system" && value.subtype === "api_retry")
      current.upstreamStatus = Number.isInteger(value.errorStatus)
        ? value.errorStatus
        : undefined;
    if (value.type === "stream_event") {
      const event = value.event;
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text?.trim()
      )
        observe("stdout-text");
      if (
        event?.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      )
        observe("stdout-tool-start", event.content_block.name);
    }
    if (value.type === "result")
      current?.complete(
        value.is_error === false && value.subtype === "success",
      );
  });
  return {
    submit(prompt) {
      child.stdin.write(
        JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          parent_tool_use_id: null,
          message: { role: "user", content: prompt },
        }) + "\n",
      );
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill();
        await ended;
      }
    },
  };
}

async function startCodex(config) {
  const home = prepareCodexHome({
    codexHome: join(directory, "codex"),
    baseUrl: process.env.OPENAI_BASE_URL,
    apiKeyEnvVar: "CODEX_API_KEY",
    closeModelConnections: process.env.MCPJAM_CLOSE_MODEL_CONNECTIONS === "1",
    nativeMcpServers: config.servers,
    untrustedProjectPaths: [directory],
  });
  const cli = spawnAppServerClient({
    command: process.execPath,
    args: [
      config.executable ??
        "/home/user/.harness-bootstrap/codex-appserver/node_modules/@openai/codex/bin/codex.js",
      "app-server",
    ],
    cwd: directory,
    env: { ...process.env, CODEX_HOME: home },
  });
  try {
    await cli.request("initialize", {
      clientInfo: { name: "mcpjam-benchmark", version: "1" },
      capabilities: { experimentalApi: true },
    });
    cli.notify("initialized", {});
    const { thread } = await cli.request("thread/start", {
      cwd: directory,
      model: config.model,
      approvalPolicy: config.approvalPolicy ?? "never",
      sandbox: config.sandbox ?? "read-only",
      ...(config.systemPrompt
        ? { developerInstructions: config.systemPrompt }
        : {}),
    });
    await waitForNativeMcpServers({
      runtime: cli,
      threadId: thread.id,
      serverNames: Object.keys(config.servers),
    });
    cli.onNotification(({ method, params }) => {
      if (params?.threadId !== thread.id) return;
      if (method === "item/agentMessage/delta") {
        if (current)
          current.output = (
            (current.output ?? "") + (params.delta ?? "")
          ).slice(0, 4096);
        if (params.delta?.trim()) observe("stdout-text");
      }
      if (method === "item/started" && params.item?.type === "mcpToolCall")
        observe("stdout-tool-start", params.item.tool);
      if (method === "turn/completed") {
        if (current) current.terminalStatus = params.turn?.status;
        current?.complete(params.turn?.status === "completed");
      }
    });
    cli.onServerRequest(async () => {
      throw Error("Unexpected approval in the native baseline.");
    });
    void cli.exited.then(die);
    return {
      submit: (prompt) =>
        cli.request("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: prompt }],
          model: config.model,
          effort: config.effort,
        }),
      close: () => cli.kill(),
    };
  } catch (error) {
    await cli.kill();
    throw error;
  }
}

async function measure(command) {
  if (!session || current || !["text", "tool"].includes(command.workload))
    throw Error("Invalid CLI turn");
  let timer;
  const finished = new Promise((resolve) => {
    current = {
      workload: command.workload,
      toolName: command.toolName,
      since: performance.now(),
      wallStarted: Date.now(),
      events: [],
      visible() {
        clearTimeout(timer);
        timer = setTimeout(() => current?.complete(false), 120_000);
      },
      complete(ok) {
        const sample = current;
        if (!sample) return;
        const failed = !ok || !sample.event || sample.ms >= 60_000;
        resolve({
          id: command.id,
          failed,
          ms: failed ? 60_000 : sample.ms,
          event: sample.event,
          output: sample.output ?? "",
          submittedAt: sample.wallStarted,
          endedAt: Date.now(),
          elapsedMs: performance.now() - sample.since,
          terminalStatus: sample.terminalStatus ?? "deadline-or-process-exit",
          upstreamStatus: sample.upstreamStatus,
          terminalSummary: failed ? sample.terminalSummary : undefined,
          events: sample.events,
        });
        current = undefined;
      },
    };
    timer = setTimeout(() => current?.complete(false), 60_000);
  });
  try {
    void Promise.resolve(session.submit(command.prompt)).catch(die);
    const sample = await finished;
    ack({
      ...sample,
      configuration,
      nativeIdentity: nativeIdentity(process.pid, clientId),
    });
    if (sample.failed) {
      await session.close();
      session = undefined;
    }
  } finally {
    clearTimeout(timer);
  }
}

const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    const command = JSON.parse(line);
    if (command.op === "start" && !session) {
      if (!["claude-code", "codex"].includes(command.client))
        throw Error("Unknown CLI");
      clientId = command.client;
      session = await (command.client === "codex" ? startCodex : startClaude)(
        command,
      );
      configuration = {
        model: command.model,
        effort: command.effort,
        systemPrompt: command.systemPrompt,
        serverNames: Object.keys(command.servers),
      };
      ack({ ready: true });
    } else if (command.op === "send") await measure(command);
    else if (command.op === "close") break;
    else throw Error("Invalid benchmark instruction");
  }
} finally {
  await session?.close();
}
