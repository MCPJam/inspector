/**
 * OAuth profile catalog resolution (HP-43 step 3).
 */
import {
  fetchOAuthProfile,
  fetchOAuthProfileCatalog,
} from "../../src/oauth/emulation/profile-fetch.js";
import {
  computeOAuthProfileDigest,
  SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION,
} from "../../src/oauth/emulation/profile-catalog.js";
import { deriveOAuthEmulation } from "../../src/oauth/emulation/derive.js";
import type { HostConfigOAuthProfile } from "../../src/host-config/internal";
import { verified } from "../support/oauth-profiles.js";

const BASE_URL = "https://api.example.test/v1";

const PROFILE: HostConfigOAuthProfile = {
  profileVersion: 2,
  authModel: verified(["oauth2-dcr"]),
  sendsResourceIndicator: verified(false),
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function envelope(
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return {
    schemaVersion: SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION,
    catalogRevision: "2026-08-04T00:00:00Z",
    clientId: "example-desktop",
    clientVersion: "1.2.3",
    profileDigest: await computeOAuthProfileDigest(PROFILE),
    profile: PROFILE,
    ...overrides,
  };
}

describe("fetchOAuthProfile — success", () => {
  it("returns a canonicalized profile ready to compile", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(200, await envelope())
    ) as unknown as typeof fetch;

    const result = await fetchOAuthProfile("example-desktop", {
      baseUrl: BASE_URL,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clientId).toBe("example-desktop");
    expect(result.clientVersion).toBe("1.2.3");
    expect(result.catalogRevision).toBe("2026-08-04T00:00:00Z");
    // The resolved profile drives the engine with no further ceremony.
    expect(deriveOAuthEmulation(result.profile).authAttempts).toEqual([
      { kind: "oauth", registrationPreference: ["dcr"] },
    ]);
  });

  it("sends the bearer token and path-encodes the client id", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, await envelope({ clientId: "a/b" }));
    }) as unknown as typeof fetch;

    await fetchOAuthProfile("a/b", {
      baseUrl: BASE_URL,
      authToken: "tok-123",
      fetchImpl,
    });

    // Encoded, so a crafted id cannot reach a different route.
    expect(calls[0][0]).toBe(`${BASE_URL}/oauth-profiles/a%2Fb`);
    expect(
      (calls[0][1]?.headers as Record<string, string>).authorization
    ).toBe("Bearer tok-123");
  });
});

describe("fetchOAuthProfile — verification, not trust", () => {
  it("rejects a profile whose bytes do not hash to the asserted digest", async () => {
    // The digest gates the golden comparator's binding check. Trusting an
    // asserted one would let a capture of one client be diffed against a run
    // of another and reported as a confident match.
    const fetchImpl = (async () =>
      jsonResponse(
        200,
        await envelope({ profileDigest: "0000deadbeef" })
      )) as unknown as typeof fetch;

    const result = await fetchOAuthProfile("example-desktop", {
      baseUrl: BASE_URL,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: "digest_mismatch" });
    if (result.ok) return;
    expect(result.detail).toMatch(/0000deadbeef/);
  });

  it("rejects a profile that would not survive canonicalization", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        200,
        await envelope({
          profile: {
            profileVersion: 2,
            // Unverifiable evidence may not carry a value.
            authModel: {
              status: "unverifiable",
              reason: "closed",
              value: ["none"],
            },
          },
        })
      )) as unknown as typeof fetch;

    const result = await fetchOAuthProfile("example-desktop", {
      baseUrl: BASE_URL,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    if (result.ok) return;
    expect(result.detail).toMatch(/value must be omitted/);
  });

  it("refuses a newer catalog schema instead of partially interpreting it", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        200,
        await envelope({ schemaVersion: SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION + 1 })
      )) as unknown as typeof fetch;

    const result = await fetchOAuthProfile("example-desktop", {
      baseUrl: BASE_URL,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    if (result.ok) return;
    expect(result.detail).toMatch(/schema version/);
  });
});

describe("fetchOAuthProfile — failures never throw and never fall back", () => {
  const cases: Array<[string, () => Promise<Response>, string]> = [
    ["a 404", async () => jsonResponse(404, {}), "not_found"],
    ["a 401", async () => jsonResponse(401, {}), "unauthorized"],
    ["a 403", async () => jsonResponse(403, {}), "unauthorized"],
    ["a 503", async () => jsonResponse(503, {}), "unavailable"],
    [
      "a non-JSON body",
      async () => new Response("not json", { status: 200 }),
      "invalid",
    ],
  ];

  for (const [label, respond, reason] of cases) {
    it(`maps ${label} to ${reason}`, async () => {
      const result = await fetchOAuthProfile("x", {
        baseUrl: BASE_URL,
        fetchImpl: respond as unknown as typeof fetch,
      });
      expect(result).toMatchObject({ ok: false, reason });
    });
  }

  it("maps a thrown transport error to network, without throwing", async () => {
    const result = await fetchOAuthProfile("x", {
      baseUrl: BASE_URL,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "network" });
  });

  it("maps an aborted request to timeout", async () => {
    const result = await fetchOAuthProfile("x", {
      baseUrl: BASE_URL,
      timeoutMs: 1,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("rejects an empty clientId before making a request", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const result = await fetchOAuthProfile("  ", {
      baseUrl: BASE_URL,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never returns a profile on failure — there is no bundled fallback", async () => {
    const result = await fetchOAuthProfile("x", {
      baseUrl: BASE_URL,
      fetchImpl: (async () => jsonResponse(503, {})) as unknown as typeof fetch,
    });
    // A failure means "this client cannot be emulated right now", never
    // "something else was used instead".
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("profile");
  });
});

describe("fetchOAuthProfileCatalog", () => {
  it("lists entries without profile bodies", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        schemaVersion: SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION,
        catalogRevision: "rev-1",
        entries: [
          {
            clientId: "example-desktop",
            label: "Example Desktop",
            profileDigest: "abc",
          },
        ],
      })) as unknown as typeof fetch;

    const result = await fetchOAuthProfileCatalog({
      baseUrl: BASE_URL,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalogRevision).toBe("rev-1");
    expect(result.entries).toEqual([
      {
        clientId: "example-desktop",
        label: "Example Desktop",
        profileDigest: "abc",
      },
    ]);
  });

  it("refuses a malformed listing rather than returning a partial one", async () => {
    const result = await fetchOAuthProfileCatalog({
      baseUrl: BASE_URL,
      fetchImpl: (async () =>
        jsonResponse(200, {
          schemaVersion: SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION,
          catalogRevision: "rev-1",
          entries: [{ label: "missing its clientId" }],
        })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("computeOAuthProfileDigest", () => {
  it("is canonical — key order cannot change it", async () => {
    const a = await computeOAuthProfileDigest({
      profileVersion: 2,
      authModel: verified(["oauth2-dcr"]),
      sendsResourceIndicator: verified(false),
    });
    const b = await computeOAuthProfileDigest({
      profileVersion: 2,
      sendsResourceIndicator: verified(false),
      authModel: verified(["oauth2-dcr"]),
    });
    expect(a).toBe(b);
  });

  it("distinguishes different profiles", async () => {
    const a = await computeOAuthProfileDigest(PROFILE);
    const b = await computeOAuthProfileDigest({
      profileVersion: 2,
      authModel: verified(["oauth2-cimd"]),
      sendsResourceIndicator: verified(false),
    });
    expect(a).not.toBe(b);
  });
});
