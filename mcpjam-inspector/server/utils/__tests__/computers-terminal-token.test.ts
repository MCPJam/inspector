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

  it("rejects unknown algs including none", async () => {
    const header = b64url(
      new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" }))
    );
    const payload = b64url(
      new TextEncoder().encode(JSON.stringify(baseClaims()))
    );
    expect(
      await verifyComputerTerminalToken(`${header}.${payload}.sig`)
    ).toBeNull();
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
    opts: { kid?: string; privateKey?: CryptoKey } = {}
  ): Promise<string> {
    const { exp, iat, iss, ...rest } = claims as Record<string, unknown> & {
      exp: number;
      iat: number;
      iss: string;
    };
    return new SignJWT(rest)
      .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
      .setIssuer(iss)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(opts.privateKey ?? (keys.privateKey as CryptoKey));
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

  it("forecloses alg-confusion: an HS256 token keyed on the public JWK bytes is rejected", async () => {
    // The classic RS256→HS256 downgrade: attacker HMACs with the public key
    // material. Our dispatch sends alg:HS256 to the shared-secret path only,
    // so this never meets the public key.
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
