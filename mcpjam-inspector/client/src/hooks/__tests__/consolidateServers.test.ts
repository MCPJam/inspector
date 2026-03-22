import { describe, it, expect } from "vitest";
import {
  consolidateServers,
  type EnrichedRegistryServer,
} from "../useRegistryServers";

/** Minimal factory for test fixtures */
function makeServer(
  overrides: Partial<EnrichedRegistryServer> & {
    _id: string;
    displayName: string;
  },
): EnrichedRegistryServer {
  return {
    name: `com.test.${overrides.displayName.toLowerCase()}`,
    description: `${overrides.displayName} server`,
    scope: "global" as const,
    transport: {
      transportType: "http" as const,
      url: `https://${overrides.displayName.toLowerCase()}.example.com`,
      useOAuth: true,
    },
    category: "productivity",
    publisher: overrides.displayName,
    status: "approved" as const,
    createdBy: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    connectionStatus: "not_connected",
    clientType: "text",
    ...overrides,
  };
}

describe("consolidateServers", () => {
  it("returns single-type servers unchanged", () => {
    const linear = makeServer({
      _id: "linear-1",
      displayName: "Linear",
      clientType: "text",
    });

    const result = consolidateServers([linear]);

    expect(result).toHaveLength(1);
    expect(result[0].variants[0]).toBe(linear);
    expect(result[0].variants).toHaveLength(1);
    expect(result[0].hasDualType).toBe(false);
  });

  it("groups dual-type servers by displayName", () => {
    const asanaText = makeServer({
      _id: "asana-text",
      displayName: "Asana",
      clientType: "text",
    });
    const asanaApp = makeServer({
      _id: "asana-app",
      displayName: "Asana",
      clientType: "app",
    });

    const result = consolidateServers([asanaText, asanaApp]);

    expect(result).toHaveLength(1);
    expect(result[0].hasDualType).toBe(true);
    expect(result[0].variants).toHaveLength(2);
    expect(result[0].variants).toContain(asanaText);
    expect(result[0].variants).toContain(asanaApp);
  });

  it("preserves all single-type servers alongside consolidated ones", () => {
    const asanaText = makeServer({
      _id: "asana-text",
      displayName: "Asana",
      clientType: "text",
    });
    const asanaApp = makeServer({
      _id: "asana-app",
      displayName: "Asana",
      clientType: "app",
    });
    const linear = makeServer({
      _id: "linear-1",
      displayName: "Linear",
      clientType: "text",
    });
    const notion = makeServer({
      _id: "notion-1",
      displayName: "Notion",
      clientType: "text",
    });

    const result = consolidateServers([asanaText, asanaApp, linear, notion]);

    expect(result).toHaveLength(3);

    const asanaGroup = result.find((c) => c.variants[0].displayName === "Asana");
    expect(asanaGroup?.hasDualType).toBe(true);
    expect(asanaGroup?.variants).toHaveLength(2);

    const linearGroup = result.find((c) => c.variants[0].displayName === "Linear");
    expect(linearGroup?.hasDualType).toBe(false);
    expect(linearGroup?.variants).toHaveLength(1);

    const notionGroup = result.find((c) => c.variants[0].displayName === "Notion");
    expect(notionGroup?.hasDualType).toBe(false);
    expect(notionGroup?.variants).toHaveLength(1);
  });

  it("orders app before text regardless of input order", () => {
    const asanaText = makeServer({
      _id: "asana-text",
      displayName: "Asana",
      clientType: "text",
    });
    const asanaApp = makeServer({
      _id: "asana-app",
      displayName: "Asana",
      clientType: "app",
    });

    const result = consolidateServers([asanaText, asanaApp]);

    expect(result).toHaveLength(1);
    expect(result[0].variants[0].clientType).toBe("app");
    expect(result[0].variants[0]._id).toBe("asana-app");
  });

  it("handles servers with no clientType as single-type", () => {
    const mystery = makeServer({
      _id: "mystery-1",
      displayName: "Mystery",
      clientType: undefined,
    });

    const result = consolidateServers([mystery]);

    expect(result).toHaveLength(1);
    expect(result[0].hasDualType).toBe(false);
    expect(result[0].variants).toHaveLength(1);
  });
});
