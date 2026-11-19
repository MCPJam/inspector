/**
 * ActionCard with the real PinnedToolCallFields: its mount effect fills in
 * values, and a saved call must not write back until someone edits it.
 */
import { describe, expect, it, vi } from "vitest";
import type { RemoteServer } from "@/hooks/useProjects";
import { renderWithProviders } from "@/test";
import { ActionCard } from "../case-steps/case-step-body";

const call = {
  id: "t1",
  kind: "toolCall" as const,
  serverId: "server-id",
  serverName: "accounts",
  toolName: "get_me",
  arguments: {},
  renderTimeoutMs: 1000,
};
const projectServers = [
  { _id: "found-id", name: "accounts" },
] as unknown as RemoteServer[];

describe("ActionCard with the real tool call fields", () => {
  it.each<[string, Partial<typeof call>]>([
    ["with its server id", {}],
    ["with no server id", { serverId: undefined }],
    ["with a 0 timeout", { renderTimeoutMs: 0 }],
  ])("does not write a saved call on load: %s", (_name, stored) => {
    const onChange = vi.fn();
    renderWithProviders(
      <ActionCard
        step={{ ...call, ...stored }}
        open={false}
        onToggle={vi.fn()}
        readOnly={false}
        availableTools={[{ name: "get_me", serverId: "found-id" }]}
        suiteServers={["accounts"]}
        projectServers={projectServers}
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
