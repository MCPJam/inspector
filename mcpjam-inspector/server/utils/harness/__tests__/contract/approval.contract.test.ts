import { describe, expect, it } from "vitest";
import { harnessToolApprovalRefusalReason } from "../../harness-availability";
import type { HarnessRuntimeAdapter } from "../../registry";
import { CASES, assertFullMatrix } from "./support";

it("covers every registered harness", assertFullMatrix);

/** What the adapter's own flags say about pausing for approval. Who answers
 *  (the person, or MCPJam's denial) does not change it. */
function declaredRefusal(
  adapter: HarnessRuntimeAdapter,
  hasServers: boolean,
): "native" | "mcp" | undefined {
  if (!adapter.supportsNativeToolApproval) return "native";
  const mcp =
    adapter.mcpDelivery === "harness"
      ? adapter.supportsMcpToolApproval
      : adapter.supportsHostExecutedToolApproval;
  return hasServers && !mcp ? "mcp" : undefined;
}

const COPY = {
  native: "does not support interactive tool approval",
  mcp: "cannot wait for approval of MCP server tools",
} as const;

describe.each(CASES)("$id tool approval", ({ adapter, descriptor }) => {
  it.each([false, true])(
    "refuses exactly what its flags declare (servers=%s)",
    (hasSelectedMcpServers) => {
      const reason = harnessToolApprovalRefusalReason({
        adapter,
        requireToolApproval: true,
        hasSelectedMcpServers,
      });
      const declared = declaredRefusal(adapter, hasSelectedMcpServers);
      if (declared) expect(reason).toContain(COPY[declared]);
      else expect(reason).toBeUndefined();
    },
  );

  it("never refuses a turn that does not ask for approval", () => {
    expect(
      harnessToolApprovalRefusalReason({
        adapter,
        requireToolApproval: false,
        hasSelectedMcpServers: true,
      }),
    ).toBeUndefined();
  });

  it("pauses on reads-allowed mode wherever it can pause at all", () => {
    if (adapter.supportsNativeToolApproval) {
      expect(adapter.approvalPermissionMode).toBe("allow-reads");
    }
    expect(descriptor.controls.requireToolApproval.enforced).toBe(
      adapter.supportsNativeToolApproval,
    );
  });
});
