import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  verifyComputerTerminalToken,
  resetComputerTerminalJwksCacheForTests,
} from "../computers/terminal-token";

// A local HS256 signer (the retired mint mode) — kept only to prove such
// tokens are now REJECTED, and to build the alg-confusion probe below.

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyComputerTerminalToken (alg gate)", () => {
  it("rejects a well-formed HS256 token (RS256 only) before any network call", async () => {
    // Even a validly-signed HS256 token in the retired shared-secret scheme
    // is refused — mint is RS256-only now.
    const token = await sign(baseClaims());
    expect(await verifyComputerTerminalToken(token)).toBeNull();
  });

  it("rejects alg:none and malformed tokens without throwing", async () => {
    const header = b64url(
      new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" }))
    );
    const payload = b64url(
      new TextEncoder().encode(JSON.stringify(baseClaims()))
    );
    expect(
      await verifyComputerTerminalToken(`${header}.${payload}.sig`)
    ).toBeNull();
    expect(await verifyComputerTerminalToken("")).toBeNull();
    expect(await verifyComputerTerminalToken("a.b")).toBeNull();
    expect(await verifyComputerTerminalToken("not!.b64.!!!")).toBeNull();
  });
});

describe("verifyComputerTerminalToken (RS256 via JWKS)", () => {
  const KID = "computer-terminal-1";
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwksDoc: unknown;
  let fetchCalls: string[];
  let jwksResponse: () => Response | Promise<Response>;

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    otherKeys = await generateKeyPair("RS256");
    const jwk = await exportJWK(keys.publicKey);
    jwksDoc = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
  });

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.test");
    resetComputerTerminalJwksCacheForTests();
    fetchCalls = [];
    jwksResponse = () =>
      new Response(JSON.stringify(jwksDoc), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        fetchCalls.push(String(url));
        return jwksResponse();
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetComputerTerminalJwksCacheForTests();
  });

  async function signRs256(
    claims: Record<string, unknown>,
    opts: { kid?: string; privateKey?: CryptoKey; omitExp?: boolean } = {}
  ): Promise<string> {
    const { exp, iat, iss, ...rest } = claims as Record<string, unknown> & {
      exp: number;
      iat: number;
      iss: string;
    };
    const jwt = new SignJWT(rest)
      .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
      .setIssuer(iss)
      .setIssuedAt(iat);
    if (!opts.omitExp) jwt.setExpirationTime(exp);
    return jwt.sign(opts.privateKey ?? (keys.privateKey as CryptoKey));
  }

  it("accepts a backend-minted RS256 token against the published JWKS", async () => {
    const token = await signRs256(baseClaims());
    expect(await verifyComputerTerminalToken(token)).toEqual({
      userId: "users_123",
      computerId: "computers_456",
      projectId: "projects_789",
    });
    expect(fetchCalls).toEqual([
      "https://convex.example.test/computers/terminal-jwks",
    ]);
    // Second verify uses the cached JWKS — no refetch.
    expect(
      await verifyComputerTerminalToken(await signRs256(baseClaims()))
    ).not.toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });

  it("rejects an RS256 token signed by a different key (unknown kid or wrong key)", async () => {
    const wrongKey = await signRs256(baseClaims(), {
      privateKey: otherKeys.privateKey as CryptoKey,
    });
    expect(await verifyComputerTerminalToken(wrongKey)).toBeNull();
    const unknownKid = await signRs256(baseClaims(), { kid: "rogue-kid" });
    expect(await verifyComputerTerminalToken(unknownKid)).toBeNull();
  });

  it("rejects an expired RS256 token and a foreign purpose", async () => {
    const expired = {
      ...baseClaims(),
      exp: Math.floor(Date.now() / 1000) - 5,
    };
    expect(await verifyComputerTerminalToken(await signRs256(expired))).toBeNull();
    const wrongPurpose = { ...baseClaims(), purpose: "guest-promotion" };
    expect(
      await verifyComputerTerminalToken(await signRs256(wrongPurpose))
    ).toBeNull();
  });

  it("rejects an RS256 token that carries no exp", async () => {
    // jose rejects an expired exp but does not require one to be present; the
    // verifier must (requiredClaims), or tokens would verify as never-expiring.
    const token = await signRs256(baseClaims(), { omitExp: true });
    expect(await verifyComputerTerminalToken(token)).toBeNull();
  });

  it("collapses a burst of concurrent cold-cache verifies onto one JWKS fetch", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => signRs256(baseClaims()))
    );
    const results = await Promise.all(
      tokens.map((t) => verifyComputerTerminalToken(t))
    );
    expect(results.every((r) => r !== null)).toBe(true);
    // Without in-flight memoization this would be 5 fetches.
    expect(fetchCalls).toHaveLength(1);
  });

  it("forecloses alg-confusion: an HS256 token keyed on the public JWK bytes is rejected", async () => {
    // The classic RS256→HS256 downgrade: attacker HMACs with the public key
    // material. The verifier rejects any non-RS256 alg outright, so this never
    // reaches signature verification.
    const publicJwkBytes = JSON.stringify(await exportJWK(keys.publicKey));
    const token = await sign(baseClaims(), publicJwkBytes);
    expect(await verifyComputerTerminalToken(token)).toBeNull();
  });

  it("fails closed when the JWKS is unreachable, empty, or CONVEX_HTTP_URL is unset", async () => {
    jwksResponse = () => {
      throw new TypeError("fetch failed");
    };
    const token = await signRs256(baseClaims());
    expect(await verifyComputerTerminalToken(token)).toBeNull();

    resetComputerTerminalJwksCacheForTests();
    jwksResponse = () =>
      new Response(JSON.stringify({ keys: [] }), { status: 200 });
    expect(await verifyComputerTerminalToken(token)).toBeNull();

    vi.stubEnv("CONVEX_HTTP_URL", "");
    resetComputerTerminalJwksCacheForTests();
    expect(await verifyComputerTerminalToken(token)).toBeNull();
  });

  it("remembers a failed JWKS fetch briefly instead of hammering Convex", async () => {
    jwksResponse = () => new Response("nope", { status: 500 });
    const token = await signRs256(baseClaims());
    expect(await verifyComputerTerminalToken(token)).toBeNull();
    expect(await verifyComputerTerminalToken(token)).toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });
});
