import {
  gradeMCPApps,
  planMCPAppsResourceReads,
  type MCPListedTool,
} from "../../src/apps-conformance/grading.js";
import { MCPAppsConformanceTest } from "../../src/apps-conformance/index.js";
import type { MCPAppsResourceReadOutcome } from "../../src/apps-conformance/types.js";
import type {
  MCPReadResourceResult,
  MCPResource,
} from "../../src/mcp-client-manager/index.js";
import { MCPAuthError } from "../../src/mcp-client-manager/errors.js";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import * as operations from "../../src/operations.js";

const HTML = "text/html;profile=mcp-app";

const tools: MCPListedTool[] = [
  {
    name: "show_chart",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: "ui://chart", visibility: ["model"] } },
  },
  {
    name: "old_widget",
    inputSchema: { type: "object" },
    _meta: { "ui/resourceUri": "ui://legacy" },
  },
  { name: "plain", inputSchema: { type: "object" } },
];

const resources: MCPResource[] = [
  { uri: "ui://chart", name: "chart", mimeType: HTML },
  { uri: "ui://orphan", name: "orphan", mimeType: "text/plain" },
];

const reads: Record<string, MCPReadResourceResult | Error> = {
  "ui://chart": {
    contents: [
      {
        uri: "ui://chart",
        mimeType: HTML,
        text: "<!doctype html><html></html>",
        _meta: { ui: { prefersBorder: "yes" } },
      },
    ],
  },
  "ui://legacy": new Error("not found"),
  "ui://orphan": {
    contents: [{ uri: "ui://orphan", mimeType: HTML, text: "hello" }],
  },
};

function readOutcomes(uris: string[]): MCPAppsResourceReadOutcome[] {
  const plan = planMCPAppsResourceReads(tools, resources);
  return uris.map((uri) => {
    const read = reads[uri];
    return {
      uri,
      referencedByTools: plan.uiTools
        .filter((tool) => tool.resourceUri === uri)
        .map((tool) => tool.name),
      listed: plan.listedUiResourceUris.has(uri),
      ...(read instanceof Error ? { error: read } : { result: read }),
    };
  });
}

const withoutDuration = <T extends { durationMs: number }>(checks: T[]) =>
  checks.map(({ durationMs: _durationMs, ...rest }) => rest);

describe("planMCPAppsResourceReads", () => {
  it("reads every referenced and listed UI resource once", () => {
    const plan = planMCPAppsResourceReads(tools, resources);
    expect(plan.uris).toEqual(["ui://chart", "ui://legacy", "ui://orphan"]);
    expect(plan.uiTools.map((tool) => tool.name)).toEqual([
      "show_chart",
      "old_widget",
    ]);
    expect([...plan.listedUiResourceUris]).toEqual(["ui://chart", "ui://orphan"]);
  });
});

describe("gradeMCPApps", () => {
  it("lists the deprecated-field advice as met when every UI tool uses _meta.ui", () => {
    const modernTools = tools.filter((tool) => tool.name !== "old_widget");
    const grading = gradeMCPApps({
      tools: modernTools,
      resources,
      readOutcomes: [],
      checkIds: ["ui-tool-metadata-valid"],
    });

    expect(grading.readiness).toEqual([]);
    expect(grading.passedAdvice).toEqual([
      {
        id: "apps-readiness-deprecated-resource-uri",
        title: "Deprecated ui/resourceUri Field",
        specStrength: "Deprecation Notice",
      },
    ]);
  });

  it("claims no pass when there are no UI tools to look at", () => {
    const grading = gradeMCPApps({
      tools: [{ name: "plain", inputSchema: { type: "object" } }] as never,
      resources: [],
      readOutcomes: [],
      checkIds: ["ui-tool-metadata-valid"],
    });

    expect(grading.passedAdvice).toEqual([]);
  });

  it("grades lists and reads without a connection", () => {
    const plan = planMCPAppsResourceReads(tools, resources);
    const grading = gradeMCPApps({
      tools,
      resources,
      readOutcomes: readOutcomes(plan.uris),
    });

    expect(
      Object.fromEntries(grading.checks.map((check) => [check.id, check.status]))
    ).toEqual({
      "ui-tools-present": "passed",
      "ui-tool-metadata-valid": "passed",
      "ui-tool-input-schema-valid": "passed",
      "ui-listed-resources-valid": "failed",
      "ui-resources-readable": "failed",
      "ui-resource-contents-valid": "failed",
      "ui-resource-meta-valid": "failed",
    });
    expect(grading.readiness.map((warning) => warning.id)).toEqual([
      "apps-readiness-deprecated-resource-uri",
    ]);
    // A tool still uses the flat field, so the advice is not also a pass.
    expect(grading.passedAdvice).toEqual([]);
    expect(grading.discovery).toEqual({
      toolCount: 3,
      uiToolCount: 2,
      listedResourceCount: 2,
      listedUiResourceCount: 2,
      checkedUiResourceCount: 3,
    });
  });

  it("grades only the selected checks", () => {
    const grading = gradeMCPApps({
      tools,
      resources,
      readOutcomes: [],
      checkIds: ["ui-tool-input-schema-valid"],
    });
    expect(grading.checks.map((check) => check.id)).toEqual([
      "ui-tool-input-schema-valid",
    ]);
  });

  it("skips the tool checks for login when tools/list was refused", () => {
    const grading = gradeMCPApps({
      tools: [],
      toolsError: new MCPAuthError("Unauthorized", 401),
      resources,
      readOutcomes: [],
      checkIds: ["ui-tools-present", "ui-tool-metadata-valid"],
      credentials: { accessToken: "token" },
    });
    expect(
      grading.checks.map((check) => [check.id, check.status, check.skipReason])
    ).toEqual([
      ["ui-tools-present", "skipped", "could-not-run"],
      ["ui-tool-metadata-valid", "skipped", "could-not-run"],
    ]);
  });

  it("returns the checks the runner reports for the same server", async () => {
    const manager = new MCPClientManager();
    jest.spyOn(manager, "listTools").mockResolvedValue({ tools });
    jest.spyOn(manager, "listResources").mockResolvedValue({ resources });
    jest.spyOn(manager, "readResource").mockImplementation(async (_id, { uri }) => {
      const read = reads[uri];
      if (read instanceof Error) throw read;
      return read;
    });
    const spy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockImplementation(async (_config, fn) => fn(manager, "server"));

    try {
      const result = await new MCPAppsConformanceTest({
        url: "https://example.com/mcp",
        timeout: 1_000,
      }).run();
      const plan = planMCPAppsResourceReads(tools, resources);
      const grading = gradeMCPApps({
        tools,
        resources,
        readOutcomes: readOutcomes(plan.uris),
      });

      expect(withoutDuration(result.checks)).toEqual(
        withoutDuration(grading.checks)
      );
      expect(result.readiness).toEqual(grading.readiness);
      expect(result.discovery).toEqual(grading.discovery);
    } finally {
      spy.mockRestore();
    }
  });
});
