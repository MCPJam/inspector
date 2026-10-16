/**
 * Events conformance against the official-SDK fixture: the conformant server
 * passes both profiles (MUST vs SHOULD kept apart), and each switchable fault
 * turns exactly the check that owns it red. A plain-http receiver is a
 * labelled override that can never produce a pass.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import {
  runEventsConformance,
  startEventsConformanceReceiver,
  type EventsConformanceReceiver,
  type EventsConformanceResult,
} from "../src/events-conformance/index.js";
import { CHATGPT_PROFILE_ID, DRAFT_PROFILE_ID } from "../src/events/profiles.js";
import { startEventsFixture, type EventsFixtureHandle } from "./support/events-fixture.js";
import { mintTestCertificate, trustingFetch } from "./support/events-tls.js";

const SERVER_ID = "events-conformance";
const opened: {
  fixtures: EventsFixtureHandle[];
  receivers: EventsConformanceReceiver[];
  managers: MCPClientManager[];
} = { fixtures: [], receivers: [], managers: [] };

afterEach(async () => {
  await Promise.all(opened.managers.map((m) => m.disconnectAllServers().catch(() => {})));
  await Promise.all(opened.fixtures.map((f) => f.close()));
  await Promise.all(opened.receivers.map((r) => r.close()));
  opened.fixtures = [];
  opened.receivers = [];
  opened.managers = [];
});

async function run(options: {
  fixture?: Parameters<typeof startEventsFixture>[0];
  profile?: typeof DRAFT_PROFILE_ID | typeof CHATGPT_PROFILE_ID;
  insecureReceiver?: boolean;
  protocolVersion?: "2025-11-25" | "2026-07-28";
}): Promise<{ result: EventsConformanceResult; fixture: EventsFixtureHandle }> {
  const certificate = mintTestCertificate();
  const fixture = await startEventsFixture({
    deliveryFetch: trustingFetch(certificate),
    heartbeatMs: 50,
    ...options.fixture,
  });
  opened.fixtures.push(fixture);
  const receiver = await startEventsConformanceReceiver(
    options.insecureReceiver ? {} : { tls: certificate }
  );
  opened.receivers.push(receiver);
  const manager = new MCPClientManager();
  opened.managers.push(manager);
  await manager.connectToServer(SERVER_ID, {
    url: fixture.url,
    timeout: 10_000,
    ...(options.protocolVersion ? { mcpProtocolVersion: options.protocolVersion as never } : {}),
  });
  const result = await runEventsConformance({
    manager,
    serverId: SERVER_ID,
    profile: options.profile ?? DRAFT_PROFILE_ID,
    receiver,
    eventArguments: { "comment.created": { document_id: "doc_c" } },
    triggerEvent: async (name, args) => {
      await fixture.emit(name, { ...args, comment_id: "c1", text: "conformance" });
    },
  });
  return { result, fixture };
}

const status = (result: EventsConformanceResult, id: string) =>
  result.checks.find((check) => check.id === id)?.status;

describe("events conformance", () => {
  it("passes the conformant fixture on the draft profile", async () => {
    const { result } = await run({});
    const notPassed = result.checks.filter((c) => c.status !== "passed");
    expect(notPassed).toEqual([
      expect.objectContaining({ id: "chatgpt-readiness-webhook-listed", status: "skipped" }),
      expect.objectContaining({ id: "chatgpt-readiness-protocol-version", status: "skipped" }),
    ]);
    expect(result.outcome).toBe("passed");
    expect(result.profile).toBe("draft@28ec35e");
  });

  it("passes the ChatGPT readiness profile on 2026-07-28", async () => {
    const { result } = await run({ profile: CHATGPT_PROFILE_ID, protocolVersion: "2026-07-28" });
    expect(status(result, "chatgpt-readiness-webhook-listed")).toBe("passed");
    expect(status(result, "chatgpt-readiness-protocol-version")).toBe("passed");
    expect(result.checks.find((c) => c.id === "events-delivery-body-size")?.strength).toBe("MUST");
    expect(result.outcome).toBe("passed");
  });

  it("fails ChatGPT readiness on a legacy-only connection", async () => {
    const { result } = await run({ profile: CHATGPT_PROFILE_ID, protocolVersion: "2025-11-25" });
    expect(status(result, "chatgpt-readiness-protocol-version")).toBe("failed");
  });

  it("fails the https MUST when the server accepts plain-http callbacks", async () => {
    const { result } = await run({ fixture: { allowInsecureCallbacks: true } });
    expect(status(result, "events-subscribe-rejects-http-callback")).toBe("failed");
    expect(result.outcome).toBe("failed");
  });

  it("fails the subscription-id header check when the server returns a wrong id", async () => {
    const { result } = await run({ fixture: { misbehavior: { wrongId: true } } });
    expect(status(result, "events-subscription-id-header")).toBe("failed");
  });

  it("detects forged signatures (the challenge itself fails verification)", async () => {
    const { result } = await run({ fixture: { misbehavior: { badSignature: true } } });
    expect(status(result, "events-subscribe-result-shape")).toBe("failed");
    expect(result.outcome).toBe("failed");
  });

  it("treats a server that skips the challenge as consent by another method, not a failure", async () => {
    const { result } = await run({ fixture: { misbehavior: { skipConsent: true } } });
    expect(result.checks.find((c) => c.id === "events-receiver-consent")).toMatchObject({
      status: "skipped",
      skipReason: "not-applicable",
    });
  });

  it("accepts NotFound on a second unsubscribe", async () => {
    const { result } = await run({});
    expect(result.checks.find((c) => c.id === "events-unsubscribe-twice")?.message).toMatch(
      /second already-gone/
    );
  });

  it("warns (SHOULD) rather than fails when the grant exceeds the request", async () => {
    const { result } = await run({ fixture: { minTtlMs: 3 * 60 * 60 * 1000, maxTtlMs: 4 * 60 * 60 * 1000 } });
    expect(result.checks.find((c) => c.id === "events-granted-lifetime")).toMatchObject({
      strength: "SHOULD",
      status: "warned",
    });
    expect(result.outcome).toBe("passed");
  });

  it("checks push heartbeats when selected", async () => {
    const certificate = mintTestCertificate();
    const fixture = await startEventsFixture({ deliveryFetch: trustingFetch(certificate), heartbeatMs: 50 });
    opened.fixtures.push(fixture);
    const manager = new MCPClientManager();
    opened.managers.push(manager);
    await manager.connectToServer(SERVER_ID, { url: fixture.url, timeout: 10_000 });
    const heartbeat = await runEventsConformance({
      manager,
      serverId: SERVER_ID,
      profile: DRAFT_PROFILE_ID,
      eventArguments: { "comment.created": { document_id: "doc_c" } },
      checkIds: ["events-push-heartbeat"],
      pushHeartbeatWaitMs: 2_000,
    });
    expect(heartbeat.checks).toEqual([
      expect.objectContaining({ id: "events-push-heartbeat", status: "passed", strength: "MUST" }),
    ]);
  });

  it("labels a plain-http receiver as an override that can never pass", async () => {
    const { result } = await run({ insecureReceiver: true, fixture: { allowInsecureCallbacks: true } });
    expect(result.overrides).toEqual(["insecure-local-receiver"]);
    expect(result.passed).toBe(false);
  });
});
