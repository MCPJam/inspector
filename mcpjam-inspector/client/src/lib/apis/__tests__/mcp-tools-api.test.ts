import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetchMock, isHostedModeMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn(),
  isHostedModeMock: vi.fn(() => false),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: authFetchMock,
}));

vi.mock("@/lib/apis/mode-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/apis/mode-client")>();
  return { ...actual, isHostedMode: isHostedModeMock };
});

import {
  attachToolMetadata,
  parseInsufficientScopeChallenge,
  respondToElicitationApi,
} from "../mcp-tools-api";
import type { ListToolsResultWithMetadata } from "../mcp-tools-api";

describe("parseInsufficientScopeChallenge (SEP-2350)", () => {
  it("narrows a well-formed challenge block", () => {
    expect(
      parseInsufficientScopeChallenge({
        requiredScope: "read write",
        resourceMetadataUrl: "https://rs.example/.well-known",
        errorDescription: "more scope",
      }),
    ).toEqual({
      requiredScope: "read write",
      resourceMetadataUrl: "https://rs.example/.well-known",
      errorDescription: "more scope",
    });
  });

  it("keeps only string fields and drops the rest", () => {
    expect(
      parseInsufficientScopeChallenge({
        requiredScope: "read",
        resourceMetadataUrl: 42,
        errorDescription: null,
      }),
    ).toEqual({
      requiredScope: "read",
      resourceMetadataUrl: undefined,
      errorDescription: undefined,
    });
  });

  it("returns undefined when no challenge field is a string", () => {
    expect(parseInsufficientScopeChallenge({ requiredScope: 1 })).toBeUndefined();
    expect(parseInsufficientScopeChallenge(undefined)).toBeUndefined();
    expect(parseInsufficientScopeChallenge("nope")).toBeUndefined();
    expect(parseInsufficientScopeChallenge({})).toBeUndefined();
  });
});

describe("respondToElicitationApi (SEP-2350 step-up on resume)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isHostedModeMock.mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    isHostedModeMock.mockReturnValue(false);
  });

  it("forwards the insufficient_scope challenge when a resume fails with 403", async () => {
    authFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "insufficient scope",
          mcpError: {
            insufficientScope: {
              requiredScope: "read write admin",
              resourceMetadataUrl: "https://rs.example/.well-known",
            },
          },
          normalized: {
            slug: "insufficient-scope",
            title: "Insufficient scope",
            oneLine: "The tool needs more scope.",
            docsAnchor: "#insufficient-scope",
            severity: "error",
            rawMessage: "insufficient scope",
            likelyCauses: [],
            nextSteps: [],
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await respondToElicitationApi("exec-1", "req-1", {
      action: "accept",
      content: {},
    });

    expect("error" in result && result.error).toBe("insufficient scope");
    expect(
      "insufficientScope" in result ? result.insufficientScope : undefined,
    ).toEqual({
      requiredScope: "read write admin",
      resourceMetadataUrl: "https://rs.example/.well-known",
      errorDescription: undefined,
    });
    // The describer block is preserved too, mirroring the /execute path.
    expect(
      "normalized" in result ? result.normalized : undefined,
    ).toMatchObject({ title: "Insufficient scope" });
  });

  it("omits insufficientScope when a resume failure carries no challenge", async () => {
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await respondToElicitationApi("exec-1", "req-1", {
      action: "accept",
      content: {},
    });

    expect("error" in result && result.error).toBe("boom");
    expect("insufficientScope" in result).toBe(false);
  });
});

describe("attachToolMetadata", () => {
  it("copies inspector toolsMetadata onto matching tool _meta", () => {
    const result = attachToolMetadata({
      tools: [
        {
          name: "hidden_from_model",
          description: "App-only tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      toolsMetadata: {
        hidden_from_model: {
          ui: { visibility: ["app"] },
        },
      },
    } as ListToolsResultWithMetadata);

    expect(result.tools[0]._meta).toEqual({
      ui: { visibility: ["app"] },
    });
  });

  it("preserves tool-local _meta while adding inspector metadata", () => {
    const result = attachToolMetadata({
      tools: [
        {
          name: "render_chart",
          description: "Render chart",
          inputSchema: { type: "object", properties: {} },
          _meta: { existing: true },
        },
      ],
      toolsMetadata: {
        render_chart: {
          ui: {
            resourceUri: "ui://chart/widget.html",
            visibility: ["model", "app"],
          },
        },
      },
    } as ListToolsResultWithMetadata);

    expect(result.tools[0]._meta).toEqual({
      existing: true,
      ui: {
        resourceUri: "ui://chart/widget.html",
        visibility: ["model", "app"],
      },
    });
  });

  it("merges nested ui metadata instead of replacing it", () => {
    const result = attachToolMetadata({
      tools: [
        {
          name: "render_chart",
          description: "Render chart",
          inputSchema: { type: "object", properties: {} },
          _meta: {
            ui: { resourceUri: "ui://chart/widget.html" },
          },
        },
      ],
      toolsMetadata: {
        render_chart: {
          ui: { visibility: ["app"] },
        },
      },
    } as ListToolsResultWithMetadata);

    expect(result.tools[0]._meta).toEqual({
      ui: {
        resourceUri: "ui://chart/widget.html",
        visibility: ["app"],
      },
    });
  });
});
