/**
 * The resources group's own contract: exact tool set, honest (read-only)
 * annotations, dispatch shape, transcript-cap on the returned content, and
 * command errors passing through (the resource RESOLUTION itself lives in
 * ResourcesTab's handler — see ResourcesTab.agent.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectorCommandResponse } from "@/shared/inspector-command.js";
import { MAX_RESULT_CHARS } from "../shared";

const { dispatchInspectorCommandMock } = vi.hoisted(() => ({
  dispatchInspectorCommandMock: vi.fn(),
}));

vi.mock("../../ui-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui-actions")>();
  return { ...actual, dispatchInspectorCommand: dispatchInspectorCommandMock };
});

import { buildResourcesUiTools } from "../resources";

function getTool(name: string) {
  const tool = buildResourcesUiTools().find((t) => t.name === name);
  if (!tool) throw new Error(`resources group is missing ${name}`);
  return tool;
}

function success(result: unknown): InspectorCommandResponse {
  return { id: "cmd-1", status: "success", result };
}

describe("buildResourcesUiTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInspectorCommandMock.mockResolvedValue(success({ status: "ok" }));
  });

  it("builds exactly the one read tool", () => {
    expect(buildResourcesUiTools().map((t) => t.name)).toEqual([
      "ui_read_resource",
    ]);
  });

  it("annotates the read tool as a side-effect-free open-world GET", () => {
    const tool = getTool("ui_read_resource");
    expect(tool.readOnly).toBe(true);
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("dispatches readResource with the resource (+ optional templateArguments)", async () => {
    await getTool("ui_read_resource").execute({ resource: "file:///a.txt" });
    expect(dispatchInspectorCommandMock).toHaveBeenCalledWith({
      type: "readResource",
      payload: { resource: "file:///a.txt" },
    });

    await getTool("ui_read_resource").execute({
      resource: "greeting",
      templateArguments: { name: "Ada" },
    });
    expect(dispatchInspectorCommandMock).toHaveBeenLastCalledWith({
      type: "readResource",
      payload: { resource: "greeting", templateArguments: { name: "Ada" } },
    });
  });

  it("rejects a missing resource and a non-string-valued templateArguments without dispatching", async () => {
    const tool = getTool("ui_read_resource");
    const missing = await tool.execute({});
    expect(missing.isError).toBe(true);
    const badArgs = await tool.execute({
      resource: "greeting",
      templateArguments: { name: 5 },
    });
    expect(badArgs.isError).toBe(true);
    expect(dispatchInspectorCommandMock).not.toHaveBeenCalled();
  });

  it("caps a huge resource body so the transcript result stays bounded", async () => {
    const huge = "x".repeat(MAX_RESULT_CHARS * 4);
    dispatchInspectorCommandMock.mockResolvedValue(
      success({ status: "resource_read", uri: "file:///big", contents: [{ text: huge }] }),
    );
    const result = await getTool("ui_read_resource").execute({
      resource: "file:///big",
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // clampText caps the whole serialized result at MAX_RESULT_CHARS (+ a short
    // truncation marker), well under the raw body length.
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 32);
    expect(text).toContain("truncated");
  });

  it("surfaces command errors (invalid_request) as tool errors", async () => {
    dispatchInspectorCommandMock.mockResolvedValue({
      id: "cmd-1",
      status: "error",
      error: { code: "invalid_request", message: "No resource matches." },
    } satisfies InspectorCommandResponse);
    const result = await getTool("ui_read_resource").execute({
      resource: "nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid_request");
  });
});
