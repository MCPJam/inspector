/**
 * Harness credentials signed with the backend's RS256 key verify through its
 * published JWKS, and HS256 ones only while `HARNESS_PROXY_ACCEPT_HS256`
 * allows them, each counted. The header's algorithm picks the key before
 * anything is checked, so one algorithm can never be verified as the other.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetHarnessProxyJwksCacheForTests,
  verifyHarnessProxyToken,
  verifyHarnessSessionHandle,
} from "../harness-proxy-token.js";
import { logger } from "../../logger.js";
import {
  signTestProxyToken,
  signTestRs256Credential,
  testHarnessKey,
  testProxyTokenPayload,
} from "./sign-test-token.js";

const SECRET = "test-harness-proxy-secret-32-chars-min";
const key = testHarnessKey("harness-a");
const other = testHarnessKey("harness-b");

const HANDLE = {
  iss: "https://api.mcpjam.com/harness-mcp-proxy",
  purpose: "harness-mcp-session",
  sub: "u_convex",
  ext: "u_ext",
  org: "o1",
  projectId: "p1",
  serverId: "srv-a",
  lane: "lane-1",
  iat: 1_700_000_000,
};

let jwksFetches = 0;
beforeEach(() => {
  jwksFetches = 0;
  resetHarnessProxyJwksCacheForTests();
  vi.stubEnv("COMPUTERS_TERMINAL_TOKEN_SECRET", SECRET);
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("HARNESS_PROXY_ACCEPT_HS256", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(String(url)).toBe("https://backend.test/harness/mcp-proxy-jwks");
      jwksFetches += 1;
      return Response.json(key.jwks);
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function hs256(
  payload: Record<string, unknown>,
  header = { alg: "HS256", typ: "JWT" },
) {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", SECRET).update(input).digest("base64url")}`;
}

describe("RS256 credentials", () => {
  it("accepts a per-turn token verified against the JWKS", async () => {
    const token = signTestRs256Credential(
      testProxyTokenPayload({ serverId: "srv-a", projectId: "p1" }),
      key,
    );
    expect(await verifyHarnessProxyToken(token, "srv-a")).toEqual({
      userId: "user_convex_1",
      externalId: "user_ext_1",
      orgId: "org_1",
      projectId: "p1",
      serverId: "srv-a",
      alg: "RS256",
    });
    expect(await verifyHarnessProxyToken(token, "srv-b")).toBeNull();
    expect(jwksFetches).toBe(1);
  });

  it("accepts a session handle, which carries no exp on purpose", async () => {
    const handle = signTestRs256Credential({ ...HANDLE, acct: "conn-1" }, key);
    expect(await verifyHarnessSessionHandle(handle, "srv-a")).toEqual({
      userId: "u_convex",
      externalId: "u_ext",
      orgId: "o1",
      projectId: "p1",
      serverId: "srv-a",
      laneId: "lane-1",
      connectionId: "conn-1",
      alg: "RS256",
    });
  });

  it("still requires exp on a per-turn token", async () => {
    const { exp: _exp, ...payload } = testProxyTokenPayload({
      serverId: "srv-a",
    });
    expect(
      await verifyHarnessProxyToken(
        signTestRs256Credential(payload, key),
        "srv-a",
      ),
    ).toBeNull();
  });

  it("refuses a key the JWKS doesn't publish, and everything while it publishes none", async () => {
    const payload = testProxyTokenPayload({ serverId: "srv-a" });
    expect(
      await verifyHarnessProxyToken(
        signTestRs256Credential(payload, other),
        "srv-a",
      ),
    ).toBeNull();
    resetHarnessProxyJwksCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [] })),
    );
    expect(
      await verifyHarnessProxyToken(
        signTestRs256Credential(payload, key),
        "srv-a",
      ),
    ).toBeNull();
  });
});

describe("an algorithm that doesn't match its signature", () => {
  it("refuses an RS256 header over an HMAC signature, and the reverse", async () => {
    const payload = testProxyTokenPayload({ serverId: "srv-a" });
    expect(
      await verifyHarnessProxyToken(
        hs256(payload, { alg: "RS256", typ: "JWT", kid: "harness-a" } as never),
        "srv-a",
      ),
    ).toBeNull();
    expect(
      await verifyHarnessProxyToken(
        signTestRs256Credential(payload, key, { alg: "HS256", typ: "JWT" }),
        "srv-a",
      ),
    ).toBeNull();
  });

  it("refuses a header naming no algorithm it accepts, before any key is fetched", async () => {
    const payload = testProxyTokenPayload({ serverId: "srv-a" });
    for (const alg of ["none", "ES256", "HS512"])
      expect(
        await verifyHarnessProxyToken(
          hs256(payload, { alg, typ: "JWT" }),
          "srv-a",
        ),
      ).toBeNull();
    expect(jwksFetches).toBe(0);
  });
});

describe("HARNESS_PROXY_ACCEPT_HS256", () => {
  it("accepts HS256 by default and logs each one, with the lane for a handle", async () => {
    const events = vi.spyOn(logger, "systemEvent");
    expect(
      await verifyHarnessProxyToken(
        signTestProxyToken({ serverId: "srv-a" }),
        "srv-a",
      ),
    ).toMatchObject({ alg: "HS256" });
    expect(
      await verifyHarnessSessionHandle(hs256(HANDLE), "srv-a"),
    ).toMatchObject({
      alg: "HS256",
    });
    expect(
      events.mock.calls.map(([name, , payload]) => [name, payload]),
    ).toEqual([
      ["harness.hs256_credential_accepted", { credential: "proxy_token" }],
      [
        "harness.hs256_credential_accepted",
        { credential: "session_handle", laneId: "lane-1" },
      ],
    ]);
  });

  it("refuses HS256 at false and keeps accepting RS256", async () => {
    vi.stubEnv("HARNESS_PROXY_ACCEPT_HS256", "false");
    const events = vi.spyOn(logger, "systemEvent");
    expect(
      await verifyHarnessProxyToken(
        signTestProxyToken({ serverId: "srv-a" }),
        "srv-a",
      ),
    ).toBeNull();
    expect(await verifyHarnessSessionHandle(hs256(HANDLE), "srv-a")).toBeNull();
    expect(
      await verifyHarnessSessionHandle(
        signTestRs256Credential(HANDLE, key),
        "srv-a",
      ),
    ).toMatchObject({ alg: "RS256" });
    expect(events).not.toHaveBeenCalled();
  });
});
