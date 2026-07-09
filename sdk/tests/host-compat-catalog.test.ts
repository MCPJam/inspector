import { describe, expect, it, vi } from "vitest";
import {
  buildHostProfilesFromCatalog,
  buildMarketHostProfiles,
  bundledHostCompatCatalog,
  evaluateMarketHosts,
  fetchHostCompatCatalog,
  getCatalogHost,
  getCatalogHosts,
  getCatalogTemplate,
  getTemplateMcpAppsCapabilities,
  hostCompatCatalogEnvelopeSchema,
  hostCompatCatalogSchema,
  type HostCompatCatalog,
} from "../src/host-compat/index";
import { BUNDLED_HOST_COMPAT_CATALOG } from "../src/host-compat/catalog.generated";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const minimalHost = (
  hostStyle: string,
  rendersOpenAiApps = false,
  metadata: Partial<
    Pick<
      HostCompatCatalog["hostsById"][string],
      "label" | "provenance" | "rendersMcpApps"
    >
  > = {}
): HostCompatCatalog["hostsById"][string] => ({
  id: hostStyle,
  label: metadata.label ?? hostStyle,
  provenance: metadata.provenance ?? "assumed",
  rendersMcpApps: metadata.rendersMcpApps ?? true,
  hostStyle,
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "",
  temperature: 0.7,
  requireToolApproval: false,
  respectToolVisibility: true,
  progressiveToolDiscovery: false,
  serverIds: [],
  optionalServerIds: [],
  builtInToolIds: [],
  connectionDefaults: { headers: {}, requestTimeout: 10000 },
  clientCapabilities: {},
  hostContext: {},
  ...(rendersOpenAiApps
    ? {
        mcpProfile: {
          profileVersion: 1,
          apps: { compatRuntime: { openaiApps: true } },
        },
      }
    : {}),
});

const envelopeFor = (catalog: HostCompatCatalog, extra?: object) => ({
  schemaVersion: 2,
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
    expect(Object.isFrozen(catalog.hostsById.claude)).toBe(true);
    expect(Object.isFrozen(catalog.hostsById.mcpjam)).toBe(true);
    expect(
      Object.isFrozen(
        catalog.hostsById.claude.mcpProfile?.apps?.mcpAppsOverrides
      )
    ).toBe(true);
  });

  it("parses under the catalog schema (lockstep guard: bundled ⊆ wire shape)", () => {
    // JSON round-trip strips `undefined` optionals the way the wire would.
    const parsed = hostCompatCatalogSchema.safeParse(
      clone(bundledHostCompatCatalog())
    );
    expect(parsed.success).toBe(true);
  });

  it("includes full creation templates for market and non-market hosts", () => {
    const catalog = bundledHostCompatCatalog();
    expect(getCatalogTemplate(catalog, "claude")?.hostStyle).toBe("claude");
    expect(getCatalogTemplate(catalog, "mcpjam")?.hostStyle).toBe("mcpjam");
    expect(getCatalogTemplate(catalog, "claude-code")?.hostStyle).toBe(
      "claude-code"
    );
    expect(getTemplateMcpAppsCapabilities(catalog, "mcpjam")).toMatchObject({
      serverTools: true,
      message: true,
    });
    expect(getTemplateMcpAppsCapabilities(catalog, "claude")).toMatchObject({
      serverTools: true,
      message: true,
    });
  });

  it("uses template image fields as source and derives imageSupport for profiles", () => {
    const catalog = bundledHostCompatCatalog();
    const rawGeneratedHost = BUNDLED_HOST_COMPAT_CATALOG.hostsById.notion;
    const host = getCatalogHost(catalog, "notion");
    const template = getCatalogTemplate(catalog, "notion");
    expect(rawGeneratedHost).not.toHaveProperty("imageSupport");
    expect(rawGeneratedHost.modelVisibleMcpToolResults).toMatchObject({
      directContent: { image: false },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: false } },
    });
    expect(rawGeneratedHost.mcpToolResultImageRendering).toMatchObject({
      placement: "collapsed",
      directContent: { image: true },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: false } },
    });
    expect(host?.modelVisibleMcpToolResults).toMatchObject({
      directContent: { image: false },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: false } },
    });
    expect(host?.mcpToolResultImageRendering).toMatchObject({
      placement: "collapsed",
      directContent: { image: true },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: false } },
    });
    expect(template?.modelVisibleMcpToolResults).toMatchObject({
      directContent: { image: false },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: false } },
    });
    expect(template?.mcpToolResultImageRendering).toMatchObject({
      placement: "collapsed",
      directContent: { image: true },
      embeddedResources: { blob: { image: false } },
      linkedResources: { blob: { image: false } },
    });
    expect(host?.imageSupport).toMatchObject({
      toolImageContent: { model: false, ui: true },
      embeddedResourceImages: { model: false, ui: false },
      resourceLinkImages: { model: false, ui: false },
      placement: "collapsed",
    });
  });

  it("returns mutable template copies without mutating the catalog", () => {
    const catalog = bundledHostCompatCatalog();
    const template = getCatalogTemplate(catalog, "claude");
    expect(template).toBeDefined();
    template!.hostContext.theme = "mutated-theme";
    template!.serverIds.push("local-server");

    expect(getCatalogHost(catalog, "claude")?.hostContext.theme).not.toBe(
      "mutated-theme"
    );
    expect(getCatalogHost(catalog, "claude")?.serverIds).toEqual([]);
  });
});

describe("buildHostProfilesFromCatalog", () => {
  it("deep-equals buildMarketHostProfiles() on the bundled catalog (lockstep guard)", () => {
    expect(buildHostProfilesFromCatalog(bundledHostCompatCatalog())).toEqual(
      buildMarketHostProfiles()
    );
  });

  it("carries per-host imageSupport (incl. model-vs-ui splits)", () => {
    const by = (id: string) =>
      buildMarketHostProfiles().find((p) => p.id === id)?.imageSupport;
    // ChatGPT renders all three inline.
    expect(by("chatgpt")).toMatchObject({
      toolImageContent: { model: true, ui: true },
      resourceLinkImages: { model: true, ui: true },
      placement: "inline",
    });
    // Cursor: model sees images but the UI shows none.
    expect(by("cursor")).toMatchObject({
      toolImageContent: { model: true, ui: false },
      placement: "none",
    });
    // Notion: UI shows the tool image (collapsed) even though the model doesn't.
    expect(by("notion")).toMatchObject({
      toolImageContent: { model: false, ui: true },
      placement: "collapsed",
    });
    // Slackbot: nothing.
    expect(by("slack")?.placement).toBe("none");
  });

  it("carries per-host verifiedAt into profiles and reports", () => {
    const catalog = bundledHostCompatCatalog();
    const expected = catalog.hostsById.mistral.verifiedAt;
    expect(typeof expected).toBe("number");
    expect(
      buildMarketHostProfiles().find((p) => p.id === "mistral")?.verifiedAt
    ).toBe(expected);
    expect(
      evaluateMarketHosts({ tools: [] }).reports.find(
        (r) => r.hostId === "mistral"
      )?.verifiedAt
    ).toBe(expected);
  });

  it("keeps rendersOpenAiApps independent of rendersMcpApps (NOT &&-gated)", () => {
    const catalog: HostCompatCatalog = {
      hostsById: {
        // Headless host with OpenAI compat on — still rendersOpenAiApps,
        // therefore rendersWidgets, therefore gets a capability matrix.
        ghostwriter: minimalHost("ghostwriter", true, {
          label: "Ghostwriter",
          rendersMcpApps: false,
        }),
      },
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
      hostsById: {
        headless: minimalHost("headless", false, {
          label: "Headless",
          provenance: "probe",
          rendersMcpApps: false,
        }),
      },
    };
    expect(
      buildHostProfilesFromCatalog(catalog)[0].capabilities
    ).toBeUndefined();
  });

  it("falls back to no-claims for a host id colliding with a prototype key", () => {
    const catalog: HostCompatCatalog = {
      hostsById: {
        constructor: minimalHost("constructor", false, {
          label: "Constructor",
          provenance: "probe",
        }),
      },
    };
    const [profile] = buildHostProfilesFromCatalog(catalog);
    expect(profile.capabilities).toBeDefined();
    expect(profile.capabilities?.serverTools).toBe(false);
    expect(typeof profile.capabilities).toBe("object");
    expect(
      getCatalogTemplate({ hostsById: {} }, "constructor")
    ).toBeUndefined();
  });

  it("does not treat a missing compatRuntime as OpenAI compatible", () => {
    const catalog: HostCompatCatalog = {
      hostsById: {
        toString: minimalHost("toString", false, {
          label: "Prototype",
          provenance: "probe",
          rendersMcpApps: false,
        }),
      },
    };
    const [profile] = buildHostProfilesFromCatalog(catalog);
    expect(profile.rendersOpenAiApps).toBe(false);
    // Headless + not OpenAI-compat ⇒ no capability matrix.
    expect(profile.capabilities).toBeUndefined();
  });

  it("does not freeze or mutate the caller's catalog", () => {
    // A catalog from fetchHostCompatCatalog may be cached/reused by the caller;
    // building profiles from it must not freeze the caller's own object.
    const catalog = clone(bundledHostCompatCatalog()) as HostCompatCatalog;
    buildHostProfilesFromCatalog(catalog);
    expect(Object.isFrozen(catalog)).toBe(false);
    expect(
      Object.isFrozen(
        catalog.hostsById.claude.mcpProfile?.apps?.mcpAppsOverrides
      )
    ).toBe(false);
    expect(Object.isFrozen(catalog.hostsById.claude)).toBe(false);
  });

  it("returns independent, mutable profile copies", () => {
    const profiles = buildHostProfilesFromCatalog(
      clone(bundledHostCompatCatalog())
    );
    // Editing an output profile can't leak into a later build.
    profiles[0].label = "edited";
    expect(
      buildHostProfilesFromCatalog(clone(bundledHostCompatCatalog()))[0].label
    ).not.toBe("edited");
  });
});

describe("evaluateMarketHosts with a catalog", () => {
  it("threads options.catalog into the evaluation", () => {
    const catalog: HostCompatCatalog = {
      hostsById: {
        solo: minimalHost("solo", false, {
          label: "Solo",
          provenance: "probe",
        }),
      },
    };
    const { reports } = evaluateMarketHosts({ tools: [] }, { catalog });
    expect(reports.map((r) => r.hostId)).toEqual(["solo"]);
  });

  it("defaults to the bundled catalog when no catalog is passed", () => {
    const { reports } = evaluateMarketHosts({ tools: [] });
    // Derive from the bundled catalog so this stays a behavioral check rather
    // than a snapshot of the exact host count.
    expect(reports).toHaveLength(
      getCatalogHosts(bundledHostCompatCatalog()).length
    );
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
    const hostsById = catalog.hostsById as Record<
      string,
      Record<string, unknown>
    >;
    hostsById.claude.futureHostField = 1;
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(
      envelopeFor(catalog as unknown as HostCompatCatalog)
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("futureTopLevelField" in parsed.data.catalog).toBe(false);
      expect("futureHostField" in parsed.data.catalog.hostsById.claude).toBe(
        false
      );
    }
  });

  it("absorbs widened provenance enums", () => {
    const catalog = bundled();
    (catalog.hostsById.claude as Record<string, unknown>).provenance =
      "future-source";
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(
      envelopeFor(catalog)
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.catalog.hostsById.claude.provenance).toBe("assumed");
    }
  });

  it("fails whole-parse on structurally invalid catalogs (no partial apply)", () => {
    const catalog = bundled() as Record<string, unknown>;
    catalog.hostsById = "not-an-object";
    expect(
      hostCompatCatalogEnvelopeSchema.safeParse(
        envelopeFor(catalog as unknown as HostCompatCatalog)
      ).success
    ).toBe(false);
  });

  it("rejects templates with invalid type-level fields", () => {
    const missingRespect = bundled();
    delete (missingRespect.hostsById.claude as Record<string, unknown>)
      .respectToolVisibility;
    expect(
      hostCompatCatalogEnvelopeSchema.safeParse(envelopeFor(missingRespect))
        .success
    ).toBe(false);

    const nullComputer = bundled();
    (nullComputer.hostsById.claude as Record<string, unknown>).computer = null;
    expect(
      hostCompatCatalogEnvelopeSchema.safeParse(envelopeFor(nullComputer))
        .success
    ).toBe(false);
  });

  it("rejects an unsupported (future breaking) schemaVersion", () => {
    expect(
      hostCompatCatalogEnvelopeSchema.safeParse(
        envelopeFor(bundled(), { schemaVersion: 3 })
      ).success
    ).toBe(false);
  });

  it("preserves an 'observed' provenance instead of downgrading it", () => {
    const catalog = bundled();
    (catalog.hostsById.claude as Record<string, unknown>).provenance =
      "observed";
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(
      envelopeFor(catalog)
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.catalog.hostsById.claude.provenance).toBe("observed");
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    expect(warnSpy).toHaveBeenCalledWith(
      "[host-catalog] rejected live catalog envelope",
      expect.objectContaining({ reason: "invalid_envelope" })
    );
    warnSpy.mockRestore();
  });

  it("warns specifically when the live catalog schema version is unsupported", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fetchHostCompatCatalog({
      fetchImpl: async () =>
        okResponse(
          envelopeFor(bundledHostCompatCatalog(), { schemaVersion: 3 })
        ),
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(warnSpy).toHaveBeenCalledWith(
      "[host-catalog] rejected live catalog envelope",
      expect.objectContaining({
        reason: "schema_version_mismatch",
        schemaVersion: 3,
        expectedSchemaVersion: 2,
      })
    );
    warnSpy.mockRestore();
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
