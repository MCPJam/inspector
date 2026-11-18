import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";
import { EvalTargetMatrix } from "../eval-target-matrix";

vi.mock("@/components/chat-v2/chat-input/client-selector", () => ({
  ClientSelector: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

vi.mock("@/hooks/use-host-harness-targets", () => ({
  useHostHarnessTargets: () => ({}),
}));

describe("EvalTargetMatrix client logo", () => {
  it("draws a renamed client's logo from its saved style", () => {
    render(
      <EvalTargetMatrix
        hostIds={["host-a"]}
        hosts={[
          {
            hostId: "host-a",
            name: "Codex QA",
            hostStyle: "codex",
            harness: null,
          },
        ]}
        modelSelection={undefined}
        availableModels={[]}
        maxTargets={4}
        projectId="proj-1"
        modelsEditable={false}
        renderModels={() => null}
        onHostsChange={() => {}}
        onModelSelectionChange={() => {}}
        onRemoveClient={() => {}}
      />,
    );

    const trigger = screen.getAllByRole("button", { name: /Codex QA/ })[0];
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      getHostLogoSrc("codex"),
    );
  });

  it("hands a paired client's model cell its agent loop as the harness", () => {
    const renderModels = vi.fn(() => null);
    render(
      <EvalTargetMatrix
        hostIds={["host-claude", "host-emulated"]}
        hosts={[
          {
            hostId: "host-claude",
            name: "Claude",
            hostStyle: "claude",
            harness: null,
            agentLoop: "claude-code",
          },
          {
            hostId: "host-emulated",
            name: "MCPJam",
            hostStyle: "mcpjam",
            harness: null,
            agentLoop: null,
          },
        ]}
        modelSelection={undefined}
        availableModels={[]}
        maxTargets={4}
        projectId="proj-1"
        modelsEditable={false}
        renderModels={renderModels}
        onHostsChange={() => {}}
        onModelSelectionChange={() => {}}
        onRemoveClient={() => {}}
      />,
    );

    expect(renderModels).toHaveBeenCalledWith("host-claude", {
      harnessId: "claude-code",
    });
    expect(renderModels).toHaveBeenCalledWith("host-emulated", null);
  });
});
