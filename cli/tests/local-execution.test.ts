import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PlatformApiClient,
  authorizeLocalExecutionOperation,
  sendChatMessageOperation,
} from "@mcpjam/sdk/platform";
import { runCli } from "./support/cli-run.js";

type Harness = "claude-code" | "codex";
type Request = {
  path: string;
  body: Record<string, unknown>;
  grant: string | string[] | undefined;
};
function fixture(harnessId: Harness) {
  const requests: Request[] = [];
  const target = {
    kind: "local-native",
    scope: "unattended",
    harnessId,
    machineId: "machine",
    workspaceGrantId: "workspace",
    runtimeId: "runtime",
    permissionProfile: "unrestricted",
    policyVersion: "policy",
    grantToken: "test-capability-for-local-execution",
  } as const;
  let turn = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.method === "POST")
      requests.push({
        path,
        body,
        grant: req.headers["x-mcpjam-local-harness-grant"],
      });
    if (path.endsWith("/projects"))
      res.end(JSON.stringify({ items: [{ id: "project", name: "Project" }] }));
    else if (path.endsWith("/local-execution-grants"))
      res.end(JSON.stringify({ target, expiresAt: "2026-10-17T00:00:00Z" }));
    else if (path.endsWith("/chat-sessions/messages")) {
      turn += 1;
      res.end(
        JSON.stringify({
          sessionId: "session",
          turnId: `turn-${turn}`,
          projectId: "project",
          origin: "api",
          persisted: { outcome: "saved" },
          execution: {
            engine: `harness:${harnessId}`,
            venue: "local",
            runtimeVersion: "fixture-1",
            sessionId: "wire",
            turnId: `turn-${turn}`,
          },
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  return { server, requests, target };
}
async function withFixture(
  harnessId: Harness,
  run: (url: string, state: ReturnType<typeof fixture>) => Promise<void>,
) {
  const state = fixture(harnessId);
  await new Promise<void>((resolve) =>
    state.server.listen(0, "127.0.0.1", resolve),
  );
  const address = state.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}/api/v1`, state);
  } finally {
    state.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      state.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
function assertWire(requests: Request[], token: string) {
  assert.equal(requests.length, 3);
  for (const request of requests.slice(1)) {
    assert.equal(request.grant, token);
    assert.equal(JSON.stringify(request.body).includes(token), false);
    assert.equal(
      (request.body.executionTarget as { kind: string }).kind,
      "local-native",
    );
  }
  assert.equal(requests[2].body.sessionId, "session");
  assert.equal(requests[2].body.modelId, undefined);
}
for (const harnessId of ["claude-code", "codex"] as const) {
  test(`SDK preserves ${harnessId} target and grant across two turns`, async () =>
    withFixture(harnessId, async (baseUrl, state) => {
      const client = new PlatformApiClient({
        baseUrl,
        getAuth: () => "verified-user-token",
      });
      const grant = await authorizeLocalExecutionOperation.execute(
        {
          project: "project",
          harnessId,
          allowUnattended: true,
          workspaceGrantId: "workspace",
        },
        { client },
      );
      const first = await sendChatMessageOperation.execute(
        {
          project: "project",
          modelId: "openai/gpt-5.5",
          environmentId: "environment",
          toolMode: "auto",
          message: "first",
          idempotencyKey: "first",
          executionTarget: grant.target,
        },
        { client },
      );
      const second = await sendChatMessageOperation.execute(
        {
          sessionId: first.sessionId ?? undefined,
          message: "second",
          idempotencyKey: "second",
          executionTarget: grant.target,
        },
        { client },
      );
      assert.equal(first.execution?.sessionId, second.execution?.sessionId);
      assert.notEqual(first.execution?.turnId, second.execution?.turnId);
      assertWire(state.requests, state.target.grantToken);
    }));
  test(`CLI preserves ${harnessId} grant-file target across two turns`, async () =>
    withFixture(harnessId, async (baseUrl, state) => {
      const directory = await mkdtemp(join(tmpdir(), "local-target-"));
      const command = (name: string, args: string[]) =>
        runCli([
          "cloud",
          "sessions",
          name,
          ...args,
          "--api-url",
          baseUrl,
          "--api-key",
          "verified-user-token",
          "--format",
          "json",
        ]);
      try {
        const grant = await command("authorize-local", [
          "--project",
          "project",
          "--harness",
          harnessId,
          "--allow-unattended",
          "--workspace-grant",
          "workspace",
        ]);
        assert.equal(grant.exitCode, 0, grant.stderr);
        const grantFile = join(directory, "grant.json");
        await writeFile(grantFile, grant.stdout);
        const first = await command("send", [
          "--project",
          "project",
          "--model",
          "openai/gpt-5.5",
          "--environment",
          "environment",
          "--tool-mode",
          "auto",
          "--message",
          "first",
          "--idempotency-key",
          "first",
          "--execution-target",
          `@${grantFile}`,
        ]);
        assert.equal(first.exitCode, 0, first.stderr);
        const second = await command("send", [
          "--session",
          JSON.parse(first.stdout).sessionId,
          "--message",
          "second",
          "--idempotency-key",
          "second",
          "--execution-target",
          `@${grantFile}`,
        ]);
        assert.equal(second.exitCode, 0, second.stderr);
        assert.equal(JSON.parse(second.stdout).execution.venue, "local");
        assertWire(state.requests, state.target.grantToken);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }));
}
