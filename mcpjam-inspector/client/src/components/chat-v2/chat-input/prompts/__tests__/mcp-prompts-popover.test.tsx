import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PromptsPopover } from "../mcp-prompts-popover";

const mockListSkills = vi.fn();
const mockListPromptsForServers = vi.fn();

vi.mock("@/lib/apis/mcp-skills-api", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  getSkill: vi.fn(),
}));

vi.mock("@/lib/apis/mcp-prompts-api", () => ({
  listPromptsForServers: (...args: unknown[]) =>
    mockListPromptsForServers(...args),
  getPrompt: vi.fn(),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    MessageSquareCode: Icon,
    ListChecks: Icon,
    Loader2: Icon,
    SquareSlash: Icon,
  };
});

describe("PromptsPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListSkills.mockResolvedValue([]);
    mockListPromptsForServers.mockResolvedValue({ prompts: {} });
  });

  it("does not refetch skills count when onSkillSelected identity changes", async () => {
    const onSkillSelectedA = vi.fn();
    const setActionTrigger = vi.fn();

    const { rerender } = render(
      <PromptsPopover
        anchor={{ x: 0, y: 0 }}
        selectedServers={[]}
        onPromptSelected={vi.fn()}
        onSkillSelected={onSkillSelectedA}
        actionTrigger={null}
        setActionTrigger={setActionTrigger}
        value=""
        caretIndex={0}
      />,
    );

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalledTimes(2);
    });

    rerender(
      <PromptsPopover
        anchor={{ x: 0, y: 0 }}
        selectedServers={[]}
        onPromptSelected={vi.fn()}
        onSkillSelected={vi.fn()}
        actionTrigger={null}
        setActionTrigger={setActionTrigger}
        value="hello"
        caretIndex={5}
      />,
    );

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalledTimes(2);
    });
  });
});
