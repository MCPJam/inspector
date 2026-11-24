import { Hono } from "hono";
import { expect } from "vitest";
import {
  openSandboxClaim,
  sandboxDigest,
  sandboxSourceDigest,
  SANDBOX_VIEW_LEASE_MS,
} from "../../../services/sandbox-view-policy.js";
import { buildCSP, type SandboxCspMeta } from "../../../utils/sandbox-csp-policy.js";

export function webReceiptApp(routes: Hono, name: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("workosUserId", "actor");
    c.set("workosSessionId", "verified-receipt-session");
    await next();
  });
  return app.route(`/api/web/${name}`, routes);
}

export async function withReceiptSigning(run: () => Promise<void>) {
  const previous = process.env.SANDBOX_VIEW_SIGNING_SECRET;
  process.env.SANDBOX_VIEW_SIGNING_SECRET = "owned-receipt-test-secret-".repeat(3);
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SANDBOX_VIEW_SIGNING_SECRET;
    else process.env.SANDBOX_VIEW_SIGNING_SECRET = previous;
  }
}

export function expectOwnedSourceReceipt(
  content: { sourceReceipt: string; html: string; csp?: SandboxCspMeta },
  source: { serverId: string; resourceUri: string; toolCallId: string },
  projectId = "project",
) {
  const claim = openSandboxClaim(content.sourceReceipt);
  expect(claim).toEqual({
    kind: "source",
    version: 1,
    owner: sandboxDigest(JSON.stringify(["actor", "verified-receipt-session", null, projectId])),
    source: sandboxSourceDigest(source),
    html: sandboxDigest(content.html),
    policy: buildCSP(content.csp),
    issuedAt: expect.any(Number),
    expiresAt: expect.any(Number),
  });
  expect(claim.expiresAt - claim.issuedAt).toBe(SANDBOX_VIEW_LEASE_MS);
  expect(claim.expiresAt).toBeGreaterThan(Date.now());
}
