/**
 * `cloud sessions trace` prints the MCP event that started a turn, as the
 * trace read returns it, and leaves other turns without one.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "./support/cli-run.js";

const EVENT = {
  name: "comment.created",
  eventId: "evt_1",
  timestamp: "2026-09-30T00:00:00Z",
  receivedAt: 1_700_000_000_000,
  delivery: "webhook",
  origin: "server",
  subscriptionId: "esub_1",
  triggerId: "trg_1",
};

const TRACE = {
  sessionId: "cs_1",
  origin: "event",
  chatSessionId: "event-trigger-trg_1",
  projectId: "proj-alpha",
  traceVersion: 1,
  turnCount: 2,
  latestPromptIndex: 1,
  turns: [
    { turnId: "t0", promptIndex: 0, startedAt: 1, endedAt: 2, spanCount: 0 },
    {
      turnId: "t1",
      promptIndex: 1,
      startedAt: 3,
      endedAt: 4,
      spanCount: 0,
      event: EVENT,
    },
  ],
};

test("cloud sessions trace prints each turn's event", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "proj-alpha",
              name: "Alpha",
              description: null,
              icon: null,
              organizationId: "org-1",
              visibility: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        })
      );
      return;
    }
    if (url.pathname === "/api/v1/chat-sessions/cs_1/trace") {
      res.end(JSON.stringify(TRACE));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: url.pathname }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const previousCwd = process.cwd();
  const previousEnv = {
    MCPJAM_PROJECT: process.env.MCPJAM_PROJECT,
    MCPJAM_AUTH_FILE: process.env.MCPJAM_AUTH_FILE,
  };
  process.chdir(mkdtempSync(path.join(tmpdir(), "mcpjam-trace-event-")));
  delete process.env.MCPJAM_PROJECT;
  process.env.MCPJAM_AUTH_FILE = path.join(tmpdir(), "mcpjam-no-auth.json");
  try {
    const result = await runCli([
      "cloud",
      "sessions",
      "trace",
      "--session",
      "cs_1",
      "--project",
      "proj-alpha",
      "--limit",
      "2",
      "--api-key",
      "sk_test",
      "--api-url",
      `http://127.0.0.1:${address.port}/api/v1`,
      "--format",
      "json",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const printed = JSON.parse(result.stdout);
    const turns = (printed.result ?? printed).turns;
    assert.equal(turns[0].event, undefined);
    assert.deepEqual(turns[1].event, EVENT);
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
