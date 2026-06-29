import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
} from "../src/host-config/internal";
import type { HostConfigInputV2 } from "../src/host-config/internal";

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

describe("canonicalizeHostConfigV2 — hash stability", () => {
  it("is independent of header / capability key order at every depth (deep sort)", async () => {
    // connectionDefaults.headers stays shallow (flat by design).
    // clientCapabilities and hostContext now deep-sort: nested key order
    // must not leak into the canonical hash.
    const a = base({
      connectionDefaults: { headers: { a: "1", b: "2" }, requestTimeout: 1 },
      clientCapabilities: { x: { p: 1, q: 2 }, y: 3 },
      hostContext: { foo: { a: 1, b: 2 } },
    });
    const b = base({
      connectionDefaults: { headers: { b: "2", a: "1" }, requestTimeout: 1 },
      clientCapabilities: { y: 3, x: { q: 2, p: 1 } },
      hostContext: { foo: { b: 2, a: 1 } },
    });
    expect(await hash(a)).toBe(await hash(b));
  });

  it("deep-sorts hostCapabilitiesOverride (nested order-independent)", async () => {
    const a = base({ hostCapabilitiesOverride: { x: { p: 1, q: 2 }, y: 3 } });
    const b = base({ hostCapabilitiesOverride: { y: 3, x: { q: 2, p: 1 } } });
    expect(await hash(a)).toBe(await hash(b));
  });

  it("normalizes undefined serverIds to [] (same hash as explicit empty)", async () => {
    expect(await hash(base())).toBe(
      await hash(base({ serverIds: [], optionalServerIds: [] }))
    );
  });

  it("sorts and dedupes serverIds deterministically", () => {
    const c = canonicalizeHostConfigV2(
      base({
        serverIds: ["c", "a", "b", "a"] as string[],
        optionalServerIds: ["z", "x", "x"] as string[],
      })
    );
    expect(c.serverIds).toEqual(["a", "b", "c"]);
    expect(c.optionalServerIds).toEqual(["x", "z"]);
  });
});

describe("canonicalizeHostConfigV2 — builtInToolIds", () => {
  it("omits builtInToolIds when absent (pre-feature rows stay byte-identical)", () => {
    const canonical = JSON.parse(
      JSON.stringify(canonicalizeHostConfigV2(base()))
    );
    expect("builtInToolIds" in canonical).toBe(false);
  });

  it("treats undefined and [] as identical (both omitted, same hash)", async () => {
    expect(await hash(base())).toBe(await hash(base({ builtInToolIds: [] })));
    const canonical = JSON.parse(
      JSON.stringify(canonicalizeHostConfigV2(base({ builtInToolIds: [] })))
    );
    expect("builtInToolIds" in canonical).toBe(false);
  });

  it("a populated set shifts the hash vs absent", async () => {
    expect(await hash(base())).not.toBe(
      await hash(base({ builtInToolIds: ["web_search"] }))
    );
  });

  it("dedupes and sorts deterministically (order-insensitive)", async () => {
    const c = canonicalizeHostConfigV2(
      base({ builtInToolIds: ["web_search", "code_exec", "web_search"] })
    );
    expect(c.builtInToolIds).toEqual(["code_exec", "web_search"]);
    // Order + dupes do not affect the hash.
    expect(
      await hash(base({ builtInToolIds: ["web_search", "code_exec"] }))
    ).toBe(
      await hash(
        base({ builtInToolIds: ["code_exec", "web_search", "code_exec"] })
      )
    );
  });

  it("preserves opaque ids verbatim (no trimming — backend rejects malformed)", () => {
    const c = canonicalizeHostConfigV2(
      base({ builtInToolIds: ["web_search "] })
    );
    expect(c.builtInToolIds).toEqual(["web_search "]);
  });

  it("rejects a non-array builtInToolIds", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ builtInToolIds: "web_search" as unknown as string[] })
      )
    ).toThrow(/builtInToolIds must be a string\[\]/);
  });

  it("rejects non-string entries", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ builtInToolIds: [123 as unknown as string] })
      )
    ).toThrow(/builtInToolIds entries must be strings/);
  });

  it("rejects empty / whitespace-only entries", () => {
    expect(() =>
      canonicalizeHostConfigV2(base({ builtInToolIds: [""] }))
    ).toThrow(/builtInToolIds entries must be non-empty strings/);
    expect(() =>
      canonicalizeHostConfigV2(base({ builtInToolIds: ["   "] }))
    ).toThrow(/builtInToolIds entries must be non-empty strings/);
  });
});

describe("canonicalizeHostConfigV2 — undefined vs explicit", () => {
  it("distinguishes hostCapabilitiesOverride undefined from {}", async () => {
    const omitted = canonicalizeHostConfigV2(base());
    expect(
      "hostCapabilitiesOverride" in JSON.parse(JSON.stringify(omitted))
    ).toBe(false);
    expect(await hash(base())).not.toBe(
      await hash(base({ hostCapabilitiesOverride: {} }))
    );
  });

  it("distinguishes progressiveToolDiscovery undefined from false", async () => {
    expect(await hash(base())).not.toBe(
      await hash(base({ progressiveToolDiscovery: false }))
    );
  });

  it("distinguishes MCP tool-result policy undefined from explicit values", async () => {
    const omitted = JSON.parse(
      JSON.stringify(canonicalizeHostConfigV2(base()))
    );
    expect("modelVisibleMcpToolResults" in omitted).toBe(false);
    expect(await hash(base())).not.toBe(
      await hash(
        base({
          modelVisibleMcpToolResults: {
            directContent: { image: false },
          },
        })
      )
    );
    expect(await hash(base())).not.toBe(
      await hash(
        base({
          modelVisibleMcpToolResults: {
            directContent: { image: true },
          },
        })
      )
    );
  });

  it("distinguishes MCP tool-result image rendering undefined from explicit modes", async () => {
    const omitted = JSON.parse(
      JSON.stringify(canonicalizeHostConfigV2(base()))
    );
    expect("mcpToolResultImageRendering" in omitted).toBe(false);
    for (const mode of ["none", "panel", "inline"] as const) {
      expect(await hash(base())).not.toBe(
        await hash(base({ mcpToolResultImageRendering: mode }))
      );
    }
  });

  it("rejects unknown MCP tool-result image rendering modes", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ mcpToolResultImageRendering: "floating" as never })
      )
    ).toThrow(
      /mcpToolResultImageRendering must be "none", "panel", or "inline"/
    );
  });
});

describe("canonicalizeHostConfigV2 — computer", () => {
  // Resource-only shape; capabilities (e.g. "bash") ride builtInToolIds.
  const personal = { kind: "personal" } as const;
  // Original MVP input shape — still accepted, dropped from canonical.
  const legacy = { kind: "personal", toolset: "bash" } as const;

  it("omits the key entirely when absent (pre-feature byte shape)", () => {
    const c = canonicalizeHostConfigV2(base());
    expect("computer" in JSON.parse(JSON.stringify(c))).toBe(false);
  });

  it("collapses null to absent — cleared hashes identically to never-set", async () => {
    const cleared = canonicalizeHostConfigV2(base({ computer: null }));
    expect("computer" in JSON.parse(JSON.stringify(cleared))).toBe(false);
    expect(await hash(base({ computer: null }))).toBe(await hash(base()));
  });

  it("hashes a personal computer distinctly from absent", async () => {
    expect(await hash(base({ computer: personal }))).not.toBe(
      await hash(base())
    );
  });

  it("drops the legacy toolset key — legacy input hashes identically to the new shape", async () => {
    expect(
      canonicalizeHostConfigV2(base({ computer: legacy })).computer
    ).toEqual({ kind: "personal" });
    expect(await hash(base({ computer: legacy }))).toBe(
      await hash(base({ computer: personal }))
    );
  });

  it("preserves workdir and hashes it distinctly from no-workdir", async () => {
    const withDir = base({ computer: { ...personal, workdir: "/srv/app" } });
    expect(canonicalizeHostConfigV2(withDir).computer).toEqual({
      kind: "personal",
      workdir: "/srv/app",
    });
    expect(await hash(withDir)).not.toBe(
      await hash(base({ computer: personal }))
    );
  });

  it("trims workdir; whitespace-only collapses to absent", async () => {
    expect(
      await hash(base({ computer: { ...personal, workdir: "  /srv/app  " } }))
    ).toBe(
      await hash(base({ computer: { ...personal, workdir: "/srv/app" } }))
    );
    expect(
      await hash(base({ computer: { ...personal, workdir: "   " } }))
    ).toBe(await hash(base({ computer: personal })));
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ computer: { kind: "shared", toolset: "bash" } as never })
      )
    ).toThrow(/computer\.kind must be "personal"/);
  });

  it("rejects an unknown legacy toolset value", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ computer: { kind: "personal", toolset: "zsh" } as never })
      )
    ).toThrow(/computer\.toolset must be "bash"/);
  });

  it("rejects an unknown key (typo defense + hash hygiene)", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ computer: { ...personal, workDir: "/x" } as never })
      )
    ).toThrow(/computer has unknown key "workDir"/);
  });

  it("rejects a non-string workdir", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ computer: { ...personal, workdir: 7 } as never })
      )
    ).toThrow(/computer\.workdir must be a string/);
  });

  it("rejects a non-object computer", () => {
    expect(() =>
      canonicalizeHostConfigV2(base({ computer: "personal" as never }))
    ).toThrow(/computer must be a plain object or null/);
  });
});

describe("canonicalizeHostConfigV2 — validation", () => {
  it("throws on non-finite temperature", () => {
    expect(() => canonicalizeHostConfigV2(base({ temperature: NaN }))).toThrow(
      /temperature must be finite/
    );
  });

  it("rejects an unknown mcpAppsOverrides key (typo defense)", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            apps: { mcpAppsOverrides: { toolCanceled: true } as never },
          },
        })
      )
    ).toThrow(/unknown key "toolCanceled"/);
  });

  it("rejects a serverConnectionOverrides key not in serverIds", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          serverIds: ["a"] as string[],
          serverConnectionOverrides: { b: { requestTimeoutOverride: 1 } },
        })
      )
    ).toThrow(/not in serverIds or optionalServerIds/);
  });

  it("rejects a non-finite per-server request timeout override", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          serverIds: ["a"] as string[],
          serverConnectionOverrides: {
            a: { requestTimeoutOverride: Infinity },
          },
        })
      )
    ).toThrow(/requestTimeoutOverride must be finite/);
  });

  it("requires mcpProfile.profileVersion === 1", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ mcpProfile: { profileVersion: 2 } as never })
      )
    ).toThrow(/profileVersion must be 1/);
  });

  it("rejects an empty availableDisplayModes array", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            apps: { mcpAppsOverrides: { availableDisplayModes: [] } },
          },
        })
      )
    ).toThrow(/must contain at least one mode/);
  });

  it("drops spec permission features from allowFeatures and blocks injection", () => {
    const c = canonicalizeHostConfigV2(
      base({
        mcpProfile: {
          profileVersion: 1,
          apps: {
            sandbox: { allowFeatures: { camera: "*", fullscreen: "'self'" } },
          },
        },
      })
    );
    const allowFeatures = c.mcpProfile?.apps?.sandbox?.allowFeatures ?? {};
    expect("camera" in allowFeatures).toBe(false);
    expect(allowFeatures.fullscreen).toBe("'self'");

    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            apps: { sandbox: { allowFeatures: { fullscreen: "*; camera *" } } },
          },
        })
      )
    ).toThrow(/must not contain ';' or ','/);
  });
});

describe("canonicalizeHostConfigV2 — mcpProfile derivation", () => {
  it("derives supportedProtocolVersions for a stateful pin", () => {
    const c = canonicalizeHostConfigV2(
      base({
        mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-06-18" },
      })
    );
    expect(c.mcpProfile?.initialize?.supportedProtocolVersions).toEqual([
      "2025-06-18",
    ]);
  });

  it("does not derive for a stateless pin", () => {
    const c = canonicalizeHostConfigV2(
      base({
        mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2026-07-28" },
      })
    );
    expect(c.mcpProfile?.initialize).toBeUndefined();
  });

  it("throws ConflictingProtocolVersionPin when pin not advertised", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            mcpProtocolVersion: "2025-06-18",
            initialize: { supportedProtocolVersions: ["2025-11-25"] },
          },
        })
      )
    ).toThrow(/ConflictingProtocolVersionPin/);
  });
});

describe("canonicalizeHostConfigV2 — tightening (Stage B)", () => {
  // Item 5: fail-fast on missing required record fields. The previous
  // `?? {}` coalescing silently merged undefined-cap rows with explicit-{}
  // rows; both now reach an explicit error at the canonicalize boundary.
  it("throws when clientCapabilities is missing (fail-fast, no `?? {}` fallback)", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        // The Input type marks it required; cast simulates an upstream bug
        // (writer who let v.any() through with undefined).
        base({
          clientCapabilities: undefined as unknown as Record<string, unknown>,
        })
      )
    ).toThrow(/clientCapabilities is required/);
  });

  it("throws when hostContext is missing (fail-fast)", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ hostContext: undefined as unknown as Record<string, unknown> })
      )
    ).toThrow(/hostContext is required/);
  });

  it("throws when clientCapabilities is not a plain object", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ clientCapabilities: [] as unknown as Record<string, unknown> })
      )
    ).toThrow(/clientCapabilities must be a plain object/);
  });

  // Regression: Date / Map / Set / class instances all return `[]` from
  // `Object.keys`, so without the prototype guard in isPlainObject they
  // would silently canonicalize to `{}` and merge with the empty-record
  // dedupe pool — the exact dedupe collapse the fail-fast is meant to
  // prevent. CodeRabbit flagged this on the original PR.
  it("rejects Date / Map / Set / class instances on plain-object fields (prototype-guarded)", () => {
    const samples: Array<[string, unknown]> = [
      ["Date", new Date(0)],
      ["Map", new Map()],
      ["Set", new Set()],
      [
        "class instance",
        new (class {
          x = 1;
        })(),
      ],
    ];
    for (const [label, value] of samples) {
      expect(
        () =>
          canonicalizeHostConfigV2(
            base({ clientCapabilities: value as Record<string, unknown> })
          ),
        `clientCapabilities = ${label}`
      ).toThrow(/clientCapabilities must be a plain object/);
    }
  });

  it("accepts Object.create(null) records on plain-object fields (no prototype, still serializable)", async () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.foo = 1;
    nullProto.bar = { baz: 2 };
    expect(() =>
      canonicalizeHostConfigV2(base({ clientCapabilities: nullProto }))
    ).not.toThrow();
    // And hashes identically to the `{}`-literal form — proto difference
    // doesn't leak into canonical JSON.
    const a = base({ clientCapabilities: nullProto });
    const b = base({ clientCapabilities: { foo: 1, bar: { baz: 2 } } });
    expect(await hash(a)).toBe(await hash(b));
  });

  // Item 3: empty allowFeatures collapses to absent. Sibling
  // openaiAppsOverrides already does this; allowFeatures was the odd one
  // out and minted distinct hashes for semantically identical configs.
  it("collapses empty allowFeatures to absent (hash-identical to omitting it)", async () => {
    const omitted = base({
      mcpProfile: { profileVersion: 1, apps: { sandbox: {} } },
    });
    const explicitEmpty = base({
      mcpProfile: {
        profileVersion: 1,
        apps: { sandbox: { allowFeatures: {} } },
      },
    });
    expect(await hash(omitted)).toBe(await hash(explicitEmpty));
  });

  it("collapses an allowFeatures with only spec-feature keys (all dropped) to absent", async () => {
    const omitted = base({
      mcpProfile: { profileVersion: 1, apps: { sandbox: {} } },
    });
    const onlySpecKeys = base({
      mcpProfile: {
        profileVersion: 1,
        apps: {
          sandbox: { allowFeatures: { camera: "*", microphone: "self" } },
        },
      },
    });
    expect(await hash(omitted)).toBe(await hash(onlySpecKeys));
  });

  // Item 6: drop openaiAppsOverrides when openaiApps:false. The resolver
  // ignores them when the shim isn't injected; letting them affect the
  // hash mints rows that resolve to identical runtime behavior.
  it("drops openaiAppsOverrides when compatRuntime.openaiApps is false (resolver ignores them)", async () => {
    const withOverrides = base({
      mcpProfile: {
        profileVersion: 1,
        apps: {
          compatRuntime: {
            openaiApps: false,
            openaiAppsOverrides: { requestModal: true, uploadFile: false },
          },
        },
      },
    });
    const withoutOverrides = base({
      mcpProfile: {
        profileVersion: 1,
        apps: { compatRuntime: { openaiApps: false } },
      },
    });
    expect(await hash(withOverrides)).toBe(await hash(withoutOverrides));
  });

  it("keeps openaiAppsOverrides when compatRuntime.openaiApps is true (overrides are live)", async () => {
    const withOverrides = base({
      mcpProfile: {
        profileVersion: 1,
        apps: {
          compatRuntime: {
            openaiApps: true,
            openaiAppsOverrides: { requestModal: true },
          },
        },
      },
    });
    const withoutOverrides = base({
      mcpProfile: {
        profileVersion: 1,
        apps: { compatRuntime: { openaiApps: true } },
      },
    });
    expect(await hash(withOverrides)).not.toBe(await hash(withoutOverrides));
  });
});

describe("canonicalizeHostConfigV2 — harness field", () => {
  it("rejects an unknown harness id (closed-enum guard)", () => {
    // Untyped (JS) callers must not persist a value the runtime can't honor.
    // `pi` is a plausible-but-unregistered runtime — not in HARNESS_IDS.
    expect(() =>
      canonicalizeHostConfigV2(base({ harness: "pi" as never }))
    ).toThrow(/harness must be/);
  });

  it.each(["claude-code", "codex"] as const)(
    "passes the registered harness %s through to the canonical form",
    (harness) => {
      const canonical = canonicalizeHostConfigV2(base({ harness }));
      expect(canonical.harness).toBe(harness);
    }
  );

  it("absent harness drops from canonical JSON and hashes distinctly from when set", async () => {
    const without = base();
    const withHarness = base({ harness: "claude-code" });
    // Absent ⇒ no key in canonical JSON (JSON.stringify drops the undefined
    // property), so pre-feature rows hash byte-identically.
    expect(JSON.stringify(canonicalizeHostConfigV2(without))).not.toContain(
      "harness"
    );
    // Setting it writes the key and changes the hash (distinct from emulated).
    expect(JSON.stringify(canonicalizeHostConfigV2(withHarness))).toContain(
      '"harness":"claude-code"'
    );
    expect(await hash(withHarness)).not.toBe(await hash(without));
  });
});
