import {
  MCP_APPS_CHECK_IDS,
  MCPAppsConformanceTest,
} from "../../src/apps-conformance/index.js";
import * as operations from "../../src/operations.js";
import {
  CONFORMANCE_UI_RESOURCE_URI,
  startConformanceMockServer,
} from "../mock-servers/conformance-mcp-server.js";

/**
 * A manager exposing one UI tool and one UI resource, where the caller decides
 * exactly what `resources/read` hands back and how the resource is declared in
 * `resources/list`. Lets a test isolate one Content Requirement at a time.
 */
function uiResourceManager(
  contents: unknown[],
  options: { listedMimeType?: string } = {},
) {
  return {
    listTools: jest.fn().mockResolvedValue({
      tools: [
        {
          name: "ui_tool",
          inputSchema: { type: "object" },
          _meta: { ui: { resourceUri: CONFORMANCE_UI_RESOURCE_URI } },
        },
      ],
    }),
    listResources: jest.fn().mockResolvedValue({
      resources: [
        {
          name: "UI Dashboard",
          uri: CONFORMANCE_UI_RESOURCE_URI,
          mimeType: options.listedMimeType ?? "text/html;profile=mcp-app",
        },
      ],
    }),
    readResource: jest.fn().mockResolvedValue({ contents }),
  };
}

describe("MCPAppsConformanceTest", () => {
  it("passes the full apps conformance suite against the dedicated mock server", async () => {
    const mockServer = await startConformanceMockServer();

    try {
      const test = new MCPAppsConformanceTest({
        url: mockServer.url,
        timeout: 10_000,
      });

      const result = await test.run();

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(MCP_APPS_CHECK_IDS.length);
      expect(result.checks.every((check) => check.status === "passed")).toBe(true);
      expect(result.categorySummary.tools.passed).toBe(3);
      expect(result.categorySummary.resources.passed).toBe(4);
      expect(result.discovery.uiToolCount).toBe(1);
      expect(result.discovery.listedUiResourceCount).toBe(1);
      expect(result.discovery.checkedUiResourceCount).toBe(1);
    } finally {
      await mockServer.stop();
    }
  });

  it("fails when a UI tool references a resource that cannot be read", async () => {
    const mockServer = await startConformanceMockServer({
      omitResources: [CONFORMANCE_UI_RESOURCE_URI],
    });

    try {
      const test = new MCPAppsConformanceTest({
        url: mockServer.url,
        timeout: 10_000,
      });

      const result = await test.run();
      const statuses = Object.fromEntries(
        result.checks.map((check) => [check.id, check.status]),
      );

      expect(result.passed).toBe(false);
      expect(statuses).toEqual({
        "ui-tools-present": "passed",
        "ui-tool-metadata-valid": "passed",
        "ui-tool-input-schema-valid": "passed",
        "ui-listed-resources-valid": "skipped",
        "ui-resources-readable": "failed",
        "ui-resource-contents-valid": "skipped",
        "ui-resource-meta-valid": "skipped",
      });
    } finally {
      await mockServer.stop();
    }
  });

  it("surfaces one failed check when the MCP server connection cannot be established", async () => {
    const withEphemeralClientSpy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockRejectedValue(new Error("connection refused"));

    try {
      const test = new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 10_000,
        checkIds: ["ui-resources-readable", "ui-resource-meta-valid"],
      });

      const result = await test.run();

      expect(result.passed).toBe(false);
      expect(result.checks).toEqual([
        expect.objectContaining({
          id: "ui-resources-readable",
          status: "failed",
          error: expect.objectContaining({
            message: "connection refused",
          }),
        }),
        expect.objectContaining({
          id: "ui-resource-meta-valid",
          status: "skipped",
        }),
      ]);
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });

  it("accepts more than one HTML payload when every entry is a valid UI content", async () => {
    const withEphemeralClientSpy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockImplementation(async (_config, fn) => {
        const mockManager = {
          listTools: jest.fn().mockResolvedValue({
            tools: [
              {
                name: "ui_tool",
                inputSchema: { type: "object" },
                _meta: {
                  ui: {
                    resourceUri: CONFORMANCE_UI_RESOURCE_URI,
                  },
                },
              },
            ],
          }),
          listResources: jest.fn().mockResolvedValue({
            resources: [
              {
                name: "UI Dashboard",
                uri: CONFORMANCE_UI_RESOURCE_URI,
                mimeType: "text/html;profile=mcp-app",
              },
            ],
          }),
          readResource: jest.fn().mockResolvedValue({
            contents: [
              {
                uri: CONFORMANCE_UI_RESOURCE_URI,
                mimeType: "text/html;profile=mcp-app",
                text: "<!DOCTYPE html><html><body>First</body></html>",
              },
              {
                uri: CONFORMANCE_UI_RESOURCE_URI,
                mimeType: "text/html;profile=mcp-app",
                text: "<!DOCTYPE html><html><body>Second</body></html>",
              },
            ],
          }),
        } as any;

        return fn(mockManager, "__apps_conformance__");
      });

    try {
      const test = new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 10_000,
        checkIds: ["ui-resource-contents-valid"],
      });

      const result = await test.run();

      // apps.mdx states its Content Requirements per content item and never
      // caps the array — the single-element `contents: [{…}]` in the spec is
      // an example. Two conforming entries are not a violation.
      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]).toEqual(
        expect.objectContaining({
          id: "ui-resource-contents-valid",
          status: "passed",
        }),
      );
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });

  /**
   * Dropping the exactly-one rule must not become "only the first entry is
   * graded" — every returned entry still has to satisfy the four Content
   * Requirements, and an empty array is still a violation.
   */
  it("still grades every content entry once more than one is allowed", async () => {
    const withEphemeralClientSpy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockImplementation(async (_config, fn) =>
        fn(
          uiResourceManager([
            {
              uri: CONFORMANCE_UI_RESOURCE_URI,
              mimeType: "text/html;profile=mcp-app",
              text: "<!DOCTYPE html><html><body>First</body></html>",
            },
            {
              uri: CONFORMANCE_UI_RESOURCE_URI,
              mimeType: "text/plain",
              text: "<!DOCTYPE html><html><body>Second</body></html>",
            },
          ]) as never,
          "__apps_conformance__",
        ),
      );

    try {
      const result = await new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 10_000,
        checkIds: ["ui-resource-contents-valid"],
      }).run();

      expect(result.passed).toBe(false);
      expect(result.checks[0]?.details?.violations).toEqual([
        `${CONFORMANCE_UI_RESOURCE_URI} contents[1] returned mimeType "text/plain" instead of "text/html;profile=mcp-app"`,
      ]);
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });

  it("fails a resources/read that returns no content entries at all", async () => {
    const withEphemeralClientSpy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockImplementation(async (_config, fn) =>
        fn(uiResourceManager([]) as never, "__apps_conformance__"),
      );

    try {
      const result = await new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 10_000,
        checkIds: ["ui-resource-contents-valid"],
      }).run();

      expect(result.passed).toBe(false);
      expect(result.checks[0]?.details?.violations).toEqual([
        `${CONFORMANCE_UI_RESOURCE_URI} returned no content entries from resources/read`,
      ]);
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });

  /**
   * apps.mdx makes the listing-level mimeType a SHOULD and the read-level one a
   * MUST. A server that gets the listing "wrong" is still conformant, so the
   * check has to warn without failing — otherwise the suite reports a defect
   * the spec does not describe.
   */
  it("warns without failing when a listed UI resource declares another mimeType", async () => {
    const withEphemeralClientSpy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockImplementation(async (_config, fn) =>
        fn(
          uiResourceManager(
            [
              {
                uri: CONFORMANCE_UI_RESOURCE_URI,
                mimeType: "text/html;profile=mcp-app",
                text: "<!DOCTYPE html><html><body>ok</body></html>",
              },
            ],
            { listedMimeType: "text/html" },
          ) as never,
          "__apps_conformance__",
        ),
      );

    try {
      const result = await new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 10_000,
        checkIds: ["ui-listed-resources-valid"],
      }).run();

      expect(result.passed).toBe(true);
      expect(result.checks[0]?.status).toBe("passed");
      expect(result.checks[0]?.warnings?.[0]).toContain("is a SHOULD");
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });
});
