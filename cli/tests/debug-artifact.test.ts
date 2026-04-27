import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ServerDoctorResult } from "@mcpjam/sdk";
import {
  buildCommandArtifactError,
  buildDebugArtifactEnvelope,
  writeCommandDebugArtifact,
} from "../src/lib/debug-artifact.js";
import { createCliRpcLogCollector } from "../src/lib/rpc-logs.js";

function createDoctorResult<TTarget>(target: TTarget): ServerDoctorResult<TTarget> {
  return {
    generatedAt: "2026-04-11T00:00:00.000Z",
    status: "ready" as const,
    target,
    probe: null,
    connection: {
      status: "connected" as const,
      detail: "Connected and initialized successfully.",
    },
    initInfo: null,
    capabilities: null,
    tools: [],
    toolsMetadata: {},
    resources: [],
    resourceTemplates: [],
    prompts: [],
    checks: {
      probe: { status: "skipped" as const, detail: "skipped" },
      connection: { status: "ok" as const, detail: "ok" },
      initialization: { status: "ok" as const, detail: "ok" },
      capabilities: { status: "ok" as const, detail: "ok" },
      tools: { status: "ok" as const, detail: "ok" },
      resources: { status: "ok" as const, detail: "ok" },
      resourceTemplates: { status: "ok" as const, detail: "ok" },
      prompts: { status: "ok" as const, detail: "ok" },
    },
    error: null,
  };
}

test("buildDebugArtifactEnvelope merges rpc logs and redacts payloads", () => {
  const primaryCollector = createCliRpcLogCollector({ "__cli__": "example" });
  primaryCollector.rpcLogger({
    serverId: "__cli__",
    direction: "send",
    message: {
      headers: {
        Authorization: "Bearer top-secret",
      },
    },
  } as any);

  const snapshotCollector = createCliRpcLogCollector({ "__cli__": "example" });
  snapshotCollector.rpcLogger({
    serverId: "__cli__",
    direction: "receive",
    message: {
      accessToken: "nested-secret",
    },
  } as any);

  const payload = buildDebugArtifactEnvelope({
    commandName: "tools call",
    commandInput: {
      toolName: "echo",
      params: {
        clientSecret: "secret-value",
      },
    },
    target: {
      label: "https://example.com/mcp",
      headerNames: ["Authorization"],
    },
    outcome: {
      status: "error",
      error: buildCommandArtifactError("TOOL_CALL_FAILED", "Tool call failed."),
      result: {
        accessToken: "result-secret",
      },
    },
    snapshot: createDoctorResult({
      label: "https://example.com/mcp",
      headerNames: ["Authorization"],
    }),
    collectors: [primaryCollector, snapshotCollector],
  });

  const commandInput = payload.command.input as {
    toolName: string;
    params: { clientSecret: string };
  };
  const outcomeResult = payload.outcome.result as { accessToken: string };
  const rpcLogs = payload._rpcLogs as Array<{
    message: {
      headers?: { Authorization?: string };
      accessToken?: string;
    };
  }>;

  assert.equal(commandInput.params.clientSecret, "[REDACTED]");
  assert.equal(outcomeResult.accessToken, "[REDACTED]");
  assert.equal(payload._rpcLogs?.length, 2);
  assert.equal(rpcLogs[0]?.message.headers?.Authorization, "[REDACTED]");
  assert.equal(rpcLogs[1]?.message.accessToken, "[REDACTED]");
});

test("writeCommandDebugArtifact writes a snapshot artifact and emits a human notice", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-debug-artifact-"));
  const artifactPath = path.join(directory, "artifact.json");
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const writtenPath = await writeCommandDebugArtifact(
      {
        outputPath: artifactPath,
        format: "human",
        commandName: "server validate",
        commandInput: {},
        target: {
          kind: "http",
          label: "https://example.com/mcp",
        },
        outcome: {
          status: "success",
          result: {
            success: true,
          },
        },
        snapshot: {
          input: {
            config: {
              url: "https://example.com/mcp",
              timeout: 1_000,
            },
            target: {
              kind: "http",
              label: "https://example.com/mcp",
            },
            timeout: 1_000,
          },
        },
      },
      {
        runDoctor: async <TTarget>() =>
          createDoctorResult({
            kind: "http",
            label: "https://example.com/mcp",
          } as TTarget),
      },
    );

    const contents = JSON.parse(await readFile(writtenPath!, "utf8"));

    assert.equal(contents.command.name, "server validate");
    assert.equal(contents.outcome.status, "success");
    assert.equal(contents.snapshot.status, "ready");
    assert.match(stderr, /Debug artifact:/);
    assert.match(stderr, /artifact\.json/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("writeCommandDebugArtifact suppresses human notice when quiet", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-debug-artifact-"));
  const artifactPath = path.join(directory, "quiet.json");
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    await writeCommandDebugArtifact(
      {
        outputPath: artifactPath,
        format: "human",
        quiet: true,
        commandName: "server validate",
        commandInput: {},
        target: "https://example.com/mcp",
        outcome: {
          status: "success",
          result: { success: true },
        },
      },
      {
        runDoctor: async <TTarget>() =>
          createDoctorResult("https://example.com/mcp" as TTarget),
      },
    );

    assert.equal(stderr, "");
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("writeCommandDebugArtifact preserves command failure and records snapshot errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-debug-artifact-"));
  const artifactPath = path.join(directory, "failure.json");

  const writtenPath = await writeCommandDebugArtifact(
    {
      outputPath: artifactPath,
      format: "json",
      commandName: "oauth login",
      commandInput: {
        clientSecret: "secret-value",
      },
      target: {
        kind: "http",
        label: "https://example.com/mcp",
      },
      outcome: {
        status: "error",
        error: new Error("OAuth login did not complete"),
        result: {
          credentials: {
            refreshToken: "refresh-secret",
          },
        },
      },
      snapshot: {
        input: {
          config: {
            url: "https://example.com/mcp",
            timeout: 1_000,
          },
          target: {
            kind: "http",
            label: "https://example.com/mcp",
          },
          timeout: 1_000,
        },
      },
    },
    {
      runDoctor: async () => {
        throw new Error("snapshot timed out");
      },
    },
  );

  const contents = JSON.parse(await readFile(writtenPath!, "utf8"));

  assert.equal(contents.outcome.status, "error");
  assert.equal(contents.outcome.error.code, "INTERNAL_ERROR");
  assert.equal(contents.outcome.result.credentials.refreshToken, "[REDACTED]");
  assert.equal(contents.snapshot, null);
  assert.equal(contents.snapshotError.code, "TIMEOUT");
});
