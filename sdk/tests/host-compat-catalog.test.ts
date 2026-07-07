import { describe, expect, it, vi } from "vitest";
import {
  buildHostProfilesFromCatalog,
  buildMarketHostProfiles,
  bundledHostCompatCatalog,
  evaluateMarketHosts,
  fetchHostCompatCatalog,
  hostCompatCatalogEnvelopeSchema,
  hostCompatCatalogSchema,
  type HostCompatCatalog,
} from "../src/host-compat/index";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const envelopeFor = (catalog: HostCompatCatalog, extra?: object) => ({
  schemaVersion: 1,
  version: 7,
  contentHash: "abc123",
  publishedAt: 1750000000000,
  catalog,
  ...extra,
});

describe("bundledHostCompatCatalog", () => {
  it("is deep-frozen and stable across calls", () => {
    const catalog = bundledHostCompatCatalog();
    expect(catalog).toBe(bundledHostCompatCatalog());
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.marketHosts[0])).toBe(true);
    expect(Object.isFrozen(catalog.capabilitiesById.claude)).toBe(true);
    expect(Object.isFrozen(catalog.openAiCompatByStyle)).toBe(true);
  });

  it("parses under the catalog schema (lockstep guard: bundled ⊆ wire shape)", () => {
    // JSON round-trip strips `undefined` optionals the way the wire would.
    const parsed = hostCompatCatalogSchema.safeParse(
      clone(bundledHostCompatCatalog())
    );
    expect(parsed.success).toBe(true);
  });
});

describe("buildHostProfilesFromCatalog", () => {
  it("deep-equals buildMarketHostProfiles() on the bundled catalog (lockstep guard)", () => {
    expect(buildHostProfilesFromCatalog(bundledHostCompatCatalog())).toEqual(
      buildMarketHostProfiles()
    );
  });

  it("keeps rendersOpenAiApps independent of rendersMcpApps (NOT &&-gated)", () => {
    const catalog: HostCompatCatalog = {
      marketHosts: [
        // Headless host with OpenAI compat on — still rendersOpenAiApps,
        // therefore rendersWidgets, therefore gets a capability matrix.
        {
          id: "ghostwriter",
          label: "Ghostwriter",
          provenance: "assumed",
          rendersMcpApps: false,
        },
      ],
      capabilitiesById: {},
      openAiCompatByStyle: { ghostwriter: true },
    };
    const [profile] = buildHostProfilesFromCatalog(catalog);
    expect(profile.rendersMcpApps).toBe(false);
    expect(profile.rendersOpenAiApps).toBe(true);
    // rendersWidgets → matrix defaults to no-claims rather than undefined.
    expect(profile.capabilities).toBeDefined();
    expect(profile.capabilities?.serverTools).toBe(false);
  });

  it("leaves capabilities undefined for fully headless hosts", () => {
    const catalog: HostCompatCatalog = {
      marketHosts: [
        {
          id: "headless",
          label: "Headless",
          provenance: "probe",
          rendersMcpApps: false,
        },
      ],
      capabilitiesById: {},
      openAiCompatByStyle: {},
    };
    expect(
      buildHostProfilesFromCatalog(catalog)[0].capabilities
    ).toBeUndefined();
  });

  it("falls back to no-claims for a host id colliding with a prototype key", () => {
    const catalog: HostCompatCatalog = {
      marketHosts: [
        {
          id: "constructor",
          label: "Constructor",
          provenance: "probe",
          rendersMcpApps: true,
        },
      ],
      // No own entry for "constructor" — the lookup must NOT read
      // Object.prototype.constructor.
      capabilitiesById: {},
      openAiCompatByStyle: {},
    };
    const [profile] = buildHostProfilesFromCatalog(catalog);
    expect(profile.capabilities).toBeDefined();
    expect(profile.capabilities?.serverTools).toBe(false);
    expect(typeof profile.capabilities).toBe("object");
  });

  it("does not treat a prototype-key openAiCompat lookup as compatible", () => {
    const catalog: HostCompatCatalog = {
      marketHosts: [
        {
          id: "toString",
          label: "Prototype",
          provenance: "probe",
          rendersMcpApps: false,
        },
      ],
      capabilitiesById: {},
      // No own "toString" entry — the lookup must not read the inherited fn.
      openAiCompatByStyle: {},
    };
    const [profile] = buildHostProfilesFromCatalog(catalog);
    expect(profile.rendersOpenAiApps).toBe(false);
    // Headless + not OpenAI-compat ⇒ no capability matrix.
    expect(profile.capabilities).toBeUndefined();
  });

  it("deep-freezes children even under an already-shallow-frozen parent", () => {
    const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
    // Shallow-freeze the top object only (children still mutable).
    Object.freeze(catalog);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.capabilitiesById.claude)).toBe(false);
    buildHostProfilesFromCatalog(catalog);
    // deepFreeze must have recursed past the frozen parent.
    expect(Object.isFrozen(catalog.capabilitiesById.claude)).toBe(true);
    expect(Object.isFrozen(catalog.marketHosts[0])).toBe(true);
  });

  it("freezes the input catalog and returns mutable profile copies", () => {
    const catalog = clone(bundledHostCompatCatalog());
    const profiles = buildHostProfilesFromCatalog(catalog);
    expect(Object.isFrozen(catalog.capabilitiesById.claude)).toBe(true);
    // Caller copies stay safe to edit.
    profiles[0].label = "edited";
    expect(
      buildHostProfilesFromCatalog(clone(bundledHostCompatCatalog()))[0].label
    ).not.toBe("edited");
  });
});

describe("evaluateMarketHosts with a catalog", () => {
  it("threads options.catalog into the evaluation", () => {
    const catalog: HostCompatCatalog = {
      marketHosts: [
        {
          id: "solo",
          label: "Solo",
          provenance: "probe",
          rendersMcpApps: true,
        },
      ],
      capabilitiesById: {},
      openAiCompatByStyle: {},
    };
    const { reports } = evaluateMarketHosts({ tools: [] }, { catalog });
    expect(reports.map((r) => r.hostId)).toEqual(["solo"]);
  });

  it("defaults to the bundled catalog when no catalog is passed", () => {
    const { reports } = evaluateMarketHosts({ tools: [] });
    expect(reports).toHaveLength(10);
  });
});

describe("hostCompatCatalogEnvelopeSchema forward-compat", () => {
  const bundled = () => clone(bundledHostCompatCatalog());

  it("parses a well-formed envelope", () => {
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(
      envelopeFor(bundled(), { source: "live" })
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe(7);
      expect(parsed.data.source).toBe("live");
    }
  });

  it("strips unknown keys instead of failing", () => {
    const catalog = bundled() as Record<string, unknown>;
    catalog.futureTopLevelField = { anything: true };
    (catalog.marketHosts as Record<string, unknown>[])[0].futureHostField = 1;
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(
      envelopeFor(catalog as unknown as HostCompatCatalog)
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("futureTopLevelField" in parsed.data.catalog).toBe(false);
      expect("futureHostField" in parsed.data.catalog.marketHosts[0]).toBe(
        false
      );
    }
  });

  it("filters unknown display modes and absorbs widened enums", () => {
    const catalog = bundled();
    (catalog.capabilitiesById.claude.availableDisplayModes as string[]).push(
      "holodeck"
    );
    (catalog.marketHosts[0] as Record<string, unknown>).provenance =
      "future-source";
    (
      catalog.capabilitiesById.claude as Record<string, unknown>
    ).widgetDisplayModeRequests = "future-policy";
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(
      envelopeFor(catalog)
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        parsed.data.catalog.capabilitiesById.claude.availableDisplayModes
      ).toEqual(["inline", "fullscreen", "pip"]);
      expect(parsed.data.catalog.marketHosts[0].provenance).toBe("assumed");
      expect(
        parsed.data.catalog.capabilitiesById.claude.widgetDisplayModeRequests
      ).toBeUndefined();
    }
  });

  it("fails whole-parse on structurally invalid catalogs (no partial apply)", () => {
    const catalog = bundled() as Record<string, unknown>;
    catalog.marketHosts = "not-an-array";
    expect(
      hostCompatCatalogEnvelopeSchema.safeParse(
        envelopeFor(catalog as unknown as HostCompatCatalog)
      ).success
    ).toBe(false);
  });

  it("rejects an unsupported (future breaking) schemaVersion", () => {
    expect(
      hostCompatCatalogEnvelopeSchema.safeParse(
        envelopeFor(bundled(), { schemaVersion: 2 })
      ).success
    ).toBe(false);
  });

  it("preserves an 'observed' provenance instead of downgrading it", () => {
    const catalog = bundled();
    (catalog.marketHosts[0] as Record<string, unknown>).provenance = "observed";
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(
      envelopeFor(catalog)
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.catalog.marketHosts[0].provenance).toBe("observed");
    }
  });
});

describe("fetchHostCompatCatalog", () => {
  const okResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("returns the parsed catalog on success (source defaults to live)", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse(envelopeFor(clone(bundledHostCompatCatalog())))
    );
    const result = await fetchHostCompatCatalog({
      baseUrl: "http://localhost:9/api/v1",
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, version: 7, source: "live" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:9/api/v1/host-catalog",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("maps non-2xx to unavailable", async () => {
    const result = await fetchHostCompatCatalog({
      fetchImpl: async () => new Response("{}", { status: 503 }),
    });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("maps parse failures to invalid", async () => {
    expect(
      await fetchHostCompatCatalog({
        fetchImpl: async () => okResponse({ nope: true }),
      })
    ).toEqual({ ok: false, reason: "invalid" });
    expect(
      await fetchHostCompatCatalog({
        fetchImpl: async () => new Response("not json", { status: 200 }),
      })
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("maps thrown fetch errors to network", async () => {
    const result = await fetchHostCompatCatalog({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(result).toEqual({ ok: false, reason: "network" });
  });

  it("maps aborts to timeout and never throws", async () => {
    const result = await fetchHostCompatCatalog({
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        }),
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
