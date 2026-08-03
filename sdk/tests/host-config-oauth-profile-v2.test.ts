import {
  canonicalizeHostConfigV2,
  canonicalizeOAuthProfile,
  computeHostConfigHashV2,
  OAUTH_SCOPE_REQUEST_MODES,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  HostConfigOAuthProfileV1,
  HostConfigOAuthProfileV2,
  OAuthProfileEvidence,
} from "../src/host-config/internal";

function base(overrides: Partial<HostConfigInputV2> = {}): HostConfigInputV2 {
  return {
    hostStyle: "claude",
    modelId: "anthropic/claude-sonnet-4-6",
    systemPrompt: "You are a helpful assistant.",
    temperature: 0.7,
    requireToolApproval: false,
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  };
}

const hash = (input: HostConfigInputV2) => computeHostConfigHashV2(input);

// Canonicalize a V2 profile standalone, folding in the boilerplate version
// tag — same convention as the V1 suite's `profile` helper.
const profileV2 = (
  fields: Omit<HostConfigOAuthProfileV2, "profileVersion">
): HostConfigOAuthProfileV2 | undefined =>
  canonicalizeOAuthProfile({
    profileVersion: 2,
    ...fields,
  }) as HostConfigOAuthProfileV2 | undefined;

// Evidence boilerplate for a verified value.
const verified = <T,>(value: T): OAuthProfileEvidence<T> => ({
  status: "verified",
  value,
  source: "https://example.test/capture#L1",
  capturedAt: "2026-07-30",
});

describe("canonicalizeOAuthProfile — V2 dispatch and frozen V1", () => {
  it("preserves the incoming profileVersion — a V1 row is never rewritten to V2", () => {
    const v1 = canonicalizeOAuthProfile({ profileVersion: 1 });
    const v2 = canonicalizeOAuthProfile({ profileVersion: 2 });
    expect(v1).toEqual({ profileVersion: 1 });
    expect(v2).toEqual({ profileVersion: 2 });
  });

  it("rejects V2-only fields on a V1 row (V1 key set stays frozen)", () => {
    expect(() =>
      canonicalizeOAuthProfile({
        profileVersion: 1,
        scopeRequest: verified({ mode: "omit" }),
      } as unknown as HostConfigOAuthProfileV1)
    ).toThrow(/scopeRequest is not supported/);
    expect(() =>
      canonicalizeOAuthProfile({
        profileVersion: 1,
        tokenEndpointAuthMethod: verified("none"),
      } as unknown as HostConfigOAuthProfileV1)
    ).toThrow(/tokenEndpointAuthMethod is not supported/);
  });

  it("rejects unknown top-level keys on a V2 row", () => {
    expect(() =>
      canonicalizeOAuthProfile({
        profileVersion: 2,
        scopeRequests: verified({ mode: "omit" }),
      } as unknown as HostConfigOAuthProfileV2)
    ).toThrow(/scopeRequests is not supported/);
  });

  it("hashes V1-empty, V2-empty, and absent distinctly", async () => {
    const absent = await hash(base());
    const v1Empty = await hash(
      base({ oauthProfile: { profileVersion: 1 } })
    );
    const v2Empty = await hash(
      base({ oauthProfile: { profileVersion: 2 } })
    );
    expect(new Set([absent, v1Empty, v2Empty]).size).toBe(3);
  });

  it("omits absent V2 fields from canonical JSON — never null/default-filled", () => {
    const canonical = canonicalizeHostConfigV2(
      base({ oauthProfile: { profileVersion: 2 } })
    );
    expect(canonical.oauthProfile).toEqual({ profileVersion: 2 });
    // Scoped to the profile subtree: the claim under test is about
    // oauthProfile, and asserting over the whole config would couple this
    // test to every unrelated field base() or the canonicalizer emits.
    const json = JSON.stringify(canonical.oauthProfile);
    expect(json).not.toContain("scopeRequest");
    expect(json).not.toContain("tokenEndpointAuthMethod");
    expect(json).not.toContain("null");
  });
});

describe("canonicalizeOAuthProfile — V2 scopeRequest", () => {
  it("accepts every mode of the closed union", () => {
    for (const value of [
      { mode: "omit" as const },
      { mode: "fixed" as const, scopes: ["mcp:read", "mcp:write"] },
      { mode: "challenge" as const },
      { mode: "all-supported" as const },
    ]) {
      expect(profileV2({ scopeRequest: verified(value) })?.scopeRequest).toEqual(
        verified(value)
      );
    }
  });

  it("rejects an unknown mode loudly", () => {
    expect(() =>
      profileV2({
        scopeRequest: verified({ mode: "challenge-then-supported" } as never),
      })
    ).toThrow(/mode must be one of omit, fixed, challenge, all-supported/);
  });

  it('requires non-empty scopes when mode is "fixed"', () => {
    expect(() =>
      profileV2({ scopeRequest: verified({ mode: "fixed" } as never) })
    ).toThrow(/scopes must be a string\[\] when mode is "fixed"/);
    expect(() =>
      profileV2({
        scopeRequest: verified({ mode: "fixed", scopes: [] as string[] }),
      })
    ).toThrow(/scopes must be non-empty when mode is "fixed"/);
  });

  it("preserves captured scope order verbatim — never sorts", () => {
    const out = profileV2({
      scopeRequest: verified({
        mode: "fixed",
        scopes: ["z-last", "a-first", "m-middle"],
      }),
    });
    expect(
      (out?.scopeRequest as { value: { scopes: string[] } }).value.scopes
    ).toEqual(["z-last", "a-first", "m-middle"]);
  });

  it("hashes different scope orders distinctly (order is semantic)", async () => {
    const a = await hash(
      base({
        oauthProfile: {
          profileVersion: 2,
          scopeRequest: verified({ mode: "fixed", scopes: ["read", "write"] }),
        },
      })
    );
    const b = await hash(
      base({
        oauthProfile: {
          profileVersion: 2,
          scopeRequest: verified({ mode: "fixed", scopes: ["write", "read"] }),
        },
      })
    );
    expect(a).not.toBe(b);
  });

  it("rejects duplicate scopes rather than deduping", () => {
    expect(() =>
      profileV2({
        scopeRequest: verified({
          mode: "fixed",
          scopes: ["read", "write", "read"],
        }),
      })
    ).toThrow(/duplicate entry "read"/);
  });

  it('rejects scopes on any mode other than "fixed"', () => {
    for (const mode of ["omit", "challenge", "all-supported"] as const) {
      expect(() =>
        profileV2({
          scopeRequest: verified({ mode, scopes: ["read"] } as never),
        })
      ).toThrow(/scopes is only valid when mode is "fixed"/);
    }
  });

  it("every declared mode has a canonicalization rule (drift gate)", () => {
    // The other half of the switch's exhaustiveness `default`: that branch
    // catches a mode added to OAUTH_SCOPE_REQUEST_MODES with no matching
    // case, but it is only reachable by editing the source constant — the
    // membership Set is built at module load, so a test cannot inject one.
    // This asserts the same invariant from the reachable direction: adding a
    // mode without a rule fails HERE, at test time, not at runtime.
    for (const mode of OAUTH_SCOPE_REQUEST_MODES) {
      const value =
        mode === "fixed" ? { mode, scopes: ["s:one"] } : { mode };
      const out = profileV2({ scopeRequest: verified(value as never) });
      expect(
        (out?.scopeRequest as { value: { mode: string } }).value.mode
      ).toBe(mode);
    }
  });

  it("routes through the shared evidence envelope (unverifiable cannot carry a value)", () => {
    expect(() =>
      profileV2({
        scopeRequest: {
          status: "unverifiable",
          reason: "closed-source client",
          value: { mode: "omit" },
        } as never,
      })
    ).toThrow(/value must be omitted when status is "unverifiable"/);
    expect(
      profileV2({
        scopeRequest: {
          status: "unverifiable",
          reason: "closed-source client",
        },
      })?.scopeRequest
    ).toEqual({ status: "unverifiable", reason: "closed-source client" });
  });
});

describe("canonicalizeOAuthProfile — V2 tokenEndpointAuthMethod", () => {
  it("accepts every method of the closed union", () => {
    for (const method of [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ] as const) {
      expect(
        profileV2({ tokenEndpointAuthMethod: verified(method) })
          ?.tokenEndpointAuthMethod
      ).toEqual(verified(method));
    }
  });

  it("rejects an unknown method loudly", () => {
    expect(() =>
      profileV2({
        tokenEndpointAuthMethod: verified("private_key_jwt" as never),
      })
    ).toThrow(
      /must be one of none, client_secret_basic, client_secret_post/
    );
  });
});

describe("canonicalizeOAuthProfile — V2 dcrIdentity ordering", () => {
  it("preserves captured redirectUris order verbatim, where V1 sorts", () => {
    const uris = ["https://z.example/cb", "https://a.example/cb"];
    const v2 = profileV2({
      dcrIdentity: verified({ redirectUris: [...uris] }),
    });
    expect(
      (v2?.dcrIdentity as { value: { redirectUris: string[] } }).value
        .redirectUris
    ).toEqual(uris);

    // Contrast pin: the SAME input through the frozen V1 path still dedupes
    // + sorts. If this ever fails, V1 canonicalization drifted.
    const v1 = canonicalizeOAuthProfile({
      profileVersion: 1,
      dcrIdentity: verified({ redirectUris: [...uris] }),
    }) as HostConfigOAuthProfileV1;
    expect(
      (v1.dcrIdentity as { value: { redirectUris: string[] } }).value
        .redirectUris
    ).toEqual(["https://a.example/cb", "https://z.example/cb"]);
  });

  it("stores clientName verbatim — surrounding whitespace is replayed, not trimmed", () => {
    // A server may gate authorization policy on the exact `client_name`
    // string, so V2 must send the captured bytes. V1 (frozen) still trims.
    const captured = " Real Client ";
    const v2out = profileV2({ dcrIdentity: verified({ clientName: captured }) });
    expect(
      (v2out?.dcrIdentity as { value: { clientName: string } }).value.clientName
    ).toBe(captured);

    const v1out = canonicalizeOAuthProfile({
      profileVersion: 1,
      dcrIdentity: verified({ clientName: captured }),
    }) as HostConfigOAuthProfileV1;
    expect(
      (v1out.dcrIdentity as { value: { clientName: string } }).value.clientName
    ).toBe("Real Client");
  });

  it("still rejects an empty or whitespace-only clientName as a missing capture", () => {
    for (const clientName of ["", "   "]) {
      expect(() =>
        profileV2({ dcrIdentity: verified({ clientName }) })
      ).toThrow(/clientName must be a non-empty string/);
    }
  });

  it("rejects duplicate redirectUris rather than deduping", () => {
    expect(() =>
      profileV2({
        dcrIdentity: verified({
          redirectUris: ["https://a.example/cb", "https://a.example/cb"],
        }),
      })
    ).toThrow(/duplicate entry "https:\/\/a.example\/cb"/);
  });
});

describe("canonicalizeOAuthProfile — V2 hash stability", () => {
  it("emits a fixed key order regardless of input key order", () => {
    const inOrder = profileV2({
      scopeRequest: verified({ mode: "omit" }),
      sendsResourceIndicator: verified(true),
      tokenEndpointAuthMethod: verified("none"),
    });
    const shuffled = canonicalizeOAuthProfile({
      tokenEndpointAuthMethod: verified("none"),
      sendsResourceIndicator: verified(true),
      profileVersion: 2,
      scopeRequest: verified({ mode: "omit" }),
    } as HostConfigOAuthProfileV2);
    expect(JSON.stringify(inOrder)).toBe(JSON.stringify(shuffled));
    expect(Object.keys(inOrder as object)).toEqual([
      "profileVersion",
      "sendsResourceIndicator",
      "scopeRequest",
      "tokenEndpointAuthMethod",
    ]);
  });

  it("hashes a full host config with a V2 profile stably", async () => {
    const config = base({
      oauthProfile: {
        profileVersion: 2,
        sendsResourceIndicator: verified(true),
        scopeRequest: verified({ mode: "challenge" }),
        tokenEndpointAuthMethod: verified("client_secret_basic"),
      },
    });
    expect(await hash(config)).toBe(await hash(structuredClone(config)));
  });
});
