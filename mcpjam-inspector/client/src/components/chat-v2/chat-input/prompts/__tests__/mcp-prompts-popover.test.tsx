import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PromptsPopover } from "../mcp-prompts-popover";

const listPromptsForServersMock = vi.fn();
const listSkillsMock = vi.fn();

vi.mock("@/lib/apis/mcp-prompts-api", () => ({
  listPromptsForServers: (...args: unknown[]) =>
    listPromptsForServersMock(...args),
  getPrompt: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: (...args: unknown[]) => listSkillsMock(...args),
}));

// Skills section pulls in upload/connect components that are noisy in jsdom
// and aren't relevant to this loop test.
vi.mock("../../skills/skills-popover-section", () => ({
  SkillsPopoverSection: () => null,
}));
vi.mock("../../skills/skill-upload-dialog", () => ({
  SkillUploadDialog: () => null,
}));

const baseProps = {
  anchor: { x: 0, y: 0 },
  onPromptSelected: vi.fn(),
  actionTrigger: null,
  setActionTrigger: vi.fn(),
  value: "",
  caretIndex: 0,
};

describe("PromptsPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPromptsForServersMock.mockResolvedValue({ prompts: {} });
    listSkillsMock.mockResolvedValue([]);
  });

  it("does not refetch prompts when the parent re-renders with a new array reference but identical contents", async () => {
    const { rerender } = render(
      <PromptsPopover {...baseProps} selectedServers={["excalidraw"]} />,
    );

    await waitFor(() =>
      expect(listPromptsForServersMock).toHaveBeenCalledTimes(1),
    );

    // Simulate the parent re-rendering with a fresh array of identical content
    // (the original symptom: an unmemoized upstream filter producing a new
    // array each render).
    for (let i = 0; i < 5; i++) {
      rerender(
        <PromptsPopover {...baseProps} selectedServers={["excalidraw"]} />,
      );
    }

    // Give any spurious effects a tick to fire.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(listPromptsForServersMock).toHaveBeenCalledTimes(1);
  });

  it("refetches when the selected server list actually changes", async () => {
    const { rerender } = render(
      <PromptsPopover {...baseProps} selectedServers={["excalidraw"]} />,
    );

    await waitFor(() =>
      expect(listPromptsForServersMock).toHaveBeenCalledTimes(1),
    );

    rerender(
      <PromptsPopover
        {...baseProps}
        selectedServers={["excalidraw", "other"]}
      />,
    );

    await waitFor(() =>
      expect(listPromptsForServersMock).toHaveBeenCalledTimes(2),
    );
  });
});
