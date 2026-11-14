/**
 * `mcpjam events conformance` against the official-server events fixture,
 * with the webhook checks delivering to a real HTTPS receiver (a throwaway
 * cert the fixture's delivery `fetch` trusts).
 *
 * The fixture has no tool that emits an event, so the spawned CLI run cannot
 * trigger a delivery: it must come out `incomplete` (exit 3), never `passed`.
 * The full pass is driven through the command's own runner seam with a
 * trigger that calls `fixture.emit`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MCPClientManager } from "@mcpjam/sdk";
import { startEventsFixture } from "../../sdk/tests/support/events-fixture.js";
import {
  mintTestCertificate,
  trustingFetch,
} from "../../sdk/tests/support/events-tls.js";
import {
  planConformanceReceiver,
  renderEventsConformanceTable,
  runEventsConformanceForCli,
} from "../src/lib/events-conformance.js";
import { errorOf, httpTarget, jsonOf, runCli } from "./support/task-cli-harness.js";

const DELIVERY_CHECKS = [
  "events-delivery-signature",
  "events-webhook-id-equals-event-id",
  "events-subscription-id-header",
  "events-delivery-content-type",
  "events-delivery-body-size",
];

function writeCertificate(): { dir: string; cert: string; key: string } {
  const certificate = mintTestCertificate();
  const dir = mkdtempSync(path.join(tmpdir(), "mcpjam-events-conformance-"));
  const cert = path.join(dir, "cert.pem");
  const key = path.join(dir, "key.pem");
  writeFileSync(cert, certificate.cert);
  writeFileSync(key, certificate.key, { mode: 0o600 });
  return { dir, cert, key };
}

test("events conformance without a trigger is incomplete (exit 3), never a pass", async () => {
  const files = writeCertificate();
  const fixture = await startEventsFixture({
    deliveryFetch: trustingFetch(mintTestCertificate()),
  });
  try {
    const run = await runCli([
      "events",
      "conformance",
      "--event-args",
      'comment.created={"document_id":"doc_c"}',
      "--tls-cert",
      files.cert,
      "--tls-key",
      files.key,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 3, run.stderr);
    const result = jsonOf(run) as {
      profile: string;
      outcome: string;
      passed: boolean;
      overrides: string[];
      checks: Array<{ id: string; status: string; skipReason?: string; strength: string }>;
    };
    assert.equal(result.profile, "draft@28ec35e");
    assert.equal(result.outcome, "incomplete");
    assert.equal(result.passed, false);
    assert.deepEqual(result.overrides, []);
    const byId = new Map(result.checks.map((check) => [check.id, check]));
    for (const id of DELIVERY_CHECKS) {
      assert.equal(byId.get(id)?.status, "skipped", id);
      assert.equal(byId.get(id)?.skipReason, "could-not-run", id);
    }
    for (const id of [
      "events-capability-declared",
      "events-list-shape",
      "events-poll-null-cursor",
      "events-subscribe-rejects-http-callback",
      "events-receiver-consent",
      "events-unsubscribe-twice",
    ]) {
      assert.equal(byId.get(id)?.status, "passed", id);
    }
    // Every subscription the run established was removed. (The fixture keeps
    // the two probes whose challenge it refused on purpose — consent failure
    // and redirect — as never-verified entries; those never delivered.)
    assert.deepEqual(
      fixture.subscriptions().filter((entry) => entry.verified),
      [],
    );

    assert.match(run.stderr, /MCP Events conformance — profile draft@28ec35e/);
    assert.match(run.stderr, /SKIP +MUST +events-delivery-signature/);
    assert.match(run.stderr, /Outcome: incomplete/);
    assert.doesNotMatch(run.stdout, /whsec_[A-Za-z0-9+/]{8}/);
    assert.doesNotMatch(run.stderr, /whsec_[A-Za-z0-9+/]{8}/);
  } finally {
    await fixture.close();
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("events conformance passes the conformant fixture when a trigger causes a delivery", async () => {
  const files = writeCertificate();
  const fixture = await startEventsFixture({
    deliveryFetch: trustingFetch(mintTestCertificate()),
  });
  const manager = new MCPClientManager();
  try {
    await manager.connectToServer("events-conformance", { url: fixture.url, timeout: 10_000 });
    const statuses: string[] = [];
    const result = await runEventsConformanceForCli({
      manager,
      serverId: "events-conformance",
      profile: "draft@28ec35e",
      receiverPlan: planConformanceReceiver({ tlsCert: files.cert, tlsKey: files.key }),
      eventArguments: { "comment.created": { document_id: "doc_c" } },
      triggerEvent: async (name, args) => {
        await fixture.emit(name, { ...args, comment_id: "c1", text: "conformance" });
      },
      status: (message) => statuses.push(message),
    });
    assert.equal(result.outcome, "passed", renderEventsConformanceTable(result));
    assert.equal(result.passed, true);
    for (const id of DELIVERY_CHECKS) {
      assert.equal(
        result.checks.find((check) => check.id === id)?.status,
        "passed",
        id,
      );
    }
    assert.match(statuses[0]!, /callback origin https:\/\/127\.0\.0\.1:/);
    const table = renderEventsConformanceTable(result);
    assert.match(table, /PASS +MUST +events-delivery-signature/);
    assert.match(table, /Outcome: passed/);
    assert.doesNotMatch(table, /FAIL/);
  } finally {
    await manager.disconnectAllServers().catch(() => {});
    await fixture.close();
    rmSync(files.dir, { recursive: true, force: true });
  }
});

test("events conformance labels a plain-http receiver as an override that cannot pass", async () => {
  const fixture = await startEventsFixture({ allowInsecureCallbacks: true });
  try {
    const run = await runCli([
      "events",
      "conformance",
      "--event-args",
      'comment.created={"document_id":"doc_c"}',
      "--insecure-local-receiver",
      "--checks",
      "events-capability-declared,events-receiver-consent",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 3, run.stderr);
    const result = jsonOf(run) as {
      outcome: string;
      overrides: string[];
      checks: Array<{ id: string }>;
    };
    assert.equal(result.outcome, "incomplete");
    assert.deepEqual(result.overrides, ["insecure-local-receiver"]);
    assert.deepEqual(
      result.checks.map((check) => check.id),
      ["events-capability-declared", "events-receiver-consent"],
    );
    assert.match(run.stderr, /NON-CONFORMANT/);
  } finally {
    await fixture.close();
  }
});

test("events conformance rejects unknown check ids and a lone --tls-cert", async () => {
  const unknown = await runCli([
    "events",
    "conformance",
    "--checks",
    "events-nope",
    ...httpTarget("http://127.0.0.1:9/mcp"),
  ]);
  assert.equal(unknown.exitCode, 2, unknown.stderr);
  assert.match(errorOf(unknown).message, /Unknown check id: events-nope/);

  const lone = await runCli([
    "events",
    "conformance",
    "--tls-cert",
    "/nonexistent.pem",
    ...httpTarget("http://127.0.0.1:9/mcp"),
  ]);
  assert.equal(lone.exitCode, 2, lone.stderr);
  assert.match(errorOf(lone).message, /--tls-cert and --tls-key must be passed together/);
});
