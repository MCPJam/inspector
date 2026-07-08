import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyComputerTerminalToken } from "../computers/terminal-token";

// Local HS256 signer reproducing the mcpjam-backend mint
// (convex/lib/computerTerminalToken.ts) so verification is exercised against
// the exact claim contract without importing across repos.

const SECRET = "test-terminal-secret-0123456789";
const ISSUER = "https://api.mcpjam.com/computer-terminal";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sign(
  claims: Record<string, unknown>,
  secret = SECRET
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const header = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  );
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

function baseClaims(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    purpose: "computer-terminal",
    sub: "users_123",
    computerId: "computers_456",
    projectId: "projects_789",
    iat: now,
    exp: now + 60,
  };
}

beforeEach(() => {
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyComputerTerminalToken", () => {
  it("accepts a valid token and returns its claims", async () => {
    const token = await sign(baseClaims());
    expect(await verifyComputerTerminalToken(token)).toEqual({
      userId: "users_123",
      computerId: "computers_456",
      projectId: "projects_789",
    });
  });

  it("rejects an expired token", async () => {
    const claims = baseClaims();
    claims.exp = Math.floor(Date.now() / 1000) - 5;
    expect(await verifyComputerTerminalToken(await sign(claims))).toBeNull();
  });

  it("rejects a token AT its exp second (JWT NumericDate: expired at exp, not after)", async () => {
    const claims = baseClaims();
    claims.exp = Math.floor(Date.now() / 1000);
    expect(await verifyComputerTerminalToken(await sign(claims))).toBeNull();
  });

  it("rejects a missing/foreign purpose claim (other JWT populations)", async () => {
    const noPurpose = { ...baseClaims() };
    delete (noPurpose as { purpose?: unknown }).purpose;
    expect(await verifyComputerTerminalToken(await sign(noPurpose))).toBeNull();

    const wrongPurpose = { ...baseClaims(), purpose: "guest-promotion" };
    expect(
      await verifyComputerTerminalToken(await sign(wrongPurpose))
    ).toBeNull();
  });

  it("rejects a wrong issuer", async () => {
    const claims = { ...baseClaims(), iss: "https://evil.example" };
    expect(await verifyComputerTerminalToken(await sign(claims))).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await sign(baseClaims(), "a-completely-different-secret-xx");
    expect(await verifyComputerTerminalToken(token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await sign(baseClaims());
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.computerId = "computers_stolen";
    const forged = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    expect(await verifyComputerTerminalToken(`${h}.${forged}.${s}`)).toBeNull();
  });

  it("fails closed when the secret is unconfigured or weak", async () => {
    const token = await sign(baseClaims());
    vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "");
    expect(await verifyComputerTerminalToken(token)).toBeNull();
    vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", "short");
    expect(await verifyComputerTerminalToken(token)).toBeNull();
  });

  it("rejects malformed tokens without throwing", async () => {
    expect(await verifyComputerTerminalToken("")).toBeNull();
    expect(await verifyComputerTerminalToken("a.b")).toBeNull();
    expect(await verifyComputerTerminalToken("not!.b64.!!!")).toBeNull();
  });
});
