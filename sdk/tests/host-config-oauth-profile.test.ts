import {
  canonicalizeHostConfigV2,
  canonicalizeOAuthProfile,
  computeHostConfigHashV2,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  HostConfigOAuthProfileV1,
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

// Canonicalize a profile standalone. `profileVersion` is boilerplate in every
// case, so fold it in here to keep each test about the field under test.
const profile = (
  fields: Omit<HostConfigOAuthProfileV1, "profileVersion">
): HostConfigOAuthProfileV1 | undefined =>
  canonicalizeOAuthProfile({ profileVersion: 1, ...fields });

describe("canonicalizeOAuthProfile — legacy compatibility", () => {
  it("drops the key from canonical JSON when absent (pre-feature rows hash byte-identically)", () => {
    // Matches the house convention for every optional field (harness,
    // computer, mcpProfile): the property is present but `undefined`, and
    // JSON.stringify — which is what actually feeds the hash — omits it.
    // Byte-identity for the full legacy corpus is pinned by the golden
    // vectors in host-config-parity.test.ts, which this change must NOT
    // regenerate.
    const legacy = canonicalizeHostConfigV2(base());
    expect(legacy.oauthProfile).toBeUndefined();
    expect(JSON.stringify(legacy)).not.toContain("oauthProfile");
  });

  it("returns undefined for an absent profile", () => {
    expect(canonicalizeOAuthProfile(undefined)).toBeUndefined();
  });

  it("hashes distinctly once a profile IS set", async () => {
    const withProfile = base({
      oauthProfile: {
        profileVersion: 1,
        authModel: {
          status: "verified",
          value: "oauth2-dcr",
          source: "https://example.test/src/auth.ts#L1",
          capturedAt: "2026-07-29",
        },
      },
    });
    expect(await hash(base())).not.toBe(await hash(withProfile));
  });

  it("preserves an explicitly empty profile as distinct from absent", async () => {
    const empty = base({ oauthProfile: { profileVersion: 1 } });
    expect(canonicalizeHostConfigV2(empty).oauthProfile).toEqual({
      profileVersion: 1,
    });
    expect(await hash(base())).not.toBe(await hash(empty));
  });
});

describe("canonicalizeOAuthProfile — envelope validation", () => {
  it("rejects a profileVersion other than 1 (forward-compat trip wire)", () => {
    expect(() =>
      canonicalizeOAuthProfile({
        profileVersion: 2,
      } as unknown as HostConfigOAuthProfileV1)
    ).toThrow(/profileVersion must be 1/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      canonicalizeOAuthProfile({
        profileVersion: 1,
        sendsResourceIndicatorr: {},
      } as unknown as HostConfigOAuthProfileV1)
    ).toThrow(/sendsResourceIndicatorr is not supported/);
  });

  it("rejects a non-object profile", () => {
    expect(() =>
      canonicalizeOAuthProfile("nope" as unknown as HostConfigOAuthProfileV1)
    ).toThrow(/oauthProfile must be a plain object/);
  });

  it("rejects an unknown evidence status", () => {
    expect(() =>
      profile({
        sendsResourceIndicator: {
          status: "probably",
          value: true,
        } as never,
      })
    ).toThrow(/status must be one of verified, refuted, unverifiable/);
  });
});

// The invariant this whole type exists to enforce (HP-17): four of nine
// partner-supplied OAuth claims were false because the matrix could not
// distinguish observation from hearsay. A value must be impossible to record
// without evidence.
describe("canonicalizeOAuthProfile — unverified values are unrepresentable", () => {
  it("REJECTS a value on an unverifiable field", () => {
    expect(() =>
      profile({
        sendsResourceIndicator: {
          status: "unverifiable",
          reason: "closed-source client",
          value: false,
        } as never,
      })
    ).toThrow(/value must be omitted when status is "unverifiable"/);
  });

  it("rejects a source on an unverifiable field", () => {
    expect(() =>
      profile({
        sendsResourceIndicator: {
          status: "unverifiable",
          reason: "closed-source client",
          source: "https://example.test",
        } as never,
      })
    ).toThrow(/source must be omitted when status is "unverifiable"/);
  });

  it("requires a reason on an unverifiable field", () => {
    expect(() =>
      profile({
        sendsResourceIndicator: { status: "unverifiable" } as never,
      })
    ).toThrow(/reason must be a non-empty string/);
  });

  it("rejects a whitespace-only reason", () => {
    expect(() =>
      profile({
        sendsResourceIndicator: {
          status: "unverifiable",
          reason: "   ",
        } as never,
      })
    ).toThrow(/reason must be a non-empty string/);
  });

  it("accepts a well-formed unverifiable field, with optional capturedAt", () => {
    expect(
      profile({
        sendsResourceIndicator: {
          status: "unverifiable",
          reason: "closed-source client, no public source",
        },
      })?.sendsResourceIndicator
    ).toEqual({
      status: "unverifiable",
      reason: "closed-source client, no public source",
    });

    expect(
      profile({
        sendsResourceIndicator: {
          status: "unverifiable",
          reason: "requires enterprise credentials",
          capturedAt: "2026-07-29",
        },
      })?.sendsResourceIndicator
    ).toEqual({
      status: "unverifiable",
      reason: "requires enterprise credentials",
      capturedAt: "2026-07-29",
    });
  });

  it("requires value, source AND capturedAt on a verified field", () => {
    expect(() =>
      profile({
        sendsResourceIndicator: { status: "verified" } as never,
      })
    ).toThrow(/value is required when status is "verified"/);

    expect(() =>
      profile({
        sendsResourceIndicator: { status: "verified", value: true } as never,
      })
    ).toThrow(/source must be a non-empty string/);

    expect(() =>
      profile({
        sendsResourceIndicator: {
          status: "verified",
          value: true,
          source: "https://example.test",
        } as never,
      })
    ).toThrow(/capturedAt must be an ISO calendar date/);
  });

  it("rejects a reason on a verified field", () => {
    expect(() =>
      profile({
        sendsResourceIndicator: {
          status: "verified",
          value: true,
          source: "https://example.test",
          capturedAt: "2026-07-29",
          reason: "just in case",
        } as never,
      })
    ).toThrow(/reason is only valid when status is "unverifiable"/);
  });

  it("keeps a refuted value, so a refutation is durable", () => {
    // HP-45: refuted claims must stay in the record with their true value so
    // they cannot quietly re-enter the matrix later.
    expect(
      profile({
        sendsResourceIndicator: {
          status: "refuted",
          value: true,
          source: "codex/src/mcp/auth.rs:214",
          capturedAt: "2026-07-21",
        },
      })?.sendsResourceIndicator
    ).toEqual({
      status: "refuted",
      value: true,
      source: "codex/src/mcp/auth.rs:214",
      capturedAt: "2026-07-21",
    });
  });
});

describe("canonicalizeOAuthProfile — capturedAt", () => {
  it("rejects a non-ISO shape", () => {
    for (const bad of ["07/29/2026", "2026-7-9", "2026-07-29T00:00:00Z"]) {
      expect(() =>
        profile({
          sendsResourceIndicator: {
            status: "verified",
            value: true,
            source: "https://example.test",
            capturedAt: bad,
          },
        })
      ).toThrow(/capturedAt must be an ISO calendar date/);
    }
  });

  it("rejects a well-shaped date that does not exist", () => {
    // Regex alone would accept this; a bogus capture date would make any
    // staleness report silently wrong.
    expect(() =>
      profile({
        sendsResourceIndicator: {
          status: "verified",
          value: true,
          source: "https://example.test",
          capturedAt: "2026-02-31",
        },
      })
    ).toThrow(/is not a real date/);
  });
});

describe("canonicalizeOAuthProfile — field value rules", () => {
  it("enforces the closed protocol-version enum on oauthSpecVersion", () => {
    expect(() =>
      profile({
        oauthSpecVersion: {
          status: "verified",
          value: "2024-11-05" as never,
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/must be one of 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28/);

    expect(
      profile({
        oauthSpecVersion: {
          status: "verified",
          value: "2025-03-26",
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })?.oauthSpecVersion?.status
    ).toBe("verified");
  });

  it("enforces the closed authModel enum", () => {
    expect(() =>
      profile({
        authModel: {
          status: "verified",
          value: "magic" as never,
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/must be one of oauth2-dcr, oauth2-preregistered, api-key, none/);
  });

  it("requires a version when protocolVersionPinning is pinned", () => {
    expect(() =>
      profile({
        protocolVersionPinning: {
          status: "verified",
          value: { mode: "pinned" } as never,
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/must be one of 2025-03-26/);
  });

  it("rejects a version when protocolVersionPinning is negotiated", () => {
    expect(() =>
      profile({
        protocolVersionPinning: {
          status: "verified",
          value: { mode: "negotiated", version: "2025-06-18" } as never,
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/version must be omitted when mode is "negotiated"/);
  });

  it("accepts a pinned protocol version", () => {
    expect(
      profile({
        protocolVersionPinning: {
          status: "verified",
          value: { mode: "pinned", version: "2025-06-18" },
          source: "codex/src/mcp/protocol.rs:31",
          capturedAt: "2026-07-21",
        },
      })?.protocolVersionPinning
    ).toEqual({
      status: "verified",
      value: { mode: "pinned", version: "2025-06-18" },
      source: "codex/src/mcp/protocol.rs:31",
      capturedAt: "2026-07-21",
    });
  });
});

describe("canonicalizeOAuthProfile — dcrIdentity", () => {
  const wrap = (value: unknown) =>
    profile({
      dcrIdentity: {
        status: "verified",
        value,
        source: "https://example.test",
        capturedAt: "2026-07-29",
      } as never,
    })?.dcrIdentity;

  it("dedupes and sorts redirectUris (registration order is not semantic)", () => {
    const a = wrap({
      redirectUris: [
        "http://localhost:9999/cb",
        "http://127.0.0.1:1/cb",
        "http://localhost:9999/cb",
      ],
    });
    const b = wrap({
      redirectUris: ["http://127.0.0.1:1/cb", "http://localhost:9999/cb"],
    });
    expect(a).toEqual(b);
    expect((a?.value as { redirectUris: string[] }).redirectUris).toEqual([
      "http://127.0.0.1:1/cb",
      "http://localhost:9999/cb",
    ]);
  });

  it("preserves clientName casing byte-exactly (servers gate policy on it)", () => {
    const value = wrap({ clientName: "Claude Desktop" })?.value as {
      clientName: string;
    };
    expect(value.clientName).toBe("Claude Desktop");
  });

  it("rejects an empty redirectUris array", () => {
    expect(() => wrap({ redirectUris: [] })).toThrow(
      /redirectUris must be non-empty when set/
    );
  });

  it("rejects an identity with no fields set", () => {
    expect(() => wrap({})).toThrow(
      /must set at least one of clientName, redirectUris, userAgent/
    );
  });

  it("rejects unknown identity keys", () => {
    expect(() => wrap({ clientId: "abc" })).toThrow(
      /clientId is not supported/
    );
  });
});

describe("canonicalizeOAuthProfile — hash stability", () => {
  const full: Omit<HostConfigOAuthProfileV1, "profileVersion"> = {
    authModel: {
      status: "verified",
      value: "oauth2-dcr",
      source: "https://example.test/a",
      capturedAt: "2026-07-29",
    },
    sendsResourceIndicator: {
      status: "verified",
      value: false,
      source: "https://example.test/b",
      capturedAt: "2026-07-29",
    },
  };

  it("emits a fixed key order regardless of input key order", () => {
    const forward = canonicalizeOAuthProfile({ profileVersion: 1, ...full });
    const reversed = canonicalizeOAuthProfile({
      authModel: full.authModel,
      sendsResourceIndicator: full.sendsResourceIndicator,
      profileVersion: 1,
    });
    // Byte-identical, not merely deep-equal: key order leaks into the hash.
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(Object.keys(forward!)).toEqual([
      "profileVersion",
      "sendsResourceIndicator",
      "authModel",
    ]);
  });

  it("hashes identically for host configs differing only in profile key order", async () => {
    const a = base({ oauthProfile: { profileVersion: 1, ...full } });
    const b = base({
      oauthProfile: {
        profileVersion: 1,
        authModel: full.authModel,
        sendsResourceIndicator: full.sendsResourceIndicator,
      },
    });
    expect(await hash(a)).toBe(await hash(b));
  });

  it("deep-sorts extensions so nested order does not leak into the hash", async () => {
    const a = base({
      oauthProfile: {
        profileVersion: 1,
        extensions: { x: { p: 1, q: 2 }, y: 3 },
      },
    });
    const b = base({
      oauthProfile: {
        profileVersion: 1,
        extensions: { y: 3, x: { q: 2, p: 1 } },
      },
    });
    expect(await hash(a)).toBe(await hash(b));
  });

  it("trims source and reason so whitespace cannot fork the hash", async () => {
    const a = base({
      oauthProfile: {
        profileVersion: 1,
        authModel: {
          status: "verified",
          value: "none",
          source: "  https://example.test  ",
          capturedAt: "2026-07-29",
        },
      },
    });
    const b = base({
      oauthProfile: {
        profileVersion: 1,
        authModel: {
          status: "verified",
          value: "none",
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      },
    });
    expect(await hash(a)).toBe(await hash(b));
  });
});
