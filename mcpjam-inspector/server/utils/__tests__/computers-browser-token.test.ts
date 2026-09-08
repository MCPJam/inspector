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
  verifyComputerBrowserToken,
  resetComputerBrowserJwksCacheForTests,
} from "../computers/browser-token";

const ISSUER = "https://api.mcpjam.com/computer-browser";
const KID = "computer-browser-1";

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function baseClaims(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    purpose: "computer-browser",
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

describe("verifyComputerBrowserToken (alg gate)", () => {
  it("rejects alg:none, HS256 and malformed tokens without throwing", async () => {
    // The alg check runs before any network call: `none` and HS256 must never
    // reach a verifier holding public key material.
    for (const alg of ["none", "HS256"]) {
      const header = b64url(
        new TextEncoder().encode(JSON.stringify({ alg, typ: "JWT" })),
      );
      const payload = b64url(
        new TextEncoder().encode(JSON.stringify(baseClaims())),
      );
      expect(
        await verifyComputerBrowserToken(`${header}.${payload}.sig`),
      ).toBeNull();
    }
    expect(await verifyComputerBrowserToken("")).toBeNull();
    expect(await verifyComputerBrowserToken("a.b")).toBeNull();
    expect(await verifyComputerBrowserToken("not!.b64.!!!")).toBeNull();
  });
});

describe("verifyComputerBrowserToken (RS256 via JWKS)", () => {
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
    resetComputerBrowserJwksCacheForTests();
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
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetComputerBrowserJwksCacheForTests();
  });

  async function signRs256(
    claims: Record<string, unknown>,
    opts: { kid?: string; privateKey?: CryptoKey; omitExp?: boolean } = {},
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
    expect(await verifyComputerBrowserToken(token)).toEqual({
      userId: "users_123",
      computerId: "computers_456",
      projectId: "projects_789",
    });
    expect(fetchCalls).toEqual([
      "https://convex.example.test/computers/browser-jwks",
    ]);
    // Second verify uses the cached JWKS — no refetch.
    expect(
      await verifyComputerBrowserToken(await signRs256(baseClaims())),
    ).not.toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });

  it("REJECTS a terminal token replayed at the browser surface", async () => {
    // The sharpest cross-surface risk: same signing infrastructure, same row
    // ids, different screen. A terminal token opening a live desktop view
    // would hand its holder something they were never granted. Both the issuer
    // and the purpose claim have to stop it, so check them independently.
    const terminalIssuer = await signRs256({
      ...baseClaims(),
      iss: "https://api.mcpjam.com/computer-terminal",
    });
    expect(await verifyComputerBrowserToken(terminalIssuer)).toBeNull();

    const terminalPurpose = await signRs256({
      ...baseClaims(),
      purpose: "computer-terminal",
    });
    expect(await verifyComputerBrowserToken(terminalPurpose)).toBeNull();
  });

  it("rejects an RS256 token signed by a different key or an unknown kid", async () => {
    const wrongKey = await signRs256(baseClaims(), {
      privateKey: otherKeys.privateKey as CryptoKey,
    });
    expect(await verifyComputerBrowserToken(wrongKey)).toBeNull();
    const unknownKid = await signRs256(baseClaims(), { kid: "rogue-kid" });
    expect(await verifyComputerBrowserToken(unknownKid)).toBeNull();
  });

  it("rejects an expired token, and one carrying no exp at all", async () => {
    const expired = { ...baseClaims(), exp: Math.floor(Date.now() / 1000) - 5 };
    expect(await verifyComputerBrowserToken(await signRs256(expired))).toBeNull();
    // jose rejects an expired exp but does not require one to be PRESENT; the
    // verifier must, or a token minted without one is a permanent key to a
    // live desktop.
    const noExp = await signRs256(baseClaims(), { omitExp: true });
    expect(await verifyComputerBrowserToken(noExp)).toBeNull();
  });

  it("rejects tokens missing any of the row-id claims", async () => {
    for (const drop of ["sub", "computerId", "projectId"]) {
      const claims = { ...baseClaims() };
      delete claims[drop];
      expect(await verifyComputerBrowserToken(await signRs256(claims))).toBeNull();
      const emptied = { ...baseClaims(), [drop]: "" };
      expect(await verifyComputerBrowserToken(await signRs256(emptied))).toBeNull();
    }
  });

  it("collapses a burst of concurrent cold-cache verifies onto one JWKS fetch", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => signRs256(baseClaims())),
    );
    const results = await Promise.all(
      tokens.map((t) => verifyComputerBrowserToken(t)),
    );
    expect(results.every((r) => r !== null)).toBe(true);
    expect(fetchCalls).toHaveLength(1);
  });

  it("fails closed when CONVEX_HTTP_URL is unset or the JWKS is unusable", async () => {
    const token = await signRs256(baseClaims());

    vi.stubEnv("CONVEX_HTTP_URL", "");
    expect(await verifyComputerBrowserToken(token)).toBeNull();
    expect(fetchCalls).toHaveLength(0);

    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example.test");
    resetComputerBrowserJwksCacheForTests();
    jwksResponse = () => new Response("nope", { status: 500 });
    expect(await verifyComputerBrowserToken(token)).toBeNull();

    resetComputerBrowserJwksCacheForTests();
    jwksResponse = () =>
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    expect(await verifyComputerBrowserToken(token)).toBeNull();

    resetComputerBrowserJwksCacheForTests();
    jwksResponse = () => {
      throw new Error("network down");
    };
    expect(await verifyComputerBrowserToken(token)).toBeNull();
  });

  it("remembers a failed fetch briefly instead of hammering Convex", async () => {
    const token = await signRs256(baseClaims());
    jwksResponse = () => new Response("nope", { status: 500 });
    expect(await verifyComputerBrowserToken(token)).toBeNull();
    expect(await verifyComputerBrowserToken(token)).toBeNull();
    expect(fetchCalls).toHaveLength(1);
  });
});
