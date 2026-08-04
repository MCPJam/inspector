/**
 * Phase 7 §15.3 — the three `subscriptions/listen` MUST checks, driven for
 * real against a server that actually opens subscription streams.
 *
 * Each check is exercised twice: once against a CONFORMING stream (it must
 * pass, or the check is useless) and once against a stream that breaks
 * precisely that MUST (it must fail, and the other two must not be the ones
 * that fail — a check that cannot fail is not a check).
 *
 * The safety valve is asserted too: against a server with nothing subscribable
 * the three checks SKIP with a reason. A skip is safe; a false failure never
 * is.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
} from "../../src/mcp-conformance/index.js";
import {
  createMisbehavingSubscriptionHandler,
  createSubscriptionFixtureHandler,
  SUBSCRIPTION_FIXTURE_CLOSE_AFTER_MS,
} from "../support/subscription-fixture.js";

const MODERN = "2026-07-28" as const;

const SUBSCRIPTION_CHECK_IDS = [
  "modern-subscription-ack-precedes-notifications",
  "modern-subscription-filter-and-tagging",
  "modern-subscription-graceful-close",
] as const satisfies readonly MCPCheckId[];

const closers: Array<() => Promise<void>> = [];

async function serve(handler: McpHttpHandler): Promise<string> {
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const { port } = httpServer.address() as AddressInfo;
  closers.push(async () => {
    await handler.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  return `http://127.0.0.1:${port}/mcp`;
}

function byId(checks: MCPCheckResult[], id: MCPCheckId): MCPCheckResult {
  const found = checks.find((check) => check.id === id);
  if (!found) {
    throw new Error(`check ${id} not found in results`);
  }
  return found;
}

async function runSubscriptionChecks(
  serverUrl: string,
  protocolVersion: "2026-07-28" | "2025-11-25" = MODERN
) {
  return await new MCPConformanceTest({
    serverUrl,
    protocolVersion,
    checkIds: [...SUBSCRIPTION_CHECK_IDS],
    checkTimeout: 10_000,
  }).run();
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("subscription checks against a conforming listen stream", () => {
  it("proves ack-before-notification and per-message tagging on a live stream", async () => {
    const serverUrl = await serve(createSubscriptionFixtureHandler());
    const result = await runSubscriptionChecks(serverUrl);

    const ack = byId(
      result.checks,
      "modern-subscription-ack-precedes-notifications"
    );
    expect([ack.id, ack.status]).toEqual([ack.id, "passed"]);
    // The acknowledgement is the FIRST frame, and real notifications followed.
    expect(ack.details).toMatchObject({ ackIndex: 0 });
    expect(Number(ack.details?.notificationCount)).toBeGreaterThan(0);

    const filtering = byId(
      result.checks,
      "modern-subscription-filter-and-tagging"
    );
    expect([filtering.id, filtering.status]).toEqual([filtering.id, "passed"]);
    expect(filtering.details).toMatchObject({ untaggedMessages: [] });
    expect(filtering.details?.notificationMethods).toContain(
      "notifications/tools/list_changed"
    );

    // Nothing closed this subscription, so the graceful-close MUST was never
    // exercised: a skip, never a failure.
    const graceful = byId(result.checks, "modern-subscription-graceful-close");
    expect([graceful.id, graceful.status]).toEqual([graceful.id, "skipped"]);
    expect(graceful.error?.message).toMatch(/still open/);
    // A skip, never a failure — but also never a pass: the MUST went
    // unexercised, so the run is `incomplete`.
    expect(graceful.skipReason).toBe("could-not-run");
    expect(result.outcome).toBe("incomplete");
  });

  it("proves the graceful close returns the completion result", async () => {
    const serverUrl = await serve(
      createSubscriptionFixtureHandler({
        gracefulCloseAfterMs: SUBSCRIPTION_FIXTURE_CLOSE_AFTER_MS,
      })
    );
    const result = await runSubscriptionChecks(serverUrl);

    for (const id of SUBSCRIPTION_CHECK_IDS) {
      expect([id, byId(result.checks, id).status]).toEqual([id, "passed"]);
    }
    const graceful = byId(result.checks, "modern-subscription-graceful-close");
    expect(graceful.details).toMatchObject({
      streamOutcome: "completed",
      completionResult: { resultType: "complete" },
    });
    expect(result.passed).toBe(true);
  });
});

describe("subscription checks against streams that break one MUST each", () => {
  it("fails the ordering check when a notification precedes the acknowledgement", async () => {
    const serverUrl = await serve(
      createMisbehavingSubscriptionHandler("notification-before-ack")
    );
    const result = await runSubscriptionChecks(serverUrl);

    const ack = byId(
      result.checks,
      "modern-subscription-ack-precedes-notifications"
    );
    expect(ack.status).toBe("failed");
    expect(ack.error?.message).toMatch(
      /before notifications\/subscriptions\/acknowledged/
    );
    expect(ack.details).toMatchObject({
      ackIndex: 1,
      firstNotificationIndex: 0,
    });
    // The tagging MUST is untouched by the ordering violation.
    expect(
      byId(result.checks, "modern-subscription-filter-and-tagging").status
    ).toBe("passed");
    expect(result.passed).toBe(false);
  });

  it("fails the filtering check when the stream carries an unrequested type", async () => {
    const serverUrl = await serve(
      createMisbehavingSubscriptionHandler("unrequested-type")
    );
    const result = await runSubscriptionChecks(serverUrl);

    const filtering = byId(
      result.checks,
      "modern-subscription-filter-and-tagging"
    );
    expect(filtering.status).toBe("failed");
    expect(filtering.error?.message).toMatch(/never requested/);
    expect(
      byId(result.checks, "modern-subscription-ack-precedes-notifications")
        .status
    ).toBe("passed");
    expect(result.passed).toBe(false);
  });

  it("fails the tagging check when messages carry no subscription id", async () => {
    const serverUrl = await serve(
      createMisbehavingSubscriptionHandler("untagged")
    );
    const result = await runSubscriptionChecks(serverUrl);

    const filtering = byId(
      result.checks,
      "modern-subscription-filter-and-tagging"
    );
    expect(filtering.status).toBe("failed");
    expect(filtering.error?.message).toMatch(
      /not tagged with the subscription id/
    );
    expect(
      (filtering.details?.untaggedMessages as unknown[]).length
    ).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it("fails the graceful-close check when the stream ends without the completion result", async () => {
    const serverUrl = await serve(
      createMisbehavingSubscriptionHandler("close-without-completion")
    );
    const result = await runSubscriptionChecks(serverUrl);

    const graceful = byId(result.checks, "modern-subscription-graceful-close");
    expect(graceful.status).toBe("failed");
    expect(graceful.error?.message).toMatch(
      /without returning the completion result/
    );
    expect(graceful.details).toMatchObject({ streamOutcome: "stream-ended" });
    expect(result.passed).toBe(false);
  });
});

describe("subscription checks when no stream can be observed", () => {
  it("skips (never fails) against a server that advertises nothing subscribable", async () => {
    const serverUrl = await serve(
      createSubscriptionFixtureHandler({
        capabilities: {
          toolsListChanged: false,
          promptsListChanged: false,
          resourcesListChanged: false,
          resourcesSubscribe: false,
        },
      })
    );
    const result = await runSubscriptionChecks(serverUrl);

    for (const id of SUBSCRIPTION_CHECK_IDS) {
      const check = byId(result.checks, id);
      expect([id, check.status]).toEqual([id, "skipped"]);
      expect(check.error?.message).toMatch(/no subscribable notification type/);
    }
    expect(result.passed).toBe(true);
  });

  it("era-skips on a legacy pin without opening any stream", async () => {
    const serverUrl = await serve(createSubscriptionFixtureHandler());
    const result = await runSubscriptionChecks(serverUrl, "2025-11-25");

    for (const id of SUBSCRIPTION_CHECK_IDS) {
      const check = byId(result.checks, id);
      expect([id, check.status]).toEqual([id, "skipped"]);
      expect(check.error?.message).toMatch(/Not applicable to the legacy era/);
    }
    expect(result.passed).toBe(true);
  });
});
