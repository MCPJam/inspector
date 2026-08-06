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
          value: ["oauth2-dcr"],
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
  it("rejects an unknown profileVersion (forward-compat trip wire)", () => {
    // profileVersion: 2 is now a real shape (host-config-oauth-profile-v2
    // tests cover it) — the trip wire moves to the next unknown version.
    expect(() =>
      canonicalizeOAuthProfile({
        profileVersion: 3,
      } as unknown as HostConfigOAuthProfileV1)
    ).toThrow(/profileVersion must be 1 or 2/);
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
  const specVersion = (value: unknown) =>
    profile({
      oauthSpecVersion: {
        status: "verified",
        value,
        source: "https://example.test",
        capturedAt: "2026-07-29",
      } as never,
    })?.oauthSpecVersion;

  it("accepts revisions this inspector does not itself speak", () => {
    // The whole reason oauthSpecVersion is NOT McpProtocolVersion: Cline's
    // bundled SDK supports 2024-11-05 and 2024-10-07, and rmcp pins
    // 2024-11-05 on OAuth discovery. Enum membership would make real, sourced
    // findings unrecordable.
    const value = specVersion({
      basis: "constant",
      revisions: ["2024-10-07", "2024-11-05"],
    })?.value as { revisions: string[] };
    expect(value.revisions).toEqual(["2024-10-07", "2024-11-05"]);
  });

  it("still rejects a revision that is not a real calendar date", () => {
    expect(() =>
      specVersion({ basis: "constant", revisions: ["2025-02-31"] })
    ).toThrow(/is not a real date/);
    expect(() => specVersion({ basis: "constant", revisions: ["v2"] })).toThrow(
      /must be an ISO calendar date/
    );
  });

  it("dedupes and sorts a constant revision set (order is not semantic here)", () => {
    // Contrast with authModel, where order IS semantic. A multi-revision
    // client implements a SET; two orderings must hash identically.
    const a = specVersion({
      basis: "constant",
      revisions: ["2025-11-25", "2025-03-26", "2025-11-25"],
    });
    const b = specVersion({
      basis: "constant",
      revisions: ["2025-03-26", "2025-11-25"],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("requires a non-empty revision set on the constant arm", () => {
    expect(() => specVersion({ basis: "constant", revisions: [] })).toThrow(
      /revisions must be non-empty when basis is "constant"/
    );
  });

  it("records a behavioral finding as a FLOOR, not an exact value", () => {
    // VS Code has no revision constant anywhere in its source. The verified
    // claim is "at least this revision", which is why the arms are distinct.
    expect(
      specVersion({ basis: "behavioral", minimumRevision: "2025-06-18" })?.value
    ).toEqual({ basis: "behavioral", minimumRevision: "2025-06-18" });
  });

  it("keeps the two arms from bleeding into each other", () => {
    expect(() =>
      specVersion({ basis: "behavioral", revisions: ["2025-06-18"] })
    ).toThrow(/revisions is not supported/);
    expect(() =>
      specVersion({ basis: "constant", minimumRevision: "2025-06-18" })
    ).toThrow(/minimumRevision is not supported/);
    expect(() => specVersion({ basis: "guessed" })).toThrow(
      /basis must be "constant" or "behavioral"/
    );
  });

  it("enforces the closed authModel enum on every entry", () => {
    expect(() =>
      profile({
        authModel: {
          status: "verified",
          value: ["oauth2-dcr", "magic"] as never,
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(
      /authModel\.value\[1\] must be one of oauth2-dcr, oauth2-cimd, oauth2-preregistered, api-key, none/
    );
  });

  it("rejects a bare authModel string (it is a preference list)", () => {
    expect(() =>
      profile({
        authModel: {
          status: "verified",
          value: "oauth2-dcr" as never,
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/must be a non-empty array of auth models in preference order/);
  });

  it("rejects an empty authModel list", () => {
    expect(() =>
      profile({
        authModel: {
          status: "verified",
          value: [] as never,
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/must be non-empty when set/);
  });

  it("rejects duplicate authModel entries (ambiguous precedence)", () => {
    expect(() =>
      profile({
        authModel: {
          status: "verified",
          value: ["oauth2-dcr", "api-key", "oauth2-dcr"],
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/duplicate entry "oauth2-dcr"/);
  });

  it('accepts "none" as the sole authModel entry (how "no auth at all" is spelled)', () => {
    // Contrast with an absent oauthProfile, which means "not investigated
    // yet". This is the positive claim that the client authenticates nowhere.
    const value = profile({
      authModel: {
        status: "verified",
        value: ["none"],
        source: "https://example.test",
        capturedAt: "2026-07-29",
      },
    })?.authModel;
    expect((value as { value: string[] }).value).toEqual(["none"]);
  });

  it('rejects "none" alongside a real auth model (contradictory claim)', () => {
    // "none" is the absence of a mechanism, not one more fallback: this list
    // asserts both "has no auth" and "does DCR", which no emulator can honor.
    expect(() =>
      profile({
        authModel: {
          status: "verified",
          value: ["none", "oauth2-dcr"],
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/contains "none" alongside other entries/);
  });

  it('rejects "none" in a trailing position too — order cannot rescue it', () => {
    expect(() =>
      profile({
        authModel: {
          status: "verified",
          value: ["oauth2-dcr", "none"],
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      })
    ).toThrow(/must be the sole entry/);
  });

  it("preserves authModel order verbatim — it encodes preference, not a set", () => {
    // Goose and Codex both try static headers/bearer BEFORE OAuth. Sorting
    // would invert that and make the emulator reach for the wrong path first.
    const value = profile({
      authModel: {
        status: "verified",
        value: ["api-key", "oauth2-dcr"],
        source: "https://example.test",
        capturedAt: "2026-07-29",
      },
    })?.authModel;
    expect((value as { value: string[] }).value).toEqual([
      "api-key",
      "oauth2-dcr",
    ]);
  });

  it("hashes two different preference orders distinctly", async () => {
    const mk = (value: string[]) =>
      base({
        oauthProfile: {
          profileVersion: 1,
          authModel: {
            status: "verified",
            value: value as never,
            source: "https://example.test",
            capturedAt: "2026-07-29",
          },
        },
      });
    expect(await hash(mk(["api-key", "oauth2-dcr"]))).not.toBe(
      await hash(mk(["oauth2-dcr", "api-key"]))
    );
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
    ).toThrow(/version must be an ISO calendar date/);
  });

  it("accepts a pinned version outside the versions we speak", () => {
    // rmcp hardcodes MCP-Protocol-Version: 2024-11-05 on OAuth discovery,
    // which both Codex and Goose inherit. Enum-checking would erase it.
    expect(
      profile({
        protocolVersionPinning: {
          status: "verified",
          value: { mode: "pinned", version: "2024-11-05" },
          source: "rmcp auth.rs:2623",
          capturedAt: "2026-07-29",
        },
      })?.protocolVersionPinning?.value
    ).toEqual({ mode: "pinned", version: "2024-11-05" });
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
      value: ["oauth2-dcr"],
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
          value: ["none"],
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
          value: ["none"],
          source: "https://example.test",
          capturedAt: "2026-07-29",
        },
      },
    });
    expect(await hash(a)).toBe(await hash(b));
  });
});
