import { describe, expect, it, vi } from "vitest";
import {
  checkHostCompatibilityOperation,
  PlatformApiClient,
} from "../../src/platform/index.js";
import { toolResultAuthChallengeFindings } from "../../src/platform/operations.js";
import { bundledHostCompatCatalog } from "../../src/host-compat/index.js";
import {
  AUTH_CHALLENGE_POLICY_DEFAULTS,
  authChallengePolicyFrom,
} from "../../src/mcp-client-manager/auth-challenge.js";

const PROJECT = {
  id: "p1",
  name: "Proj",
  description: null,
  icon: null,
  organizationId: "o1",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

const HTTP_SERVER = {
  id: "s1",
  projectId: "p1",
  name: "Echo",
  enabled: true,
  transportType: "http",
  url: "https://echo.example/mcp",
  useOAuth: false,
  hasClientSecret: false,
  createdAt: null,
  updatedAt: null,
};

/** A PlatformApiClient whose fetch serves one widget tool + its resource HTML. */
function makeClient(toolMeta: Record<string, unknown>, resourceHtml: string) {
  const fetchMock = vi.fn(async (target: unknown) => {
    const path = new URL(String(target)).pathname;
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (/\/servers$/.test(path)) return Response.json({ items: [HTTP_SERVER] });
    // Single page (no nextCursor) — a raw MCP tool carries `_meta` inline.
    if (/\/servers\/[^/]+\/tools$/.test(path)) {
      return Response.json({ items: [{ name: "chart", _meta: toolMeta }] });
    }
    if (/\/servers\/[^/]+\/resources\/read$/.test(path)) {
      return Response.json({ contents: [{ text: resourceHtml }] });
    }
    return Response.json({ code: "NOT_FOUND", message: path }, { status: 404 });
  });
  return new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

const verdictById = (
  result: Awaited<ReturnType<typeof checkHostCompatibilityOperation.execute>>,
) => Object.fromEntries(result.hosts.map((h) => [h.hostId, h.verdict]));

describe("checkHostCompatibilityOperation — pagination", () => {
  /** Serves `tools/list` pages driven by an explicit cursor -> page script. */
  function makePagingClient(
    pageFor: (cursor: string | undefined) => Record<string, unknown>,
    seen: Array<string | undefined>,
  ) {
    const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
      const path = new URL(String(target)).pathname;
      if (path === "/api/v1/projects")
        return Response.json({ items: [PROJECT] });
      if (/\/servers$/.test(path))
        return Response.json({ items: [HTTP_SERVER] });
      if (/\/servers\/[^/]+\/tools$/.test(path)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          cursor?: string;
        };
        seen.push(body.cursor);
        return Response.json(pageFor(body.cursor));
      }
      return Response.json(
        { code: "NOT_FOUND", message: path },
        { status: 404 },
      );
    });
    return new PlatformApiClient({
      baseUrl: "https://api.example.com/api/v1",
      getAuth: () => "sk_test",
      fetch: fetchMock as unknown as typeof fetch,
    });
  }

  // This walk is *specifically* the "does this client follow nextCursor"
  // traversal, so reading `""` as the end would make host-compat report on a
  // listing it truncated itself. MCP 2026-07-28 `server/utilities/pagination`:
  // "an empty string is a valid cursor and thus MUST NOT be treated as the end
  // of results".
  it("follows an empty-string cursor and forwards it verbatim", async () => {
    const seen: Array<string | undefined> = [];
    const client = makePagingClient(
      (cursor) =>
        cursor === undefined
          ? { items: [{ name: "a", _meta: {} }], nextCursor: "" }
          : { items: [{ name: "b", _meta: {} }] },
      seen,
    );

    const result = await checkHostCompatibilityOperation.execute(
      { project: "Proj", server: "Echo" },
      { client },
    );

    // Page two was fetched with the empty-string cursor, and the walk reached
    // a real end — so nothing is reported as unread.
    expect(seen).toEqual([undefined, ""]);
    expect(result.unknownDimensions).toEqual([]);
  });

  // A repeated cursor is FOLLOWED, not read as an ending — comparing two
  // cursors for equality is a determination based on cursor value, which the
  // spec forbids, and a constant token (`""` included) is legal. The page cap
  // is the bound, and hitting it demotes the verdicts rather than certifying a
  // listing the walk never finished.
  it("keeps walking a constant cursor to the page cap and reports the read as incomplete", async () => {
    for (const constant of ["", "same-token-forever"]) {
      const seen: Array<string | undefined> = [];
      const client = makePagingClient(
        () => ({ items: [{ name: "a", _meta: {} }], nextCursor: constant }),
        seen,
      );

      const result = await checkHostCompatibilityOperation.execute(
        { project: "Proj", server: "Echo" },
        { client },
      );

      // Not truncated at page two; bounded by our own cap instead.
      expect(seen.length).toBeGreaterThan(2);
      expect(result.unknownDimensions.length).toBeGreaterThan(0);
    }
  });
});

describe("checkHostCompatibilityOperation", () => {
  it("returns per-host verdicts for a widget server", async () => {
    const client = makeClient(
      { ui: { resourceUri: "ui://chart" } },
      "<div>just markup</div>",
    );
    const result = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      { client },
    );
    expect(result.server.name).toBe("Echo");
    expect(result.widgets.total).toBe(1);
    const byId = verdictById(result);
    expect(byId.claude).toBe("works"); // renders MCP Apps + clean scan
    // Codex renders MCP Apps as of the 2026-08-19 probe (same runtime as
    // ChatGPT), so it is no longer the headless example here.
    expect(byId.codex).toBe("works");
    expect(byId.perplexity).toBe("degraded"); // headless → falls back to text
  });

  it("scans the widget HTML and surfaces capability findings", async () => {
    const client = makeClient(
      { ui: { resourceUri: "ui://chart" } },
      "window.openai.sendFollowUpMessage()", // → needs `message`
    );
    const result = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      { client },
    );
    const cursor = result.hosts.find((h) => h.hostId === "cursor");
    expect(cursor?.verdict).toBe("degraded"); // Cursor lacks `message`
    expect(
      cursor?.findings.some((f) => f.code === "capability_unsupported"),
    ).toBe(true);
    // Claude supports `message` → still works.
    expect(verdictById(result).claude).toBe("works");
  });
});

describe("checkHostCompatibilityOperation — tool-result sign-in challenges", () => {
  /** A client whose `tools/list` serves exactly `tools`, as raw MCP tools. */
  function makeToolsClient(tools: Array<Record<string, unknown>>) {
    const fetchMock = vi.fn(async (target: unknown) => {
      const path = new URL(String(target)).pathname;
      if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
      if (/\/servers$/.test(path)) return Response.json({ items: [HTTP_SERVER] });
      if (/\/servers\/[^/]+\/tools$/.test(path)) return Response.json({ items: tools });
      return Response.json({ code: "NOT_FOUND", message: path }, { status: 404 });
    });
    return new PlatformApiClient({
      baseUrl: "https://api.example.com/api/v1",
      getAuth: () => "sk_test",
      fetch: fetchMock as unknown as typeof fetch,
    });
  }

  /** What each bundled host resolves `toolResultAuthChallenge` to. */
  function resolvedActionById(): Record<string, string> {
    return Object.fromEntries(
      Object.values(bundledHostCompatCatalog().hostsById).map((host) => [
        host.id,
        authChallengePolicyFrom(host.mcpProfile)?.toolResultAuthChallenge ??
          AUTH_CHALLENGE_POLICY_DEFAULTS.toolResultAuthChallenge,
      ]),
    );
  }

  const finding = (
    host: { findings: Array<{ code: string }> } | undefined,
  ) => host?.findings.find((f) => f.code === "tool_result_auth_challenge_ignored");

  it("keeps top-level securitySchemes and warns exactly the passthrough hosts", async () => {
    const result = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      {
        client: makeToolsClient([
          { name: "get_weather", securitySchemes: [{ type: "noauth" }] },
          {
            name: "get_orders",
            securitySchemes: [{ type: "oauth2", scopes: ["orders:read"] }],
          },
        ]),
      },
    );
    const actions = resolvedActionById();
    expect(Object.values(actions)).toContain("passthrough");
    for (const host of result.hosts) {
      const warned = finding(host);
      if (actions[host.hostId] === "passthrough") {
        expect(warned, host.hostId).toMatchObject({
          lane: "server",
          severity: "info",
          tools: ["get_orders"],
        });
        expect((warned as { detail: string }).detail).toMatch(
          /as an ordinary error/,
        );
        expect((warned as { remediation: string }).remediation).toMatch(
          /HTTP 401 and a `WWW-Authenticate: Bearer/,
        );
      } else {
        expect(warned, host.hostId).toBeUndefined();
      }
    }
  });

  it("reads a declaration carried in _meta.securitySchemes", async () => {
    const result = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      {
        client: makeToolsClient([
          {
            name: "get_orders",
            _meta: { securitySchemes: [{ type: "oauth2", scopes: [] }] },
          },
        ]),
      },
    );
    const passthroughHost = result.hosts.find(
      (host) => resolvedActionById()[host.hostId] === "passthrough",
    );
    expect(finding(passthroughHost)).toMatchObject({ tools: ["get_orders"] });
  });

  it("says nothing for public-only tools, and never moves a verdict", async () => {
    const tools = [{ name: "get_weather", securitySchemes: [{ type: "noauth" }] }];
    const plain = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      { client: makeToolsClient([{ name: "get_weather" }]) },
    );
    const declared = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      { client: makeToolsClient(tools) },
    );
    expect(declared.hosts.every((host) => finding(host) === undefined)).toBe(true);
    const withOAuth = await checkHostCompatibilityOperation.execute(
      { server: "Echo" },
      {
        client: makeToolsClient([
          { name: "get_orders", securitySchemes: [{ type: "oauth2", scopes: [] }] },
        ]),
      },
    );
    expect(verdictById(withOAuth)).toEqual(verdictById(plain));
  });
});

describe("toolResultAuthChallengeFindings", () => {
  const OAUTH_TOOL = {
    name: "get_orders",
    securitySchemes: [{ type: "oauth2", scopes: ["orders:read"] }],
  };
  const host = (mcpProfile?: unknown) => ({
    hostLabel: "Example Host",
    provenance: "vendor-doc" as const,
    mcpProfile,
  });

  it("warns a host whose profile says nothing, with assumed provenance", () => {
    const [warned] = toolResultAuthChallengeFindings([OAUTH_TOOL], host({}));
    expect(warned).toMatchObject({
      code: "tool_result_auth_challenge_ignored",
      provenance: "assumed",
      tools: ["get_orders"],
    });
    expect(warned!.detail).toContain("Example Host shows a tool result carrying");
  });

  it("carries the host's provenance when passthrough is stated", () => {
    const [warned] = toolResultAuthChallengeFindings(
      [OAUTH_TOOL],
      host({ toolResultAuthChallenge: "passthrough" }),
    );
    expect(warned?.provenance).toBe("vendor-doc");
  });

  it.each(["prompt", "notify"])("does not warn a host that acts on it (%s)", (action) => {
    expect(
      toolResultAuthChallengeFindings(
        [OAUTH_TOOL],
        host({ toolResultAuthChallenge: action }),
      ),
    ).toEqual([]);
  });

  it("does not warn when no tool resolves to oauth2", () => {
    expect(
      toolResultAuthChallengeFindings(
        [
          { name: "a" },
          { name: "b", securitySchemes: [{ type: "noauth" }] },
          { name: "c", securitySchemes: "oauth2" },
        ],
        host(),
      ),
    ).toEqual([]);
  });
});
