import {
  MCP_APPS_CHECK_IDS,
  MCPAppsConformanceTest,
} from "../../src/apps-conformance/index.js";
import * as operations from "../../src/operations.js";
import {
  CONFORMANCE_UI_RESOURCE_URI,
  startConformanceMockServer,
} from "../mock-servers/conformance-mcp-server.js";

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

  it("fails when resources/read returns more than one HTML payload for a UI resource", async () => {
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

      expect(result.passed).toBe(false);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]).toEqual(
        expect.objectContaining({
          id: "ui-resource-contents-valid",
          status: "failed",
          details: expect.objectContaining({
            violations: [
              `${CONFORMANCE_UI_RESOURCE_URI} must return exactly one content entry from resources/read (got 2)`,
            ],
          }),
        }),
      );
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });

  // apps.mdx, UI Resource Format: the declaration's `mimeType` "SHOULD be
  // `text/html;profile=mcp-app`", while the resources/read content "MUST be"
  // that value. Only the fetched content can fail a check.
  describe("listed UI resource MIME type", () => {
    function serve(options: { listedMimeType?: string; readMimeType: string }) {
      return jest
        .spyOn(operations, "withEphemeralClient")
        .mockImplementation(async (_config, fn) => {
          const mockManager = {
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
                  ...(options.listedMimeType === undefined
                    ? {}
                    : { mimeType: options.listedMimeType }),
                },
              ],
            }),
            readResource: jest.fn().mockResolvedValue({
              contents: [
                {
                  uri: CONFORMANCE_UI_RESOURCE_URI,
                  mimeType: options.readMimeType,
                  text: "<!DOCTYPE html><html><body>App</body></html>",
                },
              ],
            }),
          } as any;

          return fn(mockManager, "__apps_conformance__");
        });
    }

    async function run() {
      const result = await new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 10_000,
        checkIds: ["ui-listed-resources-valid", "ui-resource-contents-valid"],
      }).run();
      return Object.fromEntries(result.checks.map((check) => [check.id, check]));
    }

    for (const listedMimeType of ["text/html", undefined]) {
      it(`passes a listing that declares ${listedMimeType ?? "no mimeType"}, with a warning`, async () => {
        const spy = serve({
          listedMimeType,
          readMimeType: "text/html;profile=mcp-app",
        });
        try {
          const checks = await run();
          expect(checks["ui-listed-resources-valid"]).toMatchObject({
            status: "passed",
            warnings: [
              `Listed UI resource ${CONFORMANCE_UI_RESOURCE_URI} declares mimeType "${listedMimeType ?? "<missing>"}"; the spec recommends "text/html;profile=mcp-app"`,
            ],
          });
          expect(checks["ui-resource-contents-valid"].status).toBe("passed");
        } finally {
          spy.mockRestore();
        }
      });
    }

    it("passes without a warning when the listing declares the recommended type", async () => {
      const spy = serve({
        listedMimeType: "text/html;profile=mcp-app",
        readMimeType: "text/html;profile=mcp-app",
      });
      try {
        const checks = await run();
        expect(checks["ui-listed-resources-valid"].status).toBe("passed");
        expect(checks["ui-listed-resources-valid"].warnings).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it("still fails the fetched content when its MIME type is not the required one", async () => {
      const spy = serve({
        listedMimeType: "text/html;profile=mcp-app",
        readMimeType: "text/html",
      });
      try {
        const checks = await run();
        expect(checks["ui-listed-resources-valid"].status).toBe("passed");
        expect(checks["ui-resource-contents-valid"]).toMatchObject({
          status: "failed",
          details: {
            violations: [
              `${CONFORMANCE_UI_RESOURCE_URI} contents[0] returned mimeType "text/html" instead of "text/html;profile=mcp-app"`,
            ],
          },
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("reports the deprecated flat ui/resourceUri as a deprecation notice, not a warning", async () => {
    // apps.mdx: the flat field "is deprecated" and "will be removed before
    // GA", with no SHOULD or MAY behind it.
    const withEphemeralClientSpy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockImplementation(async (_config, fn) => {
        const mockManager = {
          listTools: jest.fn().mockResolvedValue({
            tools: [
              {
                name: "legacy_tool",
                inputSchema: { type: "object" },
                _meta: { "ui/resourceUri": CONFORMANCE_UI_RESOURCE_URI },
              },
            ],
          }),
          listResources: jest.fn().mockResolvedValue({ resources: [] }),
        } as any;

        return fn(mockManager, "__apps_conformance__");
      });

    try {
      const result = await new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 10_000,
        checkIds: ["ui-tool-metadata-valid"],
      }).run();

      expect(result.checks[0]).toEqual(
        expect.objectContaining({
          id: "ui-tool-metadata-valid",
          status: "passed",
        })
      );
      expect(result.checks[0]?.warnings).toBeUndefined();
      expect(result.readiness).toEqual([
        expect.objectContaining({
          id: "apps-readiness-deprecated-resource-uri",
          checkId: "ui-tool-metadata-valid",
          specStrength: "Deprecation Notice",
          informational: true,
          details: { tools: ["legacy_tool"] },
        }),
      ]);
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });
});
