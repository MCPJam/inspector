import { describe, expect, it, vi } from "vitest";
import {
  checkHostCompatibilityOperation,
  PlatformApiClient,
} from "../../src/platform/index.js";

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

  it("stops and reports truncated when a server loops an empty-string cursor", async () => {
    // No repeated-cursor guard existed here before `""` became a
    // continuation, so a looping server would have re-requested the same page
    // up to HOST_COMPAT_TOOLS_PAGE_CAP times.
    const seen: Array<string | undefined> = [];
    const client = makePagingClient(
      () => ({ items: [{ name: "a", _meta: {} }], nextCursor: "" }),
      seen,
    );

    const result = await checkHostCompatibilityOperation.execute(
      { project: "Proj", server: "Echo" },
      { client },
    );

    // Two requests, not HOST_COMPAT_TOOLS_PAGE_CAP of them — the guard tripped
    // on the second occurrence of `""`.
    expect(seen).toEqual([undefined, ""]);
    // And the stop is not silent: an incomplete read marks the tool list
    // unknown, which demotes every `works` verdict rather than certifying a
    // listing this walk never finished.
    expect(result.unknownDimensions.length).toBeGreaterThan(0);
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
