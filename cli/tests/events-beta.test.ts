import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startEventsFixture } from "../../sdk/tests/support/events-fixture.js";
import {
  mintTestCertificate,
  trustingFetch,
} from "../../sdk/tests/support/events-tls.js";
import { runCli, httpTarget, jsonOf } from "./support/task-cli-harness.js";

test("Events beta negotiates, routes all named requests, and delivers over SSE and signed HTTPS", async () => {
  const cert = mintTestCertificate();
  const dir = mkdtempSync(path.join(tmpdir(), "events-beta-"));
  const data = { document_id: "doc", comment_id: "42", text: "hello" };
  const fixture = await startEventsFixture({
    beta: true,
    acceptedTokens: ["test-principal"],
    deliveryFetch: trustingFetch(cert),
    onToolCall: async () => {
      await fixture.emit("comment.created", data);
    },
  });
  const target = [
    ...httpTarget(fixture.url),
    "--access-token",
    "test-principal",
    "--protocol-version",
    "2026-07-28",
  ];
  const args = JSON.stringify({ document_id: "doc" });
  try {
    const list = await runCli(["events", "list", ...target]);
    assert.equal(list.exitCode, 0, list.stderr);
    assert.equal(jsonOf(list).profile, "beta@c77b843");

    const watch = runCli([
      "events",
      "watch",
      "comment.created",
      ...target,
      "--event-args",
      args,
      "--mode",
      "push",
      "--duration",
      "20",
      "--max-events",
      "1",
    ]);
    const deadline = Date.now() + 20_000;
    while (!fixture.openStreams() && Date.now() < deadline) await delay(20);
    const opened = fixture.openStreams() > 0;
    if (opened) await fixture.emit("comment.created", data);
    const result = await watch;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(opened, `The CLI did not open a Beta push stream. ${result.stderr}`);
    const event = JSON.parse(result.stdout.trim());
    assert.equal(event.origin, "push");
    assert.deepEqual(event.data, data);

    const certFile = path.join(dir, "cert.pem");
    const keyFile = path.join(dir, "key.pem");
    writeFileSync(certFile, cert.cert);
    writeFileSync(keyFile, cert.key, { mode: 0o600 });
    const conformance = () =>
      runCli([
        "events",
        "conformance",
        ...target,
        "--tls-cert",
        certFile,
        "--tls-key",
        keyFile,
        "--event-args",
        "comment.created=" + args,
        "--trigger-tool",
        "reply_to_comment",
        "--trigger-args",
        JSON.stringify({ comment_id: "42", text: "hello" }),
      ]);
    const run = await conformance();
    assert.equal(run.exitCode, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.profile, "beta@c77b843");
    for (const id of [
      "events-capability-declared",
      "events-poll-null-cursor",
      "events-receiver-consent",
      "events-delivery-signature",
      "events-webhook-message-id",
      "events-unsubscribe-twice",
    ]) {
      assert.equal(
        report.checks.find((check: { id: string }) => check.id === id)?.status,
        "passed",
        id,
      );
    }
    const delivery = fixture.deliveries.find((entry) => entry.kind === "event");
    assert.equal(delivery?.status, 200);
    assert.ok(delivery?.url.startsWith("https://"));
    assert.notEqual(delivery.webhookId, JSON.parse(delivery.body).eventId);
    assert.equal(fixture.subscriptions().length, 0);

    fixture.misbehave({ reuseEventIdAsWebhookId: true });
    const invalid = await conformance();
    assert.equal(invalid.exitCode, 1, invalid.stderr);
    assert.match(invalid.stderr, /FAIL +MUST +events-webhook-message-id/);
    assert.equal(fixture.subscriptions().length, 0);
  } finally {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
