import { describe, expect, it } from "vitest";
import { harnessToolApprovalRefusalReason } from "../../harness-availability";
import type { HarnessRuntimeAdapter } from "../../registry";
import { CASES, assertFullMatrix } from "./support";

it("covers every registered harness", assertFullMatrix);

/** What the adapter's own flags say about pausing for approval. */
function declaredRefusal(
  adapter: HarnessRuntimeAdapter,
  hasServers: boolean,
  unattended: boolean,
): "unattended" | "native" | "mcp" | undefined {
  if (unattended) return "unattended";
  if (!adapter.supportsNativeToolApproval) return "native";
  const mcp =
    adapter.mcpDelivery === "harness"
      ? adapter.supportsMcpToolApproval
      : adapter.supportsHostExecutedToolApproval;
  return hasServers && !mcp ? "mcp" : undefined;
}

const COPY = {
  unattended: "cannot wait for tool approval in evals or swarms",
  native: "does not support interactive tool approval",
  mcp: "cannot wait for approval of MCP server tools",
} as const;

describe.each(CASES)("$id tool approval", ({ adapter, descriptor }) => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "refuses exactly what its flags declare (servers=%s, unattended=%s)",
    (hasSelectedMcpServers, unattended) => {
      const reason = harnessToolApprovalRefusalReason({
        adapter,
        requireToolApproval: true,
        hasSelectedMcpServers,
        unattended,
      });
      const declared = declaredRefusal(
        adapter,
        hasSelectedMcpServers,
        unattended,
      );
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
        unattended: true,
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
