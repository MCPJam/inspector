import { describe, expect, it, vi } from "vitest";
import {
  ALL_OPERATIONS,
  OPERATION_FEATURES,
  PlatformApiClient,
  createVariantServerOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const SERVER = {
  id: "server-1",
  name: "mcpjam-mcp-checkout",
  projectId: PROJECT.id,
  transportType: "http",
  url: "https://mcp.example.test/mcp",
};
const EDITS = [
  {
    feature: "tools.description",
    target: "show_servers",
    op: "set",
    value: "Lists every server with its health.",
  },
];
const CREATED = {
  variant: {
    variantId: "variant-1",
    serverId: "server-variant-1",
    baseServerId: "server-1",
    edits: EDITS,
    editsHash: "e".repeat(64),
    baseSurfaceHash: "b".repeat(64),
    toolHashes: [{ tool: "show_servers", hash: "t".repeat(64) }],
    contentHash: "c".repeat(64),
    label: "sweep 8",
    created: true,
  },
  diff: [
    {
      tool: "show_servers",
      field: "description",
      before: "Show.",
      after: EDITS[0].value,
    },
  ],
};

function clientWith() {
  const sent: Array<{ key: string; body: unknown; headers: Headers }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
    sent.push({
      key,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (key.endsWith("/servers")) return Response.json({ items: [SERVER] });
    if (key === "POST /api/v1/projects/project-1/variant-servers") {
      return Response.json(CREATED);
    }
    throw new Error(`unexpected ${key}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
    launcher: { kind: "mcp" },
  });
  return { client, sent };
}

describe("create_variant_server", () => {
  it("resolves the base by name and posts its id with the edits", async () => {
    const { client, sent } = clientWith();

    const result = await createVariantServerOperation.execute(
      { server: "mcpjam-mcp-checkout", edits: EDITS, label: "sweep 8" },
      { client, signal: new AbortController().signal }
    );

    expect(result).toEqual({
      project: expect.objectContaining({ id: "project-1" }),
      server: { id: "server-1", name: "mcpjam-mcp-checkout" },
      ...CREATED,
    });
    const post = sent.at(-1)!;
    expect(post.body).toEqual({
      server: "server-1",
      edits: EDITS,
      label: "sweep 8",
    });
    // The launcher travels as a label, so the variant records how it was made.
    expect(JSON.parse(post.headers.get("x-mcpjam-launcher")!)).toMatchObject({
      kind: "mcp",
    });
  });

  it("takes 1 to 200 edits", () => {
    const parse = (count: number) =>
      createVariantServerOperation.inputSchema.safeParse({
        server: "s",
        edits: Array.from({ length: count }, () => EDITS[0]),
      }).success;
    expect(parse(0)).toBe(false);
    expect(parse(1)).toBe(true);
    expect(parse(200)).toBe(true);
    expect(parse(201)).toBe(false);
  });

  it("is a catalogued write held behind the variant-servers feature", () => {
    expect(ALL_OPERATIONS).toContain(createVariantServerOperation);
    expect(createVariantServerOperation.readOnly).toBe(false);
    expect(createVariantServerOperation.risk).toBe("none");
    expect(OPERATION_FEATURES.create_variant_server).toBe("variant-servers");
  });
});
