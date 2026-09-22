import { beforeEach, describe, expect, it, vi } from "vitest";

const { memberQueryMock, executionQueryMock } = vi.hoisted(() => ({
  memberQueryMock: vi.fn(),
  executionQueryMock: vi.fn(),
}));

vi.mock("../convex-environment-client.js", () => ({
  convexGetEnvironmentRuntimeContext: memberQueryMock,
  convexGetEnvironmentRuntimeContextForExecution: executionQueryMock,
}));

import {
  fetchEnvironmentContext,
  formatEnvironmentContextPrompt,
  maybeAppendEnvironmentContext,
} from "../environment-context.js";

const CONTEXT = {
  imageName: "ML toolkit",
  knowledge: [{ name: "Deploy notes", contents: "Use `make deploy`.\n" }],
  maintenance: [
    { name: "Refresh deps", run: "npm install" },
    { run: "uv sync" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchEnvironmentContext", () => {
  it("uses the member query without a scope and the scoped query with one", async () => {
    memberQueryMock.mockResolvedValue(CONTEXT);
    executionQueryMock.mockResolvedValue(null);

    const member = await fetchEnvironmentContext("tok", "p1");
    expect(member).toEqual({ ok: true, context: CONTEXT });
    expect(memberQueryMock).toHaveBeenCalledWith("tok", "p1");
    expect(executionQueryMock).not.toHaveBeenCalled();

    const scope = { kind: "project", projectId: "p1" } as never;
    const scoped = await fetchEnvironmentContext("tok", "p1", scope);
    expect(scoped).toEqual({ ok: true, context: null });
    expect(executionQueryMock).toHaveBeenCalledWith("tok", scope);
  });

  it("is tri-state: a failed fetch is { ok: false }, never a throw", async () => {
    memberQueryMock.mockRejectedValue(new Error("convex blip"));
    await expect(fetchEnvironmentContext("tok", "p1")).resolves.toEqual({
      ok: false,
    });
  });
});

describe("formatEnvironmentContextPrompt", () => {
  it("renders image name, verbatim knowledge, and never-auto-run maintenance", () => {
    const block = formatEnvironmentContextPrompt(CONTEXT);
    expect(block).toContain("## Computer image: ML toolkit");
    expect(block).toContain("#### Deploy notes");
    expect(block).toContain("Use `make deploy`.");
    expect(block).toContain("NEVER run automatically");
    expect(block).toContain("- Refresh deps: `npm install`");
    expect(block).toContain("- `uv sync`");
  });

  it("omits empty sections", () => {
    const block = formatEnvironmentContextPrompt({
      imageName: "Bare",
      knowledge: [],
      maintenance: [{ run: "true" }],
    });
    expect(block).not.toContain("### Knowledge");
    expect(block).toContain("### Maintenance commands");
  });
});

describe("maybeAppendEnvironmentContext", () => {
  it("does not fetch at all when bash is not advertised", async () => {
    const prompt = await maybeAppendEnvironmentContext({
      systemPrompt: "base prompt",
      hasBashTool: false,
      bearer: "tok",
      projectId: "p1",
    });
    expect(prompt).toBe("base prompt");
    expect(memberQueryMock).not.toHaveBeenCalled();
    expect(executionQueryMock).not.toHaveBeenCalled();
  });

  it("appends the block after the existing prompt", async () => {
    memberQueryMock.mockResolvedValue(CONTEXT);
    const prompt = await maybeAppendEnvironmentContext({
      systemPrompt: "base prompt",
      hasBashTool: true,
      bearer: "tok",
      projectId: "p1",
    });
    expect(prompt).toMatch(/^base prompt\n\n## Computer image: ML toolkit/);
  });

  it("returns the prompt unchanged on null context or fetch failure", async () => {
    memberQueryMock.mockResolvedValue(null);
    await expect(
      maybeAppendEnvironmentContext({
        systemPrompt: "p",
        hasBashTool: true,
        bearer: "tok",
        projectId: "p1",
      }),
    ).resolves.toBe("p");

    memberQueryMock.mockRejectedValue(new Error("down"));
    await expect(
      maybeAppendEnvironmentContext({
        systemPrompt: "p",
        hasBashTool: true,
        bearer: "tok",
        projectId: "p1",
      }),
    ).resolves.toBe("p");
  });

  it("threads the execution scope through to the scoped query", async () => {
    executionQueryMock.mockResolvedValue(CONTEXT);
    const scope = { kind: "project", projectId: "p1" } as never;
    const prompt = await maybeAppendEnvironmentContext({
      systemPrompt: undefined,
      hasBashTool: true,
      bearer: "tok",
      projectId: "p1",
      executionScope: scope,
    });
    expect(executionQueryMock).toHaveBeenCalledWith("tok", scope);
    expect(memberQueryMock).not.toHaveBeenCalled();
    expect(prompt).toMatch(/^## Computer image: ML toolkit/);
  });
});
