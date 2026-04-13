import { describe, expect, it } from "vitest";
import {
  SANDBOX_BUILDER_HOST_OVERFLOW_BELOW,
  getSandboxBuilderRenderableNodeIds,
  getSandboxCanvasStaticFitBounds,
} from "../sandbox-canvas-viewport";
import { buildSandboxCanvas } from "../sandboxCanvasBuilder";
import type { SandboxBuilderContext } from "../types";

function minimalContext(
  overrides: Partial<SandboxBuilderContext["draft"]> & {
    workspaceServers?: SandboxBuilderContext["workspaceServers"];
  } = {},
): SandboxBuilderContext {
  const draft = {
    name: "T",
    description: "",
    hostStyle: "claude" as const,
    systemPrompt: "x",
    modelId: "openai/gpt-5-mini",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: false,
    mode: "any_signed_in_with_link" as const,
    selectedServerIds: [] as string[],
    optionalServerIds: [] as string[],
    welcomeDialog: { enabled: true, body: "" },
    feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
    ...overrides,
  };
  return {
    sandbox: null,
    draft,
    workspaceServers: overrides.workspaceServers ?? [],
  };
}

describe("sandbox-canvas-viewport", () => {
  it("getSandboxBuilderRenderableNodeIds returns sandbox nodes only", () => {
    const vm = buildSandboxCanvas(minimalContext());
    expect(getSandboxBuilderRenderableNodeIds(vm.nodes)).toEqual(["host"]);
  });

  it("getSandboxCanvasStaticFitBounds extends height for host overflow", () => {
    const vm = buildSandboxCanvas(minimalContext());
    const b = getSandboxCanvasStaticFitBounds(vm.nodes);
    expect(b).not.toBeNull();
    expect(b!.height).toBe(128 + SANDBOX_BUILDER_HOST_OVERFLOW_BELOW);
    expect(b!.width).toBe(280);
  });
});
