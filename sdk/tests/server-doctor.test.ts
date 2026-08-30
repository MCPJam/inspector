import {
  collectConnectedServerDoctorState,
  runServerDoctor,
} from "../src/server-doctor";
import type { ProbeMcpServerResult } from "../src/server-probe";

function createProbeResult(
  overrides: Partial<ProbeMcpServerResult> = {}
): ProbeMcpServerResult {
  return {
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: {
      selected: "streamable-http",
      attempts: [],
    },
    oauth: {
      required: false,
      optional: false,
      registrationStrategies: [],
    },
    initialize: {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
      capabilities: { tools: {} },
    },
    ...overrides,
  };
}

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    listTools: jest.fn().mockResolvedValue({
      tools: [
        {
          name: "echo",
          description: "Echo input",
          _meta: { title: "Echo" },
        },
      ],
    }),
    listResources: jest
      .fn()
      .mockResolvedValue({ resources: [{ uri: "file://note", name: "Note" }] }),
    listPrompts: jest
      .fn()
      .mockResolvedValue({ prompts: [{ name: "summarize" }] }),
    listResourceTemplates: jest
      .fn()
      .mockResolvedValue({
        resourceTemplates: [{ uriTemplate: "note://{id}" }],
      }),
    getInitializationInfo: jest.fn().mockReturnValue({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
    }),
    getServerCapabilities: jest
      .fn()
      .mockReturnValue({ tools: {}, resources: {}, prompts: {} }),
    ...overrides,
  } as any;
}

describe("collectConnectedServerDoctorState", () => {
  it("collects connected server state and metadata", async () => {
    const manager = createMockManager();

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.initInfo).toEqual({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
    });
    expect(result.capabilities).toEqual({
      tools: {},
      resources: {},
      prompts: {},
    });
    expect(result.tools).toEqual([{ name: "echo", description: "Echo input" }]);
    expect(result.toolsMetadata).toEqual({ echo: { title: "Echo" } });
    expect(result.resources).toEqual([{ uri: "file://note", name: "Note" }]);
    expect(result.prompts).toEqual([{ name: "summarize" }]);
    expect(result.resourceTemplates).toEqual([{ uriTemplate: "note://{id}" }]);
    expect(result.checks.tools.status).toBe("ok");
    expect(result.errors).toEqual([]);
  });

  it("marks unsupported resource templates as skipped", async () => {
    const manager = createMockManager({
      listResourceTemplates: jest
        .fn()
        .mockRejectedValue(new Error("Method resources/templates not found")),
    });

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.resourceTemplates).toEqual({
      status: "skipped",
      detail: "Server does not support resources/templates.",
    });
    expect(result.errors).toEqual([]);
  });
});

describe("the skills check", () => {
  const SKILL_URI = "skill://demo/good/SKILL.md";
  const MARKDOWN = `---\nname: good\ndescription: A verifiable skill.\n---\n# Good\n`;

  async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text)
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function skillsManager(options: { tamper?: boolean } = {}) {
    const entry = {
      uri: SKILL_URI,
      frontmatter: { name: "good", description: "A verifiable skill." },
      resources: [
        {
          uri: SKILL_URI,
          digest: `sha256:${await sha256(
            options.tamper ? "different bytes entirely" : MARKDOWN
          )}`,
          size: new TextEncoder().encode(MARKDOWN).byteLength,
        },
      ],
    };
    return createMockManager({
      getSkillsSupport: jest.fn().mockReturnValue({
        declared: true,
        advertised: true,
        directoryRead: false,
        active: true,
      }),
      listServerSkills: jest.fn().mockResolvedValue({ skills: [entry] }),
      getServerSkill: jest.fn().mockResolvedValue(entry),
      readResource: jest.fn().mockResolvedValue({
        contents: [
          { uri: SKILL_URI, text: MARKDOWN, mimeType: "text/markdown" },
        ],
      }),
    });
  }

  const markdownFor = (name: string) =>
    `---\nname: ${name}\ndescription: Skill ${name}.\n---\n# ${name}\n`;

  /** A server serving `count` distinct, individually verifiable skills. */
  async function manySkillsManager(count: number) {
    const entries = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const name = `skill-${index + 1}`;
        const uri = `skill://demo/${name}/SKILL.md`;
        const markdown = markdownFor(name);
        return {
          uri,
          frontmatter: { name, description: `Skill ${name}.` },
          resources: [
            {
              uri,
              digest: `sha256:${await sha256(markdown)}`,
              size: new TextEncoder().encode(markdown).byteLength,
            },
          ],
        };
      })
    );
    const byUri = new Map(entries.map((entry) => [entry.uri, entry]));
    return createMockManager({
      getSkillsSupport: jest.fn().mockReturnValue({
        declared: true,
        advertised: true,
        directoryRead: false,
        active: true,
      }),
      listServerSkills: jest.fn().mockResolvedValue({ skills: entries }),
      getServerSkill: jest
        .fn()
        .mockImplementation(async (_serverId: string, uri: string) =>
          byUri.get(uri)
        ),
      readResource: jest
        .fn()
        .mockImplementation(
          async (_serverId: string, params: { uri: string }) => ({
            contents: [
              {
                uri: params.uri,
                text: markdownFor(params.uri.split("/").at(-2) as string),
                mimeType: "text/markdown",
              },
            ],
          })
        ),
    });
  }

  it("says how much of the catalog it actually sampled", async () => {
    // The cap is deliberate, so it has to be visible. "8 skills discovered. 5
    // verified" reads as "only 5 of them check out" — a far worse claim about
    // the server than the true one, which is that the doctor stopped at 5.
    const manager = await manySkillsManager(8);

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.skills.status).toBe("ok");
    expect(result.checks.skills.detail).toContain("5 of 8 sampled and verified");
    expect(result.skills).toHaveLength(8);
  });

  it("does not claim a sample when it verified the whole catalog", async () => {
    const manager = await manySkillsManager(2);

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.skills.detail).toContain("2 verified");
    expect(result.checks.skills.detail).not.toContain("sampled");
  });

  it("skips when the extension was never negotiated", async () => {
    // Most servers serve no skills. Reporting that as a failure would make the
    // doctor cry wolf on almost every run.
    const manager = createMockManager({
      getSkillsSupport: jest.fn().mockReturnValue({
        declared: false,
        advertised: true,
        directoryRead: false,
        active: false,
      }),
    });

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.skills.status).toBe("skipped");
    expect(result.checks.skills.detail).toContain("does not declare");
    expect(result.skills).toEqual([]);
  });

  it("blames the capability pin, not the server, when we were the ones who did not ask", async () => {
    // `active` is the AND of two declarations, so a single message for both
    // sides reports our own omission as a fact about the server. A server
    // author running the doctor behind `--host cursor` against a server that
    // serves skills perfectly well must not read "not active" as their bug.
    const manager = createMockManager({
      getSkillsSupport: jest.fn().mockReturnValue({
        declared: true,
        advertised: false,
        directoryRead: false,
        active: false,
      }),
    });

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.skills.status).toBe("skipped");
    expect(result.checks.skills.detail).toContain("DOES declare");
    expect(result.checks.skills.detail).toContain("pinned for this run");
    // The failure this guards against is the detail reading as a server defect.
    expect(result.checks.skills.detail).not.toContain("does not declare");
  });

  it("verifies the skills it lists, rather than counting them", async () => {
    const manager = await skillsManager();

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.skills.status).toBe("ok");
    expect(result.checks.skills.detail).toContain("verified");
    expect(result.skills).toHaveLength(1);
  });

  it("fails when the listing carried entries it had to reject", async () => {
    // A REJECTED entry is a defect, unlike an `unloadable` one. Unloadable
    // means the server told the truth about something it cannot serve
    // verifiably; rejected means the manifest made no sense — here, an entry
    // pointing outside the skill's own directory, which is a containment
    // violation. Reporting `ok` because the sampled skill happened to verify
    // would tell an author their serving is fine while a conforming host drops
    // entries on the floor.
    const good = {
      uri: SKILL_URI,
      frontmatter: { name: "good", description: "A verifiable skill." },
      resources: [
        {
          uri: SKILL_URI,
          digest: `sha256:${await sha256(MARKDOWN)}`,
          size: new TextEncoder().encode(MARKDOWN).byteLength,
        },
      ],
    };
    const escaping = {
      uri: "skill://demo/other/SKILL.md",
      frontmatter: { name: "other", description: "Escapes its directory." },
      resources: [
        {
          uri: "skill://demo/elsewhere/secrets.env",
          digest: `sha256:${"0".repeat(64)}`,
          size: 1,
        },
      ],
    };
    const manager = createMockManager({
      getSkillsSupport: jest.fn().mockReturnValue({
        declared: true,
        advertised: true,
        directoryRead: false,
        active: true,
      }),
      listServerSkills: jest
        .fn()
        .mockResolvedValue({ skills: [good, escaping] }),
      getServerSkill: jest.fn().mockResolvedValue(good),
      readResource: jest.fn().mockResolvedValue({
        contents: [
          { uri: SKILL_URI, text: MARKDOWN, mimeType: "text/markdown" },
        ],
      }),
    });

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.skills.status).toBe("error");
    expect(result.checks.skills.detail).toContain("rejected as malformed");
    expect(result.checks.skills.detail).toContain("outside the skill directory");
  });

  it("reports a digest that does not match its bytes, naming the kind", async () => {
    // The reason this check exists at all: a listing looks identical whether
    // or not the content behind it verifies, so counting proves nothing. The
    // KIND is in the detail because `digest_mismatch` and `frontmatter_drift`
    // send a server author to completely different code.
    const manager = await skillsManager({ tamper: true });

    const result = await collectConnectedServerDoctorState(manager, "srv");

    expect(result.checks.skills.status).toBe("error");
    expect(result.checks.skills.detail).toContain("digest_mismatch");
  });
});

describe("runServerDoctor", () => {
  it("returns a ready report for a healthy server", async () => {
    const result = await runServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
      },
      {
        probeServer: jest.fn().mockResolvedValue(createProbeResult()),
        withManager: async (_config, fn) => fn(createMockManager(), "srv"),
      }
    );

    expect(result.status).toBe("ready");
    expect(result.target).toEqual({ label: "https://example.com/mcp" });
    expect(result.checks.probe.status).toBe("ok");
    expect(result.checks.connection.status).toBe("ok");
    expect(result.tools).toHaveLength(1);
    expect(result.resources).toHaveLength(1);
    expect(result.prompts).toHaveLength(1);
    expect(result.error).toBeNull();
  });

  it("returns oauth_required and skips connect when no credentials are supplied", async () => {
    let connected = false;

    const result = await runServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
      },
      {
        probeServer: jest.fn().mockResolvedValue(
          createProbeResult({
            status: "oauth_required",
            oauth: {
              required: true,
              optional: false,
              authorizationServerMetadataUrl:
                "https://auth.example.com/.well-known/oauth-authorization-server",
              resourceMetadataUrl:
                "https://example.com/.well-known/oauth-protected-resource",
              registrationStrategies: ["dcr", "cimd"],
            },
          })
        ),
        withManager: async () => {
          connected = true;
          throw new Error("should not connect");
        },
      }
    );

    expect(result.status).toBe("oauth_required");
    expect(result.checks.probe.status).toBe("error");
    expect(result.checks.connection.status).toBe("skipped");
    expect(result.error?.code).toBe("OAUTH_REQUIRED");
    expect(connected).toBe(false);
  });

  it("continues after an oauth_required probe when credentials are present in headers", async () => {
    let connected = false;

    const result = await runServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          requestInit: {
            headers: {
              Authorization: "Bearer oauth-token",
            },
          },
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
      },
      {
        probeServer: jest.fn().mockResolvedValue(
          createProbeResult({
            status: "oauth_required",
            oauth: {
              required: true,
              optional: false,
              registrationStrategies: ["dcr"],
            },
          })
        ),
        withManager: async (_config, fn) => {
          connected = true;
          return fn(createMockManager(), "srv");
        },
      }
    );

    expect(connected).toBe(true);
    expect(result.status).toBe("ready");
    expect(result.checks.probe.status).toBe("ok");
    expect(result.checks.probe.detail).toMatch(
      /continuing with provided credentials/i
    );
    // A compliant 401 leaves no status note behind.
    expect(result.checks.probe.detail).not.toMatch(/HTTP 4\d\d/);
  });

  it("names a challenge status the probe accepted but MCP does not allow", async () => {
    const result = await runServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          requestInit: {
            headers: {
              Authorization: "Bearer oauth-token",
            },
          },
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
      },
      {
        probeServer: jest.fn().mockResolvedValue(
          createProbeResult({
            status: "oauth_required",
            oauth: {
              required: true,
              optional: false,
              registrationStrategies: ["dcr"],
              nonCompliantChallengeStatus: 403,
            },
          })
        ),
        withManager: async (_config, fn) => fn(createMockManager(), "srv"),
      }
    );

    expect(result.checks.probe.status).toBe("ok");
    expect(result.checks.probe.detail).toMatch(/HTTP 403/);
    expect(result.checks.probe.detail).toMatch(/401 Unauthorized/);
  });

  it("passes retry policy through probe and ephemeral manager dependencies", async () => {
    const retryPolicy = {
      retries: 2,
      retryDelayMs: 250,
    };
    const probeServer = jest.fn().mockResolvedValue(createProbeResult());
    const withManager = jest.fn(
      async (_config, fn, options?: { retryPolicy?: typeof retryPolicy }) => {
        expect(options?.retryPolicy).toEqual(retryPolicy);
        return fn(createMockManager(), "srv");
      }
    );

    await runServerDoctor(
      {
        config: {
          url: "https://example.com/mcp",
          timeout: 4_000,
        },
        target: { label: "https://example.com/mcp" },
        timeout: 4_000,
        retryPolicy,
      },
      {
        probeServer,
        withManager,
      }
    );

    expect(probeServer).toHaveBeenCalledWith(
      expect.objectContaining({ retryPolicy })
    );
    expect(withManager).toHaveBeenCalled();
  });
});
