import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import {
  listAllTools,
  listAllPrompts,
  listAllResources,
  listAllResourceTemplates,
} from "../src/operations.js";
import {
  FIXTURE_TOTAL_ITEMS,
  serveMultiPageFixtureOnPort,
  type ServedMultiPageFixture,
} from "./support/multi-page-fixture.js";
import { getWireField } from "./support/raw-capture.js";

/**
 * Phase 3 §11.1 pagination-parity evidence.
 *
 * KEY VERIFIED FACT (beta.4, `@modelcontextprotocol/client`): a no-cursor
 * `client.listTools()` / `listPrompts()` / `listResources()` /
 * `listResourceTemplates()` call does NOT return page 1 only — the client's
 * internal `_listAllPages` walks every page and returns the complete
 * aggregate, capped by `ClientOptions.listMaxPages` (default 64, which
 * THROWS on overflow). So MCPClientManager callers built on the no-cursor
 * path (`listTools`, `getTools`, `getToolsForAiSdk`, …) get every item
 * without doing anything special — the "page-1-only truncation" failure
 * mode this suite was commissioned to guard against does not exist for
 * well-behaved servers. Section (f) below covers the one case this
 * auto-aggregation does NOT protect against.
 *
 * This suite proves that aggregation with REAL wire evidence: pagination
 * happens above the transport (inside the client), so
 * `serveMultiPageFixtureOnPort`'s capture — taken at the `handler.fetch`
 * seam behind a real loopback socket — sees one genuine `tools/list` (etc.)
 * request per page, each with the correct `cursor`.
 */

describe("pagination parity — real wire evidence", () => {
  let served: ServedMultiPageFixture | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    served = undefined;
    manager = undefined;
  });

  async function connect(options?: Parameters<typeof serveMultiPageFixtureOnPort>[0]) {
    served = await serveMultiPageFixtureOnPort(options);
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", { url: served.url, timeout: 10_000 });
    return { served, manager };
  }

  function requestsFor(method: string): unknown[] {
    return served!.exchanges
      .filter((e) => getWireField(e.request.json, "method") === method)
      .map((e) => e.request.json);
  }

  // ── (a)/(b): no-cursor calls return everything, wire shows one request
  //     per page with the right cursors ──────────────────────────────────

  it("listTools(): all 12 tools, one wire request per page with correct cursors", async () => {
    const { manager } = await connect();
    const result = await manager.listTools("fixture");
    expect(result.tools.map((t) => t.name).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `tool-${i}`).sort()
    );

    const reqs = requestsFor("tools/list") as { params?: { cursor?: string } }[];
    expect(reqs).toHaveLength(3);
    expect(reqs.map((r) => r.params?.cursor)).toEqual([undefined, "page-1", "page-2"]);
  });

  it("listPrompts(): all 12 prompts, one wire request per page with correct cursors", async () => {
    const { manager } = await connect();
    const result = await manager.listPrompts("fixture");
    expect(result.prompts.map((p) => p.name).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `prompt-${i}`).sort()
    );

    const reqs = requestsFor("prompts/list") as { params?: { cursor?: string } }[];
    expect(reqs).toHaveLength(3);
    expect(reqs.map((r) => r.params?.cursor)).toEqual([undefined, "page-1", "page-2"]);
  });

  it("listResources(): all 12 resources, one wire request per page with correct cursors", async () => {
    const { manager } = await connect();
    const result = await manager.listResources("fixture");
    expect(result.resources.map((r) => r.uri).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `test://resource/${i}`).sort()
    );

    const reqs = requestsFor("resources/list") as { params?: { cursor?: string } }[];
    expect(reqs).toHaveLength(3);
    expect(reqs.map((r) => r.params?.cursor)).toEqual([undefined, "page-1", "page-2"]);
  });

  it("listResourceTemplates(): all 12 templates, one wire request per page with correct cursors", async () => {
    const { manager } = await connect();
    const result = await manager.listResourceTemplates("fixture");
    expect(result.resourceTemplates.map((t) => t.name).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `template-${i}`).sort()
    );

    const reqs = requestsFor("resources/templates/list") as { params?: { cursor?: string } }[];
    expect(reqs).toHaveLength(3);
    expect(reqs.map((r) => r.params?.cursor)).toEqual([undefined, "page-1", "page-2"]);
  });

  // ── (c): an explicit { cursor } call returns exactly ONE raw page ──────

  it("an explicit { cursor } call returns exactly one raw page with nextCursor intact", async () => {
    const { manager } = await connect();
    const page1 = await manager.listTools("fixture", { cursor: "page-1" });
    expect(page1.tools.map((t) => t.name)).toEqual(["tool-4", "tool-5", "tool-6", "tool-7"]);
    expect(page1.nextCursor).toBe("page-2");

    // Exactly one wire request, carrying the explicit cursor — the
    // single-page path does not silently walk further pages.
    const reqs = requestsFor("tools/list") as { params?: { cursor?: string } }[];
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.params?.cursor).toBe("page-1");
  });

  // ── (d): getTools()/getToolsForAiSdk() surface every page ──────────────

  it("getTools() surfaces every tool from every page", async () => {
    const { manager } = await connect();
    const tools = await manager.getTools(["fixture"]);
    expect(tools.map((t) => t.name).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `tool-${i}`).sort()
    );
  });

  it("getToolsForAiSdk() surfaces every tool from every page", async () => {
    const { manager } = await connect();
    const aiTools = await manager.getToolsForAiSdk(["fixture"]);
    expect(Object.keys(aiTools).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `tool-${i}`).sort()
    );
  });

  // ── (e): operations.ts listAll* helpers still return complete sets ─────

  it("operations.listAllTools returns the complete set", async () => {
    const { manager } = await connect();
    const { tools } = await listAllTools(manager, { serverId: "fixture" });
    expect(tools.map((t) => t.name).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `tool-${i}`).sort()
    );
  });

  it("operations.listAllPrompts returns the complete set", async () => {
    const { manager } = await connect();
    const { prompts } = await listAllPrompts(manager, { serverId: "fixture" });
    expect(prompts.map((p) => p.name).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `prompt-${i}`).sort()
    );
  });

  it("operations.listAllResources returns the complete set", async () => {
    const { manager } = await connect();
    const { resources } = await listAllResources(manager, { serverId: "fixture" });
    expect(resources.map((r) => r.uri).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `test://resource/${i}`).sort()
    );
  });

  it("operations.listAllResourceTemplates returns the complete set", async () => {
    const { manager } = await connect();
    const { resourceTemplates, unsupported } = await listAllResourceTemplates(manager, {
      serverId: "fixture",
    });
    expect(unsupported).toBeUndefined();
    expect(resourceTemplates.map((t) => t.name).sort()).toEqual(
      Array.from({ length: FIXTURE_TOTAL_ITEMS }, (_, i) => `template-${i}`).sort()
    );
  });

  // ── (f): a non-converging (repeated-cursor) server ──────────────────────
  //
  // VERIFIED BEHAVIOR (differs from the "guard throws" assumption this test
  // was originally commissioned to prove): the vendor client's
  // `_listAllPages` walk (`@modelcontextprotocol/client` dist/index.mjs,
  // `while (cursor !== void 0 && !seen.has(cursor))`) treats a REPEATED
  // `nextCursor` as "stop, return what we have" — silently, with no thrown
  // error and no signal in the returned object that the aggregate is
  // partial. Only `listMaxPages` overflow (a cursor sequence that never
  // repeats but also never ends) throws
  // `SdkErrorCode.ListPaginationExceeded`.
  //
  // `operations.ts`'s own `drainPaginatedList` DOES contain a
  // repeated-cursor throw — but it never fires for `listAllTools` /
  // `listAllPrompts` / `listAllResources` / `listAllResourceTemplates`,
  // because their FIRST `fetchPage(undefined)` call already goes through
  // the client's no-cursor auto-aggregate path, which exhausts (or, here,
  // truncates) pagination internally before `drainPaginatedList` ever sees
  // a `nextCursor` to walk. See the PR description for the full writeup —
  // this is a real, verified gap, not a test artifact.
  it("manager.listTools(): a repeated cursor silently truncates (matches the vendor client's documented behavior)", async () => {
    const { manager } = await connect({ malformedCursor: true });
    const result = await manager.listTools("fixture");
    // Page 1 (4 items) + page 2 (4 items, whose nextCursor repeats "page-1")
    // = 8, not the full 12. No error is thrown.
    expect(result.tools).toHaveLength(8);
    expect(result.nextCursor).toBeUndefined();

    const reqs = requestsFor("tools/list") as { params?: { cursor?: string } }[];
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.params?.cursor)).toEqual([undefined, "page-1"]);
  });

  it("operations.listAllTools(): the SAME repeated-cursor server also silently truncates (drainPaginatedList's guard never engages)", async () => {
    const { manager } = await connect({ malformedCursor: true });
    const { tools } = await listAllTools(manager, { serverId: "fixture" });
    expect(tools).toHaveLength(8);

    // Both wire requests happened INSIDE the single `fetchPage(undefined)`
    // call `drainPaginatedList` made — the client's own internal walk sent
    // them (cursor: undefined, then cursor: "page-1") and stopped itself on
    // the repeat before returning. `drainPaginatedList` never sees a
    // `nextCursor` to walk, so its own repeated-cursor guard (and its
    // MAX_PAGINATION_PAGES cap) never engage — dead code for this call
    // shape, confirmed here rather than asserted from reading alone.
    const reqs = requestsFor("tools/list") as { params?: { cursor?: string } }[];
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.params?.cursor)).toEqual([undefined, "page-1"]);
  });

  // Symmetric confirmation on prompts/resources/resourceTemplates — same
  // silent-truncation shape, so this is not tools-specific.
  it("manager.listPrompts()/listResources()/listResourceTemplates(): repeated cursor also silently truncates", async () => {
    const { manager } = await connect({ malformedCursor: true });
    const prompts = await manager.listPrompts("fixture");
    const resources = await manager.listResources("fixture");
    const templates = await manager.listResourceTemplates("fixture");
    expect(prompts.prompts).toHaveLength(8);
    expect(resources.resources).toHaveLength(8);
    expect(templates.resourceTemplates).toHaveLength(8);
  });

  // ── table-driven: the FIVE §11.1 outcomes ───────────────────────────────

  it("unsupported capability: listPrompts() returns empty with NO wire request when the server withholds the prompts capability", async () => {
    const { manager } = await connect({ capabilities: { prompts: false } });
    const result = await manager.listPrompts("fixture");
    expect(result.prompts).toEqual([]);
    expect(requestsFor("prompts/list")).toHaveLength(0);
  });

  it("empty result: capability present, server returns zero items (wire request DID happen)", async () => {
    const { manager } = await connect({ emptyLists: true });
    const result = await manager.listTools("fixture");
    expect(result.tools).toEqual([]);
    expect(requestsFor("tools/list")).toHaveLength(1);
  });

  it("protocol error: resources/templates/list throws a real JSON-RPC error, NOT classified as unsupported", async () => {
    const { manager } = await connect({ resourceTemplatesProtocolError: true });
    await expect(manager.listResourceTemplates("fixture")).rejects.toThrow(
      /temporarily unavailable/
    );
    // operations.ts's listAllResourceTemplates must propagate this too — a
    // real protocol error must not be swallowed into `unsupported: true`.
    await expect(
      listAllResourceTemplates(manager, { serverId: "fixture" })
    ).rejects.toThrow(/temporarily unavailable/);
  });

  it("transport error: connecting to a closed port rejects instead of hanging or silently returning empty", async () => {
    // Nothing is listening on this port (close it immediately after grabbing it).
    const probe = await serveMultiPageFixtureOnPort();
    const deadUrl = probe.url;
    await probe.close();

    const localManager = new MCPClientManager();
    await expect(
      localManager.connectToServer("dead", { url: deadUrl, timeout: 2_000 })
    ).rejects.toThrow();
    await localManager.disconnectAllServers().catch(() => {});
  });

  it("tool-execution error: fail-tool returns a spec-legal isError result, not a thrown exception", async () => {
    const { manager } = await connect({ failingTool: true });
    const result = await manager.executeTool("fixture", "fail-tool", {});
    expect(result).toMatchObject({ isError: true });
  });
});
