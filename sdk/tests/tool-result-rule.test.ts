import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
} from "../src/host-config/internal";
import type { HostConfigInputV2 } from "../src/host-config/internal";
import { resolveModelVisibleMcpToolResults } from "../src/host-config/host-policy.js";
import { projectMcpToolResultForModel } from "../src/mcp-client-manager/tool-converters.js";
import {
  EMPTY_TOOL_RESULT_TEXT,
  projectToolResultByRule,
  structuredContentRuleOf,
  withoutStructuredContentRule,
} from "../src/mcp-client-manager/tool-result-rule.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const distinct = {
  content: [{ type: "text", text: "Visibility probe. Token: VIS-CONTENT" }],
  structuredContent: { token: "VIS-STRUCTURED" },
  _meta: { "prober/model-visibility-token": "VIS-META" },
} as unknown as CallToolResult;

const structuredOnly = {
  content: [],
  structuredContent: { token: "VIS-STRUCTURED" },
  _meta: { "prober/model-visibility-token": "VIS-META" },
} as unknown as CallToolResult;

const textOnly = {
  content: [{ type: "text", text: "plain answer" }],
  _meta: { "prober/model-visibility-token": "VIS-META" },
} as unknown as CallToolResult;

const appToolMeta = { ui: { resourceUri: "ui://probe/view" } };

describe("projectToolResultByRule — what each measured client shows", () => {
  it("'fallback' (Claude Desktop) shows the text only, as plain text", async () => {
    expect(await projectToolResultByRule(distinct, "fallback")).toEqual({
      type: "text",
      value: "Visibility probe. Token: VIS-CONTENT",
    });
  });

  it("'fallback' shows structuredContent as compact JSON when content is empty", async () => {
    expect(await projectToolResultByRule(structuredOnly, "fallback")).toEqual({
      type: "text",
      value: '{"token":"VIS-STRUCTURED"}',
    });
  });

  it("'preferred' (Claude Code, Codex CLI) shows only structuredContent when present", async () => {
    expect(await projectToolResultByRule(distinct, "preferred")).toEqual({
      type: "text",
      value: '{"token":"VIS-STRUCTURED"}',
    });
  });

  it("'preferred' falls back to the text when there is no structuredContent", async () => {
    expect(await projectToolResultByRule(textOnly, "preferred")).toEqual({
      type: "text",
      value: "plain answer",
    });
  });

  it("'both' shows the text, then structuredContent", async () => {
    expect(await projectToolResultByRule(distinct, "both")).toEqual({
      type: "text",
      value: 'Visibility probe. Token: VIS-CONTENT\n{"token":"VIS-STRUCTURED"}',
    });
  });

  it("never shows result or block _meta, under any value", async () => {
    const withBlockMeta = {
      ...distinct,
      content: [
        {
          type: "text",
          text: "Visibility probe. Token: VIS-CONTENT",
          _meta: { secret: "VIS-BLOCK-META" },
        },
      ],
    } as unknown as CallToolResult;
    for (const rule of ["fallback", "preferred", "both"] as const) {
      const output = JSON.stringify(
        await projectToolResultByRule(withBlockMeta, rule)
      );
      expect(output).not.toContain("VIS-META");
      expect(output).not.toContain("VIS-BLOCK-META");
    }
  });

  it("treats null structuredContent as absent and sends other JSON values as JSON", async () => {
    const nullStructured = {
      content: [],
      structuredContent: null,
    } as unknown as CallToolResult;
    expect(await projectToolResultByRule(nullStructured, "fallback")).toEqual({
      type: "text",
      value: EMPTY_TOOL_RESULT_TEXT,
    });
    const stringStructured = {
      content: [],
      structuredContent: "done",
    } as unknown as CallToolResult;
    expect(
      await projectToolResultByRule(stringStructured, "preferred")
    ).toEqual({
      type: "text",
      value: '"done"',
    });
  });

  it("reduces a 2025-03-26 result (no structuredContent) to its content", async () => {
    for (const rule of ["fallback", "preferred", "both"] as const) {
      expect(await projectToolResultByRule(textOnly, rule)).toEqual({
        type: "text",
        value: "plain answer",
      });
    }
  });

  it("keeps an isError result in the success shape, so grading reads the raw result", async () => {
    const failed = {
      content: [{ type: "text", text: "Invalid city" }],
      structuredContent: { error: "Invalid city" },
      isError: true,
    } as unknown as CallToolResult;
    expect(await projectToolResultByRule(failed, "fallback")).toEqual({
      type: "text",
      value: "Invalid city",
    });
  });

  it("keeps images under the existing image flags, with content type output", async () => {
    const imageOnly = {
      content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
      structuredContent: { token: "VIS-STRUCTURED" },
    } as unknown as CallToolResult;
    const output = await projectToolResultByRule(imageOnly, "fallback");
    expect(output.type).toBe("content");
    expect(JSON.stringify(output)).not.toContain("VIS-STRUCTURED");
    const hidden = await projectToolResultByRule(imageOnly, "fallback", {
      modelVisibleMcpToolResults: { directContent: { image: false } },
    });
    expect(hidden).toEqual({
      type: "text",
      value: "[image omitted: direct image policy disabled]",
    });
  });

  it("shows embedded text resources and resource links as compact JSON without _meta", async () => {
    const result = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///a.txt",
            text: "VIS-RESOURCE",
            _meta: { x: 1 },
          },
          _meta: { y: 2 },
        },
        { type: "resource_link", uri: "file:///b.txt", name: "VIS-LINK" },
      ],
    } as unknown as CallToolResult;
    expect(await projectToolResultByRule(result, "fallback")).toEqual({
      type: "text",
      value:
        '{"type":"resource","resource":{"uri":"file:///a.txt","text":"VIS-RESOURCE"}}\n' +
        '{"type":"resource_link","uri":"file:///b.txt","name":"VIS-LINK"}',
    });
  });

  it("keeps the omission marker for a binary embedded resource", async () => {
    const result = {
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///a.pdf",
            blob: "JVBERg==",
            mimeType: "application/pdf",
          },
        },
      ],
    } as unknown as CallToolResult;
    expect(await projectToolResultByRule(result, "fallback")).toEqual({
      type: "text",
      value: "[embedded resource omitted]",
    });
  });

  it("sends one copy of duplicated data: a 171 KiB duplicate fixture stays near 171 KiB", async () => {
    const data = {
      rows: Array.from({ length: 2600 }, (_, i) => ({
        id: i,
        name: `row-${i}-${"x".repeat(40)}`,
      })),
    };
    const json = JSON.stringify(data);
    const duplicate = {
      content: [{ type: "text", text: json }],
      structuredContent: data,
    } as unknown as CallToolResult;
    expect(json.length).toBeGreaterThan(170 * 1024);
    const output = await projectToolResultByRule(duplicate, "fallback");
    expect(output.type).toBe("text");
    const sent = (output as { value: string }).value.length;
    expect(sent).toBe(json.length);
    // Today's projection sends both copies, escaped inside one JSON blob.
    expect(JSON.stringify(duplicate).length).toBeGreaterThan(2 * json.length);
  });

  it("sends a marker instead of an empty tool result", async () => {
    expect(
      await projectToolResultByRule(
        { content: [] } as unknown as CallToolResult,
        "both"
      )
    ).toEqual({ type: "text", value: EMPTY_TOOL_RESULT_TEXT });
  });
});

describe("projectMcpToolResultForModel — the rule replaces the App scrub when set", () => {
  it("shows an App tool's structuredContent when content is empty, as Claude Desktop does", async () => {
    const policy = { structuredContent: "fallback" as const };
    expect(
      await projectMcpToolResultForModel(structuredOnly, appToolMeta, {
        modelVisibleMcpToolResults: policy,
      })
    ).toEqual({ type: "text", value: '{"token":"VIS-STRUCTURED"}' });
  });

  it("keeps today's projection when the host sets no rule", async () => {
    expect(await projectMcpToolResultForModel(distinct, undefined, {})).toEqual(
      {
        type: "json",
        value: distinct,
      }
    );
    expect(
      await projectMcpToolResultForModel(structuredOnly, appToolMeta, {})
    ).toEqual({ type: "json", value: { content: [] } });
  });
});

describe("structuredContentRuleOf and withoutStructuredContentRule", () => {
  it("reads only the three values", () => {
    expect(structuredContentRuleOf({ structuredContent: "both" })).toBe("both");
    expect(structuredContentRuleOf(undefined)).toBeUndefined();
    expect(
      structuredContentRuleOf({ structuredContent: "other" } as never)
    ).toBeUndefined();
  });

  it("removes the rule for harness runs and keeps undefined as undefined", () => {
    const images = { directContent: { image: false } };
    expect(withoutStructuredContentRule(undefined)).toBeUndefined();
    expect(withoutStructuredContentRule(images)).toBe(images);
    expect(
      withoutStructuredContentRule({
        ...images,
        structuredContent: "preferred",
      })
    ).toEqual(images);
    expect(
      withoutStructuredContentRule({ structuredContent: "fallback" })
    ).toBeUndefined();
  });
});

function base(overrides: Partial<HostConfigInputV2> = {}): HostConfigInputV2 {
  return {
    hostStyle: "claude-desktop",
    modelId: "anthropic/claude-haiku-5.5",
    systemPrompt: "",
    temperature: 1,
    requireToolApproval: false,
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  };
}

describe("canonicalizeHostConfigV2 — modelVisibleMcpToolResults.structuredContent", () => {
  it("accepts each value and emits it after the image leaves", () => {
    for (const rule of ["fallback", "preferred", "both"] as const) {
      const canonical = canonicalizeHostConfigV2(
        base({
          modelVisibleMcpToolResults: {
            structuredContent: rule,
            directContent: { image: true },
          },
        })
      ) as { modelVisibleMcpToolResults?: Record<string, unknown> };
      expect(Object.keys(canonical.modelVisibleMcpToolResults ?? {})).toEqual([
        "directContent",
        "structuredContent",
      ]);
      expect(canonical.modelVisibleMcpToolResults?.structuredContent).toBe(
        rule
      );
    }
  });

  it("rejects any other value, naming the field and the allowed values", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          modelVisibleMcpToolResults: { structuredContent: "text" as never },
        })
      )
    ).toThrow(
      'hostConfigV2: modelVisibleMcpToolResults.structuredContent must be "fallback", "preferred" or "both"'
    );
  });

  it("leaves the hash of a config without the field unchanged, and moves it when set", async () => {
    const images = base({
      modelVisibleMcpToolResults: { directContent: { image: true } },
    });
    const canonical = JSON.stringify(canonicalizeHostConfigV2(images));
    expect(canonical).not.toContain("structuredContent");
    expect(await computeHostConfigHashV2(images)).not.toBe(
      await computeHostConfigHashV2(
        base({
          modelVisibleMcpToolResults: {
            directContent: { image: true },
            structuredContent: "fallback",
          },
        })
      )
    );
  });
});

describe("resolveModelVisibleMcpToolResults — the rule", () => {
  it("carries the rule only when set", () => {
    expect(
      "structuredContent" in resolveModelVisibleMcpToolResults(undefined)
    ).toBe(false);
    expect(
      "structuredContent" in
        resolveModelVisibleMcpToolResults({ directContent: { image: false } })
    ).toBe(false);
    expect(
      resolveModelVisibleMcpToolResults({ structuredContent: "preferred" })
        .structuredContent
    ).toBe("preferred");
  });
});
