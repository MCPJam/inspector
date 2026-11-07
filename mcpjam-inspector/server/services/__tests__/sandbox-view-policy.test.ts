import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSessionToken } from "../session-token.js";
import {
  issueSandboxSourceReceipt,
  openSandboxClaim,
  prepareSandboxViewSchema,
  resolveSandboxViewPolicy,
  sandboxDigest,
  SANDBOX_VIEW_LEASE_MS,
} from "../sandbox-view-policy.js";

const owner = sandboxDigest("owner");
const source = {
  serverId: "server",
  resourceUri: "ui://view",
  toolCallId: "call",
};
const html = "<!doctype html><p>view</p>";
const request = () =>
  prepareSandboxViewSchema.parse({
    viewInstanceId: "639f5fd0-f977-4813-b90f-d57cf2bf7c46",
    source,
    html,
    mode: "declared",
    hostOrigin: "http://localhost:6274",
    policy: {
      csp: { connectDomains: ["https://other.example"] },
      permissive: false,
    },
  });

describe("App source receipts and HTTP policy", () => {
  beforeEach(() => {
    generateSessionToken();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("encrypts receipt metadata and binds exact bytes, owner and source", () => {
    const receipt = issueSandboxSourceReceipt(owner, source, html, {
      connectDomains: ["https://declared.example"],
    });
    expect(receipt).not.toContain("declared.example");
    expect(openSandboxClaim(receipt)).toMatchObject({
      kind: "source",
      owner,
      html: sandboxDigest(html),
    });
    const input = { ...request(), sourceReceipt: receipt };
    expect(resolveSandboxViewPolicy(input, owner)).toContain(
      "connect-src https://declared.example",
    );
    expect(() =>
      resolveSandboxViewPolicy({ ...input, html: html + "changed" }, owner),
    ).toThrow("no longer matches");
    expect(() =>
      resolveSandboxViewPolicy(
        { ...input, source: { ...source, toolCallId: "other" } },
        owner,
      ),
    ).toThrow("no longer matches");
    expect(() =>
      resolveSandboxViewPolicy(input, sandboxDigest("other-owner")),
    ).toThrow("no longer matches");
    expect(() =>
      openSandboxClaim(
        receipt.slice(0, -1) + (receipt.endsWith("A") ? "B" : "A"),
      ),
    ).toThrow("Invalid App");
  });

  it("keeps undeclared views restrictive and intersects host policy with the receipt", () => {
    const input = request();
    const policy = resolveSandboxViewPolicy(input, owner);
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain(", default-src");
    expect(() =>
      resolveSandboxViewPolicy(
        { ...input, policy: { permissive: true } },
        owner,
      ),
    ).toThrow("cannot request permissive");
    expect(
      resolveSandboxViewPolicy(
        { ...input, mode: "debugger", policy: { permissive: true } },
        owner,
      ),
    ).toContain("connect-src *");
  });

  it("refuses expired receipts for a new admission", () => {
    vi.useFakeTimers();
    const receipt = issueSandboxSourceReceipt(owner, source, html, {});
    vi.advanceTimersByTime(SANDBOX_VIEW_LEASE_MS + 1);
    expect(() =>
      resolveSandboxViewPolicy({ ...request(), sourceReceipt: receipt }, owner),
    ).toThrow("no longer matches");
  });

  it("rejects malformed domain tokens while preserving wildcard and scheme sources", () => {
    for (const domain of [
      "https://one.example https://two.example",
      "https://one.example; connect-src *",
      "'self'",
      "https://user@host.example",
      "https://host.example?query=1",
    ]) {
      expect(() =>
        issueSandboxSourceReceipt(owner, source, html, {
          connectDomains: [domain],
        }),
      ).toThrow();
    }
    for (const domain of [
      "https://*.example.com",
      "https://host.example:*",
      "https:",
      "wss:",
      "*.example.com",
      "*",
      "http://[::1]:6274",
    ]) {
      expect(() =>
        issueSandboxSourceReceipt(owner, source, html, {
          connectDomains: [domain],
        }),
      ).not.toThrow();
    }
  });

  it("normalizes supported whitespace and internationalized sources identically for receipts and headers", () => {
    const csp = { connectDomains: [" https://bücher.example/部品 "], resourceDomains: ["https://例え.example"] };
    const receipt = issueSandboxSourceReceipt(owner, source, html, csp);
    const parsed = prepareSandboxViewSchema.parse({ ...request(), sourceReceipt: receipt, policy: { csp, permissive: false } });
    const policy = resolveSandboxViewPolicy(parsed, owner);
    expect(openSandboxClaim(receipt).policy).toContain("https://xn--bcher-kva.example/%E9%83%A8%E5%93%81");
    expect(policy).toBe(openSandboxClaim(receipt).policy);
    expect(policy).not.toMatch(/[^\x20-\x7e]/);
  });

  it("rejects header control characters and oversized policy declarations", () => {
    expect(() =>
      prepareSandboxViewSchema.parse({
        ...request(),
        policy: {
          permissive: false,
          csp: {
            connectDomains: ["https://allowed.example\r\nX-Injected: true"],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      issueSandboxSourceReceipt(owner, source, html, {
        resourceDomains: Array.from(
          { length: 129 },
          () => "https://asset.example",
        ),
      }),
    ).toThrow();
  });
});
