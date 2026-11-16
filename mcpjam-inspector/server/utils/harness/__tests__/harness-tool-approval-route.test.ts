import { expect, it } from "vitest";
import { getHarnessAdapter } from "../registry";
import { harnessToolApprovalRefusalReason } from "../harness-tool-approval";

it("checks approval support on the MCP client used by this turn", () => {
  const adapter = { ...getHarnessAdapter("cursor"), supportsNativeToolApproval: true,
    supportsMcpToolApproval: true, supportsHostExecutedToolApproval: false };
  const input = { adapter, requireToolApproval: true, hasSelectedMcpServers: true };
  expect(harnessToolApprovalRefusalReason({ ...input, mcpClient: "harness" })).toBeUndefined();
  expect(harnessToolApprovalRefusalReason({ ...input, mcpClient: "mcpjam" })).toMatch(/MCP server tools/);
  expect(harnessToolApprovalRefusalReason({ ...input, unattended: true })).toMatch(/evals or swarms/);
});

it("lets a forwarded Copilot CLI turn wait for approval on either route", () => {
  const input = { adapter: getHarnessAdapter("copilot-cli"), requireToolApproval: true, hasSelectedMcpServers: true };
  expect(harnessToolApprovalRefusalReason({ ...input, mcpClient: "harness" })).toBeUndefined();
  expect(harnessToolApprovalRefusalReason({ ...input, mcpClient: "mcpjam" })).toBeUndefined();
});
