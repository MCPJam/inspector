/**
 * `mcpjam events` end to end: the BUILT CLI against the official-server MCP
 * Events fixture (`sdk/tests/support/events-fixture.ts`) over a real socket.
 *
 * Pinned here: exit codes, the stdout contract (one JSON result, or NDJSON
 * journal entries for `watch`), and that a webhook secret never reaches
 * stdout or stderr.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  startEventsFixture,
  type EventsFixtureHandle,
} from "../../sdk/tests/support/events-fixture.js";
import { serveLegacyTasksFixture } from "../../sdk/tests/support/legacy-tasks-fixture.js";
import { verifyWebhookDelivery } from "../../sdk/src/events/standard-webhooks.js";
import { isValidWebhookSecret } from "../../sdk/src/mcp-client-manager/events-ext.js";
import {
  errorOf,
  httpTarget,
  jsonOf,
  runCli,
  type CliRun,
} from "./support/task-cli-harness.js";

const DOC = { document_id: "doc_1" };
const EVENT_ARGS = ["--event-args", JSON.stringify(DOC)];

async function withFixture(
  fn: (fixture: EventsFixtureHandle) => Promise<void>,
  options?: Parameters<typeof startEventsFixture>[0],
): Promise<void> {
  const fixture = await startEventsFixture(options);
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function ndjson(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertNoSecrets(run: CliRun): void {
  assert.doesNotMatch(run.stdout, /whsec_/, "stdout contains something secret-shaped");
  assert.doesNotMatch(run.stderr, /whsec_/, "stderr contains something secret-shaped");
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("events list reports the declared capability and every event type", async () => {
  await withFixture(async (fixture) => {
    const run = await runCli(["events", "list", ...httpTarget(fixture.url)]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run) as {
      support: { declared: boolean; handshakeObserved: boolean };
      rawCapabilities: Record<string, unknown>;
      profile: string;
      events: Array<{ name: string; delivery: string[] }>;
    };
    assert.equal(payload.support.declared, true);
    assert.equal(payload.support.handshakeObserved, true);
    assert.deepEqual(payload.rawCapabilities.events, { listChanged: true });
    assert.equal(payload.profile, "draft@28ec35e");
    assert.deepEqual(
      payload.events.map((event) => event.name),
      ["comment.created", "build.failed"],
    );
  });
});

test("events list exits 2 against a server that did not declare capabilities.events", async () => {
  const fixture = await serveLegacyTasksFixture();
  try {
    const run = await runCli(["events", "list", ...httpTarget(fixture.url)]);
    assert.equal(run.exitCode, 2, run.stderr);
    assert.equal(run.stdout, "");
    const error = errorOf(run);
    assert.equal(error.code, "EVENTS_NOT_DECLARED");
    assert.match(error.message, /did not declare `capabilities\.events`/);
    assert.match(error.message, /--force/);
    assert.equal(
      fixture.received.some((entry) => entry.method.startsWith("events/")),
      false,
      "an undeclared server must not be sent events/*",
    );

    // --force gets past the gate and puts the request on the wire.
    const forced = await runCli(["events", "list", "--force", ...httpTarget(fixture.url)]);
    assert.notEqual(forced.exitCode, 2, forced.stderr);
    assert.match(forced.stderr, /sending events\/\* anyway because of --force/);
  } finally {
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

test("events poll: a null cursor starts from now, and the returned cursor replays what follows", async () => {
  await withFixture(async (fixture) => {
    await fixture.emit("comment.created", { ...DOC, comment_id: "before", text: "old" });

    const first = await runCli([
      "events",
      "poll",
      "comment.created",
      ...EVENT_ARGS,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(first.exitCode, 0, first.stderr);
    const start = jsonOf(first) as { events: unknown[]; cursor: string };
    assert.deepEqual(start.events, [], "a null cursor must not replay history");
    assert.equal(typeof start.cursor, "string");

    await fixture.emit("comment.created", { ...DOC, comment_id: "c1", text: "one" });
    await fixture.emit("comment.created", { document_id: "doc_2", comment_id: "x", text: "other doc" });

    const next = await runCli([
      "events",
      "poll",
      "comment.created",
      ...EVENT_ARGS,
      "--cursor",
      start.cursor,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(next.exitCode, 0, next.stderr);
    const page = jsonOf(next) as {
      events: Array<{ eventId: string; data: { comment_id: string } }>;
      cursor: string;
    };
    assert.deepEqual(
      page.events.map((event) => event.data.comment_id),
      ["c1"],
    );
    assert.notEqual(page.cursor, start.cursor, "the cursor advances past delivered events");
    const poll = fixture.received.filter((entry) => entry.method === "events/poll");
    assert.equal((poll[0]!.params as { cursor: unknown }).cursor, null);
  });
});

test("events poll maps the draft's NotFound to a named error", async () => {
  await withFixture(async (fixture) => {
    const run = await runCli(["events", "poll", "no.such.event", ...httpTarget(fixture.url)]);
    assert.equal(run.exitCode, 1, run.stderr);
    assert.equal(errorOf(run).code, "EVENTS_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

test("events watch --mode poll streams matching events as NDJSON until --duration", async () => {
  await withFixture(async (fixture) => {
    const running = runCli([
      "events",
      "watch",
      "comment.created",
      ...EVENT_ARGS,
      "--mode",
      "poll",
      "--duration",
      "6",
      ...httpTarget(fixture.url),
    ]);
    await waitFor(
      () => fixture.received.some((entry) => entry.method === "events/poll"),
      "first poll",
    );
    await fixture.emit("comment.created", { ...DOC, comment_id: "p1", text: "one" });
    await fixture.emit("comment.created", { document_id: "doc_2", comment_id: "no", text: "not ours" });
    await fixture.emit("comment.created", { ...DOC, comment_id: "p2", text: "two" });

    const run = await running;
    assert.equal(run.exitCode, 0, run.stderr);
    const lines = ndjson(run.stdout);
    assert.deepEqual(
      lines.map((line) => (line.data as { comment_id: string }).comment_id),
      ["p1", "p2"],
    );
    for (const line of lines) {
      assert.deepEqual(
        Object.keys(line).sort(),
        ["cursor", "data", "eventId", "kind", "name", "origin", "seq", "timestamp"],
      );
      assert.equal(line.kind, "event");
      assert.equal(line.origin, "poll");
      assert.equal(line.name, "comment.created");
    }
    assert.match(run.stderr, /Watching comment\.created \(poll/);
    assert.match(run.stderr, /Stopped \(duration\) after 2 events/);
    assertNoSecrets(run);
  });
});

test("events watch defaults to push when the event offers it, and stops at --max-events", async () => {
  await withFixture(async (fixture) => {
    const running = runCli([
      "events",
      "watch",
      "comment.created",
      ...EVENT_ARGS,
      "--max-events",
      "1",
      "--duration",
      "60",
      ...httpTarget(fixture.url),
    ]);
    await waitFor(() => fixture.openStreams() === 1, "push stream open");
    await fixture.emit("comment.created", { ...DOC, comment_id: "s1", text: "pushed" });

    const run = await running;
    assert.equal(run.exitCode, 0, run.stderr);
    const [line, ...rest] = ndjson(run.stdout);
    assert.deepEqual(rest, []);
    assert.equal(line!.origin, "push");
    assert.equal((line!.data as { comment_id: string }).comment_id, "s1");
    assert.equal(typeof line!.cursor, "string");
    assert.match(run.stderr, /Watching comment\.created \(push/);
    assert.match(run.stderr, /Stopped \(max-events\) after 1 event\./);
    await waitFor(() => fixture.openStreams() === 0, "push stream closed");
    assertNoSecrets(run);
  });
});

test("events watch --mode webhook --insecure-local-receiver verifies, delivers, and unsubscribes on exit", async () => {
  await withFixture(
    async (fixture) => {
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const running = runCli([
        "events",
        "watch",
        "comment.created",
        ...EVENT_ARGS,
        "--mode",
        "webhook",
        "--listen",
        `127.0.0.1:${port}`,
        "--public-url",
        origin,
        "--insecure-local-receiver",
        "--max-events",
        "1",
        "--duration",
        "60",
        ...httpTarget(fixture.url),
      ]);
      await waitFor(
        () => fixture.subscriptions().some((entry) => entry.verified),
        "verified subscription",
      );
      const verification = fixture.deliveries.find((entry) => entry.kind === "verification");
      assert.equal(verification?.status, 200, "the challenge must be answered by the local receiver");
      assert.ok(verification!.url.startsWith(`${origin}/i/`));

      await fixture.emit("comment.created", { ...DOC, comment_id: "w1", text: "hooked" });
      const run = await running;
      assert.equal(run.exitCode, 0, run.stderr);

      const [line, ...rest] = ndjson(run.stdout);
      assert.deepEqual(rest, []);
      assert.equal(line!.origin, "webhook");
      assert.equal(line!.eventId, "evt_1");
      assert.equal((line!.data as { comment_id: string }).comment_id, "w1");
      assert.equal(
        fixture.deliveries.find((entry) => entry.kind === "event")?.status,
        200,
      );

      // Removal went through the coordinator: unsubscribed on the server.
      assert.equal(fixture.subscriptions().length, 0);
      assert.ok(fixture.received.some((entry) => entry.method === "events/unsubscribe"));
      assert.match(run.stderr, /NON-CONFORMANT/);
      assert.match(run.stderr, /never count as a conformance pass/);
      assert.match(run.stderr, /Unsubscribed\./);
      assertNoSecrets(run);
    },
    { allowInsecureCallbacks: true },
  );
});

test("events watch refuses a plain-http --public-url without --insecure-local-receiver", async () => {
  const run = await runCli([
    "events",
    "watch",
    "comment.created",
    "--public-url",
    "http://127.0.0.1:9",
    ...httpTarget("http://127.0.0.1:9/mcp"),
  ]);
  assert.equal(run.exitCode, 2, run.stderr);
  const error = errorOf(run);
  assert.equal(error.code, "USAGE_ERROR");
  assert.match(error.message, /must be https/);
});

test("events watch refuses a delivery mode the profile does not use", async () => {
  await withFixture(async (fixture) => {
    const run = await runCli([
      "events",
      "watch",
      "comment.created",
      ...EVENT_ARGS,
      "--profile",
      "chatgpt",
      "--mode",
      "poll",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 2, run.stderr);
    assert.equal(errorOf(run).code, "EVENTS_NO_COMPATIBLE_DELIVERY_MODE");
  });
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------

/**
 * A receiver the USER runs: it knows the secret only through the file the CLI
 * wrote, reads it per request, verifies the signature and echoes challenges.
 */
async function startFileKeyedReceiver(secretFile: string): Promise<{
  url: string;
  verified: Array<{ kind: string }>;
  close: () => Promise<void>;
}> {
  const verified: Array<{ kind: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
      let secret = "";
      try {
        secret = readFileSync(secretFile, "utf8").trim();
      } catch {
        // Not written yet: the delivery fails verification below.
      }
      const check = await verifyWebhookDelivery({
        secrets: [secret],
        headers,
        body: new Uint8Array(body),
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (!check.ok) {
        res.writeHead(401).end();
        return;
      }
      const parsed = JSON.parse(body.toString("utf8")) as {
        type?: string;
        challenge?: string;
      };
      verified.push({ kind: parsed.type ?? "event" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(parsed.type === "verification" ? { challenge: parsed.challenge } : {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    verified,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test("events subscribe writes a new secret only to --secret-file (0600), then unsubscribe is idempotent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-events-cli-"));
  const secretFile = path.join(dir, "webhook.secret");
  await withFixture(
    async (fixture) => {
      const receiver = await startFileKeyedReceiver(secretFile);
      try {
        const run = await runCli([
          "events",
          "subscribe",
          "comment.created",
          ...EVENT_ARGS,
          "--callback-url",
          receiver.url,
          "--insecure-callback",
          "--secret-file",
          secretFile,
          ...httpTarget(fixture.url),
        ]);
        assert.equal(run.exitCode, 0, run.stderr);

        const secret = readFileSync(secretFile, "utf8").trim();
        assert.match(secret, /^whsec_/);
        assert.ok(isValidWebhookSecret(secret));
        assert.equal(statSync(secretFile).mode & 0o777, 0o600);
        assert.equal(run.stdout.includes(secret), false, "stdout leaked the secret");
        assert.equal(run.stderr.includes(secret), false, "stderr leaked the secret");
        assertNoSecrets(run);
        assert.match(run.stderr, /NON-CONFORMANT/);

        const result = jsonOf(run) as { id: string; refreshBefore: string | null };
        assert.match(result.id, /^sub_/);
        assert.equal(typeof result.refreshBefore, "string");
        // The server got exactly the secret in the file, and the user's own
        // receiver verified the challenge with it.
        const sent = fixture.received.find((entry) => entry.method === "events/subscribe");
        assert.equal(
          (sent?.params as { delivery: { secret: string } }).delivery.secret,
          secret,
        );
        assert.deepEqual(receiver.verified, [{ kind: "verification" }]);
        await fixture.emit("comment.created", { ...DOC, comment_id: "s1", text: "signed" });
        assert.deepEqual(receiver.verified.at(-1), { kind: "event" });

        // Re-running with the same file READS it: same secret, same subscription.
        const again = await runCli([
          "events",
          "subscribe",
          "comment.created",
          ...EVENT_ARGS,
          "--callback-url",
          receiver.url,
          "--insecure-callback",
          "--secret-file",
          secretFile,
          ...httpTarget(fixture.url),
        ]);
        assert.equal(again.exitCode, 0, again.stderr);
        assert.equal((jsonOf(again) as { id: string }).id, result.id);
        assert.equal(readFileSync(secretFile, "utf8").trim(), secret);
        assert.equal(fixture.subscriptions().length, 1);

        const unsubscribe = [
          "events",
          "unsubscribe",
          "comment.created",
          ...EVENT_ARGS,
          "--callback-url",
          receiver.url,
          ...httpTarget(fixture.url),
        ];
        const first = await runCli(unsubscribe);
        assert.equal(first.exitCode, 0, first.stderr);
        assert.deepEqual(jsonOf(first), { outcome: "removed" });
        assert.equal(fixture.subscriptions().length, 0);

        const second = await runCli(unsubscribe);
        assert.equal(second.exitCode, 0, second.stderr);
        assert.deepEqual(jsonOf(second), { outcome: "already-gone" });
      } finally {
        await receiver.close();
      }
    },
    { allowInsecureCallbacks: true },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("events subscribe refuses a plain-http callback without --insecure-callback, before writing anything", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-events-cli-"));
  const secretFile = path.join(dir, "webhook.secret");
  try {
    const run = await runCli([
      "events",
      "subscribe",
      "comment.created",
      "--callback-url",
      "http://127.0.0.1:9/hook",
      "--secret-file",
      secretFile,
      ...httpTarget("http://127.0.0.1:9/mcp"),
    ]);
    assert.notEqual(run.exitCode, 0);
    assert.equal(run.exitCode, 2, run.stderr);
    assert.match(errorOf(run).message, /must be https/);
    assert.throws(() => statSync(secretFile), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
